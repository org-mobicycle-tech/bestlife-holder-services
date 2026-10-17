// bestlife-holder-send -- SENDS THE HOLDER'S MAIL from their own account: Cloudflare Email Sending first, Resend
// (on the holder's own Resend key, opened by their access worker) only when Cloudflare clearly did not send it.
//
//   POST /send  { messageId, from, to, subject, text, html?, replyTo?, inReplyTo? }
//   GET  /healthz
//
// NEVER TWICE. Each messageId is recorded in SENT before anything is tried:
//   sent     the same answer again, nothing re-sent
//   sending  / unknown   409 "check before resending": a send was started and its outcome is not known
//   failed   both paths refused; it may be asked again
// Resend is asked with Idempotency-Key = messageId, so even a repeated Resend call sends once.
//
// "Clearly did not send" is one of Email Sending's own refusals (the E_… codes that mean nothing was sent: sender
// not verified, recipient not allowed, limits). Any other error -- a timeout, an internal error -- is unknown, and
// unknown is never retried on the other path.
//
// WHO MAY ASK: Best Life, its request signed with its caller key (caller.ts), or a sibling over a binding. Logs say which path sent and why, never the subject, the body or a key.

import { caller, json } from "./caller";
import { log, warn } from "./log";
import { type Fetcher, type Kv } from "./runtime";

/** Cloudflare Email Sending's binding (only what is used). */
export interface SendEmail {
	send(message: { from: string; to: string | string[]; subject: string; text?: string; html?: string; replyTo?: string; headers?: Record<string, string> }): Promise<{ messageId: string }>;
}

export interface Env {
	EMAIL?: SendEmail;
	ACCESS: Fetcher;
	SENT: Kv;
	BESTLIFE_CALLER_CN?: string;
	BESTLIFE_CALLER_KEY?: string;
	RESEND_KEY_NAME?: string;
}

export interface Outgoing { messageId: string; from: string; to: string[]; subject: string; text: string; html?: string; replyTo?: string; inReplyTo?: string }

type Record_ = { state: "sending" | "sent" | "unknown" | "failed"; via?: "cloudflare" | "resend"; id?: string; why?: string; at: string };

const W = "send";
const DAY = 60 * 60 * 24;
const KEEP = 30 * DAY;

/** Email Sending codes that mean the message was not sent. */
export const REFUSED = new Set([
	"E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS", "E_SENDER_NOT_VERIFIED",
	"E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED", "E_CONTENT_TOO_LARGE",
]);

const ADDRESS = /^[^@\s<>"]+@[^@\s<>"]+\.[A-Za-z]{2,}$/;
const ID = /^[A-Za-z0-9._@<>-]{8,200}$/;

/** The message asked for, checked; or why it is not one. Pure. */
export function outgoingOf(b: Record<string, unknown> | null): Outgoing | string {
	if (!b) return "body must be JSON";
	const messageId = String(b.messageId ?? "").trim();
	const from = String(b.from ?? "").trim();
	const to = (Array.isArray(b.to) ? b.to : [b.to]).map((t) => String(t ?? "").trim()).filter(Boolean);
	const subject = String(b.subject ?? "");
	const text = String(b.text ?? "");
	if (!ID.test(messageId)) return "messageId is needed (8-200 of A-Z a-z 0-9 . _ @ < > -)";
	if (!ADDRESS.test(from)) return "from is not an address";
	if (!to.length || to.length > 50 || !to.every((t) => ADDRESS.test(t))) return "to is 1 to 50 addresses";
	if (!subject.trim() || /[\r\n]/.test(subject)) return "subject is one line";
	if (!text.trim() && typeof b.html !== "string") return "text or html is needed";
	const out: Outgoing = { messageId, from, to, subject, text };
	if (typeof b.html === "string" && b.html) out.html = b.html;
	if (typeof b.replyTo === "string" && ADDRESS.test(b.replyTo)) out.replyTo = b.replyTo;
	if (typeof b.inReplyTo === "string" && ID.test(b.inReplyTo)) out.inReplyTo = b.inReplyTo;
	return out;
}

async function viaCloudflare(env: Env, m: Outgoing): Promise<{ sent: true; id: string } | { sent: false; refused: boolean; why: string }> {
	if (!env.EMAIL) return { sent: false, refused: true, why: "no Email Sending binding" };
	try {
		const headers: Record<string, string> = { "X-BestLife-Message-Id": m.messageId };
		if (m.inReplyTo) { headers["In-Reply-To"] = m.inReplyTo; headers["References"] = m.inReplyTo; }
		const r = await env.EMAIL.send({ from: m.from, to: m.to, subject: m.subject, ...(m.text ? { text: m.text } : {}), ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), headers });
		return { sent: true, id: r.messageId };
	} catch (e) {
		const code = String((e as { code?: unknown })?.code ?? "");
		return { sent: false, refused: REFUSED.has(code), why: code || "no code" };
	}
}

async function resendKey(env: Env): Promise<string | null> {
	const name = (env.RESEND_KEY_NAME ?? "RESEND_API_KEY").trim();
	const r = await env.ACCESS.fetch(new Request("https://access/open", { method: "POST", body: JSON.stringify({ name }), headers: { "content-type": "application/json" } }));
	if (!r.ok) return null;
	const v = ((await r.json()) as { value?: unknown }).value;
	return typeof v === "string" && v ? v : null;
}

async function viaResend(env: Env, m: Outgoing): Promise<{ sent: true; id: string } | { sent: false; refused: boolean; why: string }> {
	const key = await resendKey(env);
	if (!key) return { sent: false, refused: true, why: "no Resend key held" };
	let r: Response;
	try {
		r = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": m.messageId },
			body: JSON.stringify({
				from: m.from, to: m.to, subject: m.subject,
				...(m.text ? { text: m.text } : {}), ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { reply_to: m.replyTo } : {}),
				headers: { "X-BestLife-Message-Id": m.messageId, ...(m.inReplyTo ? { "In-Reply-To": m.inReplyTo, References: m.inReplyTo } : {}) },
			}),
		});
	} catch {
		return { sent: false, refused: false, why: "Resend did not answer" };
	}
	const b = (await r.json().catch(() => ({}))) as { id?: string; name?: string };
	if (r.ok && b.id) return { sent: true, id: b.id };
	// A 4xx is Resend refusing (nothing sent); a 5xx or an answer without an id is unknown.
	return { sent: false, refused: r.status >= 400 && r.status < 500, why: `resend ${r.status}${b.name ? ` ${b.name}` : ""}` };
}

const record = (env: Env, id: string, r: Record_) => env.SENT.put(`sent:${id}`, JSON.stringify(r), { expirationTtl: KEEP });

export async function send(env: Env, m: Outgoing): Promise<Response> {
	const had = await env.SENT.get(`sent:${m.messageId}`);
	if (had) {
		const r = JSON.parse(had) as Record_;
		if (r.state === "sent") { log(W, "already sent", { id: m.messageId, via: r.via }); return json({ messageId: m.messageId, sent: true, already: true, via: r.via, id: r.id }); }
		if (r.state !== "failed") { warn(W, "outcome not known", { id: m.messageId, status: r.state }); return json({ error: "check before resending: a send of this message was started and its outcome is not known", state: r.state }, 409); }
	}
	await record(env, m.messageId, { state: "sending", at: new Date().toISOString() });

	const cf = await viaCloudflare(env, m);
	if (cf.sent) {
		await record(env, m.messageId, { state: "sent", via: "cloudflare", id: cf.id, at: new Date().toISOString() });
		log(W, "sent", { id: m.messageId, via: "cloudflare", count: m.to.length });
		return json({ messageId: m.messageId, sent: true, via: "cloudflare", id: cf.id });
	}
	if (!cf.refused) {
		await record(env, m.messageId, { state: "unknown", via: "cloudflare", why: cf.why, at: new Date().toISOString() });
		warn(W, "outcome not known", { id: m.messageId, via: "cloudflare", why: cf.why });
		return json({ error: "check before resending: Cloudflare did not say whether it sent", why: cf.why }, 409);
	}

	log(W, "falling back", { id: m.messageId, via: "resend", why: `cloudflare refused: ${cf.why}` });
	const rs = await viaResend(env, m);
	if (rs.sent) {
		await record(env, m.messageId, { state: "sent", via: "resend", id: rs.id, at: new Date().toISOString() });
		log(W, "sent", { id: m.messageId, via: "resend", count: m.to.length });
		return json({ messageId: m.messageId, sent: true, via: "resend", id: rs.id });
	}
	await record(env, m.messageId, { state: rs.refused ? "failed" : "unknown", via: "resend", why: rs.why, at: new Date().toISOString() });
	warn(W, rs.refused ? "not sent" : "outcome not known", { id: m.messageId, via: "resend", why: `${cf.why}; ${rs.why}` });
	return rs.refused
		? json({ error: "not sent: both Cloudflare and Resend refused", cloudflare: cf.why, resend: rs.why }, 502)
		: json({ error: "check before resending: Resend did not say whether it sent", why: rs.why }, 409);
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const who = await caller(req, env, { binding: true, bestlife: true });
		if (!who.ok) { warn(W, "refused", { why: who.why }); return json({ error: who.why }, 403); }
		const { pathname } = new URL(req.url);
		if (pathname === "/healthz") return json({ ok: true, worker: "bestlife-holder-send", cloudflare: !!env.EMAIL, access: !!env.ACCESS });
		if (pathname === "/send" && req.method === "POST") {
			let b: Record<string, unknown> | null = null;
			try { b = (await req.json()) as Record<string, unknown>; } catch { /* not JSON */ }
			const m = outgoingOf(b);
			if (typeof m === "string") return json({ error: m }, 400);
			return send(env, m);
		}
		return json({ error: "not a route", routes: ["POST /send", "GET /healthz"] }, 404);
	},
};
