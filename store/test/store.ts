// THE STORE: a binding or a request Best Life signed may ask, no one else; paths stay in the tree; an item
// already kept stays as it is; envelopes go to the db and are cached; nothing deletes.
//
//   bun test/store.ts
import worker, { type Env } from "../src/index";
import { OTHER_KEY, TEST_CN, TEST_KEY, signed, testNonces } from "./signer";

let failed = 0;
const is = (what: string, ok: boolean, saw = ""): void => {
	process.stdout.write((ok ? "ok    " : "FAIL  ") + what + (ok ? "" : "\n      " + saw) + "\n");
	if (!ok) failed += 1;
};

const objects = new Map<string, { bytes: ArrayBuffer; type?: string; at: Date }>();
const STORAGE = {
	head: async (k: string) => { const o = objects.get(k); return o ? { key: k, size: o.bytes.byteLength, uploaded: o.at } : null; },
	get: async (k: string) => { const o = objects.get(k); return o ? { key: k, size: o.bytes.byteLength, uploaded: o.at, httpMetadata: { contentType: o.type }, arrayBuffer: async () => o.bytes } : null; },
	put: async (k: string, v: ArrayBuffer, opt?: { httpMetadata?: { contentType?: string } }) => { objects.set(k, { bytes: v, type: opt?.httpMetadata?.contentType, at: new Date() }); return { key: k, size: v.byteLength, uploaded: new Date() }; },
	list: async (o?: { prefix?: string }) => ({ objects: [...objects.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).map(([key, v]) => ({ key, size: v.bytes.byteLength, uploaded: v.at })), truncated: false }),
};
const rows = new Map<string, { path: string; envelope: string; at: string }>();
const DB = {
	exec: async () => ({}),
	prepare: (sql: string) => {
		let vals: unknown[] = [];
		const st = {
			bind: (...v: unknown[]) => { vals = v; return st; },
			run: async () => { if (sql.startsWith("INSERT")) rows.set(String(vals[0]), { path: String(vals[0]), envelope: String(vals[4]), at: String(vals[5]) }); return {}; },
			first: async <T>() => (rows.get(String(vals[0])) ?? null) as T | null,
			all: async <T>() => ({ results: [...rows.values()].filter((r) => r.path.startsWith(String(vals[0]).replace(/%$/, ""))) as T[] }),
		};
		return st;
	},
};
const cache = new Map<string, string>();
const CACHE = {
	get: async (k: string) => cache.get(k) ?? null,
	put: async (k: string, v: string) => { cache.set(k, v); },
	delete: async (k: string) => { cache.delete(k); },
	list: async () => ({ keys: [], list_complete: true }),
};
const env: Env = { STORAGE, DB, CACHE, BESTLIFE_CALLER_CN: TEST_CN, BESTLIFE_CALLER_KEY: TEST_KEY, NONCES: testNonces() };

const ask = (path: string, init: RequestInit = {}, cf?: unknown) => {
	const req = new Request(`https://store.example.com${path}`, init) as Request & { cf?: unknown };
	if (cf !== undefined) Object.defineProperty(req, "cf", { value: cf });
	return worker.fetch(req, env);
};
const asBestLife = async (path: string, init: RequestInit = {}, o: Parameters<typeof signed>[2] = {}) => worker.fetch(await signed(`https://store.example.com${path}`, init, o), env);
const P = "inbox/email/someone@example.com/0123456789abcdef0123456789abcdef.eml";

// WHO MAY ASK
is("the internet unsigned is refused", (await ask("/healthz", {}, {})).status === 403);
is("a signature by another key is refused", (await asBestLife("/healthz", {}, { key: OTHER_KEY })).status === 403);
is("another caller name is refused", (await asBestLife("/healthz", {}, { cn: "someone-else" })).status === 403);
is("a signature ten minutes old is refused", (await asBestLife("/healthz", {}, { time: Math.floor(Date.now() / 1000) - 600 })).status === 403);
is("a body changed after signing is refused", (await asBestLife(`/item?path=${encodeURIComponent("inbox/email/a@b.c/00000000000000000000000000000000.eml")}`, { method: "PUT", body: "original" }, { tamper: true })).status === 403);
is("a token is never accepted", (await asBestLife("/healthz", { headers: { authorization: "Bearer x" } })).status === 403);
is("Best Life's signed request is let in", (await asBestLife("/healthz")).status === 200);
const once = await signed("https://store.example.com/healthz");
const again = once.clone() as Request & { cf?: unknown };
Object.defineProperty(again, "cf", { value: {} });
is("the same signed request is let in once", (await worker.fetch(once, env)).status === 200);
const replay = await worker.fetch(again, env);
is("   and refused the second time", replay.status === 403 && ((await replay.json()) as { error: string }).error === "this signed request was already used");
is("without NONCES bound, Best Life is refused", (await worker.fetch(await signed("https://store.example.com/healthz"), { ...env, NONCES: undefined })).status === 403);
is("with no caller name set, Best Life is refused", (await worker.fetch(await signed("https://store.example.com/healthz"), { ...env, BESTLIFE_CALLER_CN: "" })).status === 403);
is("a sibling over a binding is let in", (await ask("/healthz")).status === 200);

// THE TREE
is("a path outside the tree is refused", (await ask(`/item?path=${encodeURIComponent("secrets/x.txt")}`, { method: "PUT", body: "x" })).status === 400);
is("a path climbing out is refused", (await ask(`/item?path=${encodeURIComponent("inbox/email/../../x.eml")}`, { method: "PUT", body: "x" })).status === 400);
is("a folder that is not one is refused", (await ask(`/list?prefix=${encodeURIComponent("archive/")}`)).status === 400);

// ITEMS
const put1 = await ask(`/item?path=${encodeURIComponent(P)}`, { method: "PUT", body: "Subject: hi\r\n\r\nbody", headers: { "content-type": "message/rfc822" } });
is("an item is kept", put1.status === 201);
const put2 = (await (await ask(`/item?path=${encodeURIComponent(P)}`, { method: "PUT", body: "something else" })).json()) as { existed?: boolean };
is("an item already kept stays as it is", put2.existed === true && new TextDecoder().decode(objects.get(P)!.bytes) === "Subject: hi\r\n\r\nbody");
const got = await asBestLife(`/item?path=${encodeURIComponent(P)}`);
is("Best Life reads the item back", got.status === 200 && (await got.text()).includes("body"));
const list = (await (await ask(`/list?prefix=${encodeURIComponent("inbox/email/")}`)).json()) as { items: { path: string }[] };
is("the item is listed under its folder", list.items.some((i) => i.path === P), JSON.stringify(list));

// ENVELOPES
is("an envelope is written", (await ask(`/index?path=${encodeURIComponent(P)}`, { method: "PUT", body: JSON.stringify({ from: "a@b.c", subject: "hi" }) })).status === 200);
const e1 = await ask(`/index?path=${encodeURIComponent(P)}`);
is("the first read comes from the db", e1.headers.get("x-cache") === "miss" && (await e1.text()).includes("a@b.c"));
const e2 = await ask(`/index?path=${encodeURIComponent(P)}`);
is("the next read comes from the cache", e2.headers.get("x-cache") === "hit");
await ask(`/index?path=${encodeURIComponent(P)}`, { method: "PUT", body: JSON.stringify({ from: "a@b.c", subject: "changed" }) });
is("writing the envelope again drops the cached one", !cache.has(`env:${P}`));
const envs = (await (await ask(`/envelopes?prefix=${encodeURIComponent("inbox/email/someone@example.com")}`)).json()) as { envelopes: { subject?: string }[] };
is("the newest envelopes are listed", envs.envelopes.length === 1 && envs.envelopes[0]!.subject === "changed", JSON.stringify(envs));

// NOTHING DELETES
is("nothing deletes an item", (await ask(`/item?path=${encodeURIComponent(P)}`, { method: "DELETE" })).status === 404 && objects.has(P));

// LOGS NEVER CARRY EVIDENCE
const lines: string[] = [];
const was = console.log;
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
const Q = "inbox/email/someone@example.com/fedcba9876543210fedcba9876543210.eml";
await ask(`/item?path=${encodeURIComponent(Q)}`, { method: "PUT", body: "Subject: private words\r\n\r\nprivate body" });
await ask(`/index?path=${encodeURIComponent(Q)}`, { method: "PUT", body: JSON.stringify({ subject: "private words" }) });
console.log = was;
is("the logs never carry a subject or a body", lines.length > 0 && lines.every((l) => !l.includes("private")), lines.join("\n"));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
