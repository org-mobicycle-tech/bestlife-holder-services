// caller.ts -- WHO MAY ASK THIS WORKER. Two callers only:
//
//   a sibling worker in the holder's own account, over a service binding: the request carries no `cf`.
//   Best Life, over the holder's own custom domain with mTLS on: Cloudflare has checked Best Life's client
//     certificate, and its common name is the one in BESTLIFE_CALLER_CN.
//
// Nothing else is let in: no token is accepted, and a certificate that was not presented, not verified, or names
// anyone else is refused. (This file is the same in every holder worker; each folder stands alone.)

export interface CallerEnv {
	/** The common name on Best Life's client certificate. Empty: Best Life may not call this worker at all. */
	BESTLIFE_CALLER_CN?: string;
}

interface ClientAuth { certPresented?: string; certVerified?: string; certSubjectDN?: string; certSubjectDNRFC2253?: string }

export type Caller = { ok: true; who: "binding" | "bestlife" } | { ok: false; why: string };

/** The certificate's common name, as Cloudflare read it from the subject. Pure. */
export const commonName = (dn: string): string => /(?:^|[,/]\s*)CN=([^,/]+)/.exec(dn)?.[1]?.trim() ?? "";

/** Who is asking: a sibling over a binding, or Best Life with its verified certificate. Pure. */
export function caller(req: Request, env: CallerEnv, allow: { binding: boolean; bestlife: boolean }): Caller {
	const cf = (req as { cf?: { tlsClientAuth?: ClientAuth } }).cf;
	if (!cf) return allow.binding ? { ok: true, who: "binding" } : { ok: false, why: "not reachable over a binding" };
	if (!allow.bestlife) return { ok: false, why: "only the holder's own workers may call this, over a binding" };
	if (req.headers.get("authorization")) return { ok: false, why: "no token is accepted: present the client certificate" };
	const auth = cf.tlsClientAuth;
	if (!auth || auth.certPresented !== "1") return { ok: false, why: "present the client certificate" };
	if (auth.certVerified !== "SUCCESS") return { ok: false, why: `the client certificate was not verified (${auth.certVerified ?? "unknown"})` };
	const want = (env.BESTLIFE_CALLER_CN ?? "").trim();
	const who = commonName(auth.certSubjectDN ?? auth.certSubjectDNRFC2253 ?? "");
	if (!want) return { ok: false, why: "BESTLIFE_CALLER_CN is not set: Best Life may not call this worker" };
	if (who !== want) return { ok: false, why: `'${who || "no name"}' is not Best Life's certificate` };
	return { ok: true, who: "bestlife" };
}

export const json = (v: unknown, status = 200): Response =>
	new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
