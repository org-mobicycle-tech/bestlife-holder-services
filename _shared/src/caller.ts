// caller.ts -- WHO MAY ASK THIS WORKER. Two callers only:
//
//   a sibling worker in the holder's own account, over a service binding: the request carries no `cf`.
//   Best Life, over the internet, with every request SIGNED by Best Life's caller key.
//
// WHY A SIGNATURE AND NOT A CLIENT CERTIFICATE. Best Life's workers run on Cloudflare, and so does this one. A
// Worker's mTLS binding does not present its certificate to a host Cloudflare proxies ("mTLS for Workers cannot be
// used for requests made to a service that is a proxied zone on Cloudflare",
// https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/), so this worker would never see one.
// Instead Best Life signs each request with the private half of its caller key (ECDSA P-256), which never leaves
// Best Life's key holder; this worker checks it against the public half below. Nothing to set up, no certificate
// authority, any plan, and it works on workers.dev as well as on a custom domain.
//
// WHAT IS SIGNED, and so cannot be changed in transit or reused anywhere else:
//
//   bestlife-caller/1 \n <caller name> \n <host> \n <METHOD> \n <path?query> \n <unix seconds> \n <nonce> \n <SHA-256 hex of the body>
//
// A signature older or newer than five minutes is refused, and so is a nonce this worker has already let in
// (nonces.ts: a SQLite-backed Durable Object, strongly consistent), so a captured request cannot be sent twice. No
// token is accepted. (This file is the same in every holder worker; each folder stands alone.)

export interface CallerEnv {
	/** The name Best Life signs as. Empty: Best Life may not call this worker at all. */
	BESTLIFE_CALLER_CN?: string;
	/** Best Life's caller public key (SPKI PEM). Empty: the one below. Set only if Best Life tells you it changed. */
	BESTLIFE_CALLER_KEY?: string;
	/** The nonces already let in (nonces.ts). Without it Best Life is refused: a request could be replayed. */
	NONCES?: NonceNamespace;
}

/** The Durable Object namespace of nonces.ts, as much of it as this file uses. */
export interface NonceNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: { method?: string }): Promise<Response> } }

/** Best Life's caller key, the public half. SHA-256 of its SPKI: 16fb7797d603e1b1f5087e769bd6b122b8be2ad841d25fc5b823c6147b3c9da4 */
export const BESTLIFE_CALLER_KEY =
	"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3LqP00fGhexchFz92ftxvoW1k9Hh\nXCqZO5nTaaHRcM0/EhkPOkiAbeVXJyAa/p/uTnPzMQV70KSvjZwoNe1KDQ==\n-----END PUBLIC KEY-----\n";

/** How far a signature's time may be from now, in seconds. */
export const WINDOW = 300;

export type Caller = { ok: true; who: "binding" | "bestlife" } | { ok: false; why: string };

/** The exact text Best Life signs. Must match access-service holdersign.ts signedText. Pure. */
export const signedText = (cn: string, host: string, method: string, path: string, time: string, nonce: string, digest: string): string =>
	`bestlife-caller/1\n${cn}\n${host}\n${method}\n${path}\n${time}\n${nonce}\n${digest}`;

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Who is asking: a sibling over a binding, or Best Life with a good signature. */
export async function caller(req: Request, env: CallerEnv, allow: { binding: boolean; bestlife: boolean }, now = Date.now()): Promise<Caller> {
	const cf = (req as { cf?: unknown }).cf;
	if (!cf) return allow.binding ? { ok: true, who: "binding" } : { ok: false, why: "not reachable over a binding" };
	if (!allow.bestlife) return { ok: false, why: "only the holder's own workers may call this, over a binding" };
	if (req.headers.get("authorization")) return { ok: false, why: "no token is accepted: Best Life signs its requests" };
	const want = (env.BESTLIFE_CALLER_CN ?? "").trim();
	if (!want) return { ok: false, why: "BESTLIFE_CALLER_CN is not set: Best Life may not call this worker" };
	const cn = req.headers.get("x-bestlife-caller") ?? "";
	const time = req.headers.get("x-bestlife-time") ?? "";
	const nonce = req.headers.get("x-bestlife-nonce") ?? "";
	const sig = req.headers.get("x-bestlife-signature") ?? "";
	if (!cn || !time || !nonce || !sig) return { ok: false, why: "not signed: Best Life signs every request it sends" };
	if (cn !== want) return { ok: false, why: `'${cn}' is not Best Life` };
	if (!/^\d{1,12}$/.test(time) || Math.abs(now / 1000 - Number(time)) > WINDOW) return { ok: false, why: "the signature is too old or too new" };
	if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, why: "the nonce is not 32 hex characters" };
	const url = new URL(req.url);
	const digest = hex(await crypto.subtle.digest("SHA-256", await req.clone().arrayBuffer()));
	const text = signedText(cn, url.host, req.method.toUpperCase(), url.pathname + url.search, time, nonce, digest);
	try {
		const pem = (env.BESTLIFE_CALLER_KEY ?? "").trim() || BESTLIFE_CALLER_KEY;
		const key = await crypto.subtle.importKey("spki", bytes(pem.replace(/-----[^-]+-----|\s/g, "")) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(sig) as BufferSource, new TextEncoder().encode(text) as BufferSource);
		if (!good) return { ok: false, why: "the signature does not match Best Life's key" };
	} catch {
		return { ok: false, why: "the signature could not be read" };
	}
	// ONCE ONLY: checked after the signature, so only Best Life's own requests are ever kept.
	if (!env.NONCES) return { ok: false, why: "NONCES is not bound: a signed request could be sent twice, so Best Life is refused" };
	const seen = await env.NONCES.get(env.NONCES.idFromName("nonces")).fetch(`https://nonces/seen?nonce=${nonce}`, { method: "POST" });
	if (seen.status === 409) return { ok: false, why: "this signed request was already used" };
	if (!seen.ok) return { ok: false, why: "the nonce could not be checked" };
	return { ok: true, who: "bestlife" };
}

export const json = (v: unknown, status = 200): Response =>
	new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
