// THE ACCESS WORKER: only a binding may ask; keys seal and open with the holder's own key; a value never shows in
// /names; a sealed value will not open under another name or another key.
//
//   bun test/access.ts
import worker, { type Env } from "../src/index";
import { signed } from "./signer";

let failed = 0;
const is = (what: string, ok: boolean, saw = ""): void => {
	process.stdout.write((ok ? "ok    " : "FAIL  ") + what + (ok ? "" : "\n      " + saw) + "\n");
	if (!ok) failed += 1;
};

const kv = () => {
	const m = new Map<string, string>();
	return {
		m,
		get: async (k: string) => m.get(k) ?? null,
		put: async (k: string, v: string) => { m.set(k, v); },
		delete: async (k: string) => { m.delete(k); },
		list: async (o?: { prefix?: string }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((name) => ({ name })), list_complete: true }),
	};
};
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const store = kv();
const env: Env = { ENCRYPTION_KEY: KEY, KEYS: store, KEY_IMAP_PASSWORD: "imap-secret-value" };

const ask = (path: string, init: RequestInit = {}, cf?: unknown, e: Env = env) => {
	const req = new Request(`https://access${path}`, init) as Request & { cf?: unknown };
	if (cf !== undefined) Object.defineProperty(req, "cf", { value: cf });
	return worker.fetch(req, e);
};
const post = (path: string, b: unknown, e: Env = env) => ask(path, { method: "POST", body: JSON.stringify(b) }, undefined, e);

// WHO MAY ASK
is("a request from the internet is refused, even one Best Life signed", (await worker.fetch(await signed("https://access/open", { method: "POST", body: '{"name":"IMAP_PASSWORD"}' }), env)).status === 403);
is("a request from the internet is refused without one", (await ask("/names", {}, {})).status === 403);

// HEALTH
const h = (await (await ask("/healthz")).json()) as { ok: boolean };
is("healthz is ok with a 32-byte key", h.ok === true);
const bad = (await (await ask("/healthz", {}, undefined, { ...env, ENCRYPTION_KEY: btoa("short") })).json()) as { ok: boolean; why?: string };
is("healthz says why a short key will not do", bad.ok === false && /32 bytes/.test(bad.why ?? ""), JSON.stringify(bad));

// SECRETS SET AT DEPLOY
const o1 = (await (await post("/open", { name: "IMAP_PASSWORD" })).json()) as { value?: string };
is("a KEY_ secret set at deploy opens", o1.value === "imap-secret-value");

// SEAL AND OPEN
const s = await post("/seal", { name: "RESEND_API_KEY", value: "re_123" });
is("a key seals", s.status === 200);
const held = store.m.get("key:RESEND_API_KEY") ?? "";
is("what is kept is sealed, not the value", held.startsWith("v1.") && !held.includes("re_123"), held);
const o2 = (await (await post("/open", { name: "RESEND_API_KEY" })).json()) as { value?: string };
is("the sealed key opens", o2.value === "re_123");

store.m.set("key:AI_API_KEY", held);
is("a sealed value moved under another name will not open", (await post("/open", { name: "AI_API_KEY" })).status === 500);
const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
is("it will not open with another encryption key", (await post("/open", { name: "RESEND_API_KEY" }, { ...env, ENCRYPTION_KEY: other })).status === 500);

// NAMES, NEVER VALUES
const names = await (await ask("/names")).text();
is("names lists secrets and sealed keys", names.includes("IMAP_PASSWORD") && names.includes("RESEND_API_KEY"), names);
is("names never shows a value", !names.includes("imap-secret-value") && !names.includes("re_123"));

// INPUT
is("a name that is not one is refused", (await post("/open", { name: "../x" })).status === 400);
is("an unknown key is 404", (await post("/open", { name: "NOPE" })).status === 404);
is("an empty value is refused", (await post("/seal", { name: "X", value: "" })).status === 400);

// LOGS NEVER CARRY A VALUE
const lines: string[] = [];
const was = console.log;
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
await post("/seal", { name: "LOGGED", value: "do-not-log-me" });
await post("/open", { name: "LOGGED" });
console.log = was;
is("the logs never carry a value", lines.length > 0 && lines.every((l) => !l.includes("do-not-log-me")), lines.join("\n"));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
