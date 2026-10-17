// SEND: Cloudflare first; Resend only when Cloudflare clearly refused; never twice; unknown is never retried on the
// other path; only Best Life's certificate or a binding may ask; logs carry no subject, body or key.
//
//   bun test/send.ts
import worker, { type Env } from "../src/index";

let failed = 0;
const is = (what: string, ok: boolean, saw = ""): void => {
	process.stdout.write((ok ? "ok    " : "FAIL  ") + what + (ok ? "" : "\n      " + saw) + "\n");
	if (!ok) failed += 1;
};

let cfMode: "ok" | "refuse" | "unknown" = "ok";
const cfSent: unknown[] = [];
const EMAIL = {
	send: async (m: unknown) => {
		if (cfMode === "refuse") throw Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" });
		if (cfMode === "unknown") throw new Error("internal error");
		cfSent.push(m);
		return { messageId: "cf-1" };
	},
};
const resendCalls: { auth: string; idem: string; body: string }[] = [];
let resendStatus = 200;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
	const h = new Headers(init?.headers);
	resendCalls.push({ auth: h.get("authorization") ?? "", idem: h.get("idempotency-key") ?? "", body: String(init?.body ?? "") });
	return resendStatus === 200 ? Response.json({ id: "rs-1" }) : Response.json({ name: "validation_error" }, { status: resendStatus });
}) as typeof fetch;
const ACCESS = { fetch: async () => Response.json({ name: "RESEND_API_KEY", value: "re_secret_key" }) };
const kv = new Map<string, string>();
const SENT = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); }, list: async () => ({ keys: [], list_complete: true }) };
const env: Env = { EMAIL, ACCESS, SENT, BESTLIFE_CALLER_CN: "bestlife-holders" };

const cert = (cn: string) => ({ tlsClientAuth: { certPresented: "1", certVerified: "SUCCESS", certSubjectDN: `CN=${cn}` } });
const ask = (b: unknown, cf: unknown = cert("bestlife-holders")) => {
	const req = new Request("https://send.example.com/send", { method: "POST", body: JSON.stringify(b) }) as Request & { cf?: unknown };
	if (cf !== undefined) Object.defineProperty(req, "cf", { value: cf });
	return worker.fetch(req, env);
};
const msg = (id: string) => ({ messageId: id, from: "me@example.com", to: "you@elsewhere.org", subject: "private subject", text: "private body" });

const lines: string[] = [];
const was = { log: console.log, warn: console.warn };
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };

// WHO MAY ASK
const r0 = await ask(msg("msg-00000001"), cert("someone-else"));
is("someone else's certificate is refused", r0.status === 403);
is("the internet without a certificate is refused", (await ask(msg("msg-00000001"), {})).status === 403);

// CLOUDFLARE FIRST
const r1 = (await (await ask(msg("msg-00000001"))).json()) as { via?: string };
is("Cloudflare sends it", r1.via === "cloudflare" && cfSent.length === 1 && resendCalls.length === 0, JSON.stringify(r1));
const r2 = (await (await ask(msg("msg-00000001"))).json()) as { already?: boolean };
is("asked again, it is not sent again", r2.already === true && cfSent.length === 1);

// RESEND ONLY WHEN CLOUDFLARE CLEARLY REFUSED
cfMode = "refuse";
const r3 = (await (await ask(msg("msg-00000002"))).json()) as { via?: string };
is("a clear refusal falls back to Resend", r3.via === "resend" && resendCalls.length === 1, JSON.stringify(r3));
is("Resend is asked on the holder's key, with the messageId as Idempotency-Key", resendCalls[0]!.auth === "Bearer re_secret_key" && resendCalls[0]!.idem === "msg-00000002");
is("asked again after Resend sent, nothing is sent", (await (await ask(msg("msg-00000002"))).json() as { already?: boolean }).already === true && resendCalls.length === 1);

// UNKNOWN IS NEVER RETRIED ELSEWHERE
cfMode = "unknown";
const r4 = await ask(msg("msg-00000003"));
is("an unknown outcome is 409, and Resend is not asked", r4.status === 409 && resendCalls.length === 1);
const r5 = await ask(msg("msg-00000003"));
is("asked again, it still says check before resending", r5.status === 409 && resendCalls.length === 1 && cfSent.length === 1);

// BOTH REFUSED: MAY BE ASKED AGAIN
cfMode = "refuse";
resendStatus = 422;
const r6 = await ask(msg("msg-00000004"));
is("both refusing is 502", r6.status === 502);
resendStatus = 200;
cfMode = "ok";
const r7 = (await (await ask(msg("msg-00000004"))).json()) as { sent?: boolean };
is("a message both refused may be asked again", r7.sent === true);

// INPUT
is("a message without an id is refused", (await ask({ ...msg("x"), messageId: "" })).status === 400);
is("a subject with a line break is refused", (await ask({ ...msg("msg-00000005"), subject: "a\r\nBcc: x@y.z" })).status === 400);

console.log = was.log;
console.warn = was.warn;
is("the logs never carry the subject, the body or the key", lines.length > 0 && lines.every((l) => !l.includes("private") && !l.includes("re_secret_key")), lines.join("\n"));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
