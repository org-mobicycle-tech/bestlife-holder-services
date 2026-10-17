// INGEST-PUSH: a message is filed in the holder's store under the address it was sent to; Best Life is told it
// arrived with metadata only; nothing is forwarded; a store failure rejects the message; logs carry no evidence.
//
//   bun test/push.ts
import worker, { type Env, type IncomingEmail } from "../src/index";
import { envelopeOf } from "../src/file";

let failed = 0;
const is = (what: string, ok: boolean, saw = ""): void => {
	process.stdout.write((ok ? "ok    " : "FAIL  ") + what + (ok ? "" : "\n      " + saw) + "\n");
	if (!ok) failed += 1;
};

const RAW = "From: Sender <sender@elsewhere.org>\r\nTo: someone@example.com\r\nSubject: private subject\r\n\tfolded\r\nMessage-ID: <m1@elsewhere.org>\r\n\r\nprivate body words\r\n";
const asked: { url: string; method: string; body: string }[] = [];
let storeUp = true;
const STORE = {
	fetch: async (r: Request) => {
		asked.push({ url: r.url, method: r.method, body: await r.text() });
		return storeUp ? Response.json({ ok: true }, { status: 201 }) : Response.json({ error: "down" }, { status: 503 });
	},
};
const told: { url: string; headers: Headers; body: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const r = input as Request;
	told.push({ url: r.url, headers: r.headers, body: await r.text() });
	return Response.json({ ok: true });
}) as typeof fetch;

// A connection key as Best Life's Settings makes one: blck1.<base64url {u, k, d, url}>.
const b64url = (b: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const d = b64url((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
const CONNECTION_KEY = "blck1." + b64url(new TextEncoder().encode(JSON.stringify({ u: "holder-123", k: "3f9c0a1b2c4d", d, url: "https://door.bestlife.example" })));
const env: Env = { STORE, CONNECTION_KEY };
let rejected = "";
const mail = (): IncomingEmail => ({
	from: "sender@elsewhere.org",
	to: "Someone@Example.com",
	raw: new Response(RAW).body!,
	rawSize: RAW.length,
	setReject: (r: string) => { rejected = r; },
});

const lines: string[] = [];
const was = { log: console.log, warn: console.warn };
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
await worker.email(mail(), env);
storeUp = false;
let threw = false;
try { await worker.email(mail(), env); } catch { threw = true; }
console.log = was.log;
console.warn = was.warn;

const item = asked.find((a) => a.url.includes("/item?"));
const path = decodeURIComponent(new URL(item?.url ?? "https://x/?path=").searchParams.get("path") ?? "");
is("the message is filed under the address it was sent to", /^inbox\/email\/someone@example\.com\/[0-9a-f]{32}\.eml$/.test(path), path);
is("it is filed as it came", item?.body === RAW && item?.method === "PUT");
const idx = asked.find((a) => a.url.includes("/index?"));
is("its envelope goes to the index", !!idx && JSON.parse(idx.body).subject === "private subject folded", idx?.body);

is("Best Life is told once, at its door", told.length === 1 && told[0]!.url.startsWith("https://door.bestlife.example/int-cloud-to-cloud-push/held?"), JSON.stringify(told.map((t) => t.url)));
const notice = JSON.parse(told[0]?.body ?? "{}") as Record<string, unknown>;
is("the notice is metadata only", JSON.stringify(Object.keys(notice).sort()) === JSON.stringify(["address", "at", "evidence", "id", "size"]), JSON.stringify(notice));
is("the notice carries no evidence", !told[0]!.body.includes("private") && !told[0]!.url.includes("private"));
is("no token is sent", !told[0]!.headers.get("authorization"));
const h = told[0]!.headers;
const u = new URL(told[0]!.url);
const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(told[0]!.body))), (x) => x.toString(16).padStart(2, "0")).join("");
const text = `bl1\n${h.get("x-bl-time")}\n${h.get("x-bl-user")}\n${h.get("x-bl-key")}\n${u.pathname}${u.search}\n${sha}`;
const sig = Uint8Array.from(atob((h.get("x-bl-signature") ?? "").replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - ((h.get("x-bl-signature") ?? "").length % 4)) % 4)), (c) => c.charCodeAt(0));
is("the notice is signed with the connection key, as Best Life's door checks it", await crypto.subtle.verify({ name: "Ed25519" }, pair.publicKey, sig, new TextEncoder().encode(text)) && h.get("x-bl-user") === "holder-123" && h.get("x-bl-key") === "3f9c0a1b2c4d");
is("nothing is forwarded: the only outside call is the notice", told.every((t) => t.url.startsWith("https://door.bestlife.example/")));

is("a store failure rejects the message and throws", threw && rejected !== "");
is("the logs never carry the subject or the body", lines.length > 0 && lines.every((l) => !l.includes("private")), lines.join("\n"));

// THE ENVELOPE
const e = envelopeOf(new TextEncoder().encode(RAW).buffer as ArrayBuffer, { from: "f", to: "t" });
is("the envelope reads From, To, Subject and Message-ID", e.from.includes("sender@elsewhere.org") && e.to === "someone@example.com" && e.messageId === "<m1@elsewhere.org>", JSON.stringify(e));

// NO WAY IN BUT EMAIL ROUTING
const req = new Request("https://x/healthz") as Request & { cf?: unknown };
Object.defineProperty(req, "cf", { value: {} });
is("a request from the internet is refused", (await worker.fetch(req)).status === 403);
is("a sibling may ask healthz", (await worker.fetch(new Request("https://x/healthz"))).status === 200);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
