// bestlife-holder-ai -- ASKS THE HOLDER'S OWN AI, on the holder's own key (opened by their access worker), so the
// evidence they ask about goes from their account to their AI provider and nowhere else.
//
//   POST /ask  { system?, prompt }   ->  { text, model, provider }
//   GET  /healthz
//
// AI_PROVIDER  anthropic           Claude, through the official SDK. AI_MODEL defaults to claude-opus-5-5. Claude
//                                  thinks before it answers (adaptive thinking); when a request is declined on
//                                  policy grounds, the API re-runs it on Anthropic's recommended fallback model
//                                  in the same call (server-side fallbacks: "default").
//              openai-compatible   any /chat/completions endpoint (a model the holder runs, e.g. on Hetzner):
//                                  AI_ENDPOINT is its base URL, AI_MODEL its model name.
//
// WHO MAY ASK: Best Life, its request signed with its caller key (caller.ts), or a sibling over a binding. The prompt and the answer are never logged.

import Anthropic from "@anthropic-ai/sdk";
import { caller, json } from "./caller";
import { log, warn } from "./log";
import { type Fetcher } from "./runtime";

export interface Env {
	ACCESS: Fetcher;
	AI_PROVIDER?: string;
	AI_MODEL?: string;
	AI_ENDPOINT?: string;
	AI_KEY_NAME?: string;
	MAX_TOKENS?: string;
	BESTLIFE_CALLER_CN?: string;
	BESTLIFE_CALLER_KEY?: string;
}

export interface Question { system?: string; prompt: string }
export type Answer = { ok: true; text: string; model: string; provider: string } | { ok: false; status: number; why: string };

/** What the Anthropic path needs of a client; the SDK's own client is one. */
export interface ClaudeClient {
	beta: { messages: { stream(params: Record<string, unknown>): { finalMessage(): Promise<{ model: string; stop_reason: string | null; content: { type: string; text?: string }[] }> } } };
}

const W = "ai";
const DEFAULT_MODEL = "claude-opus-5-5";

async function keyOf(env: Env): Promise<string | null> {
	const name = (env.AI_KEY_NAME ?? "AI_API_KEY").trim();
	const r = await env.ACCESS.fetch(new Request("https://access/open", { method: "POST", body: JSON.stringify({ name }), headers: { "content-type": "application/json" } }));
	if (!r.ok) return null;
	const v = ((await r.json()) as { value?: unknown }).value;
	return typeof v === "string" && v ? v : null;
}

/** The request Claude is sent. Haiku models take no fallbacks; every other current model does. Pure. */
export function claudeParams(model: string, maxTokens: number, q: Question): Record<string, unknown> {
	const haiku = /haiku/i.test(model);
	return {
		model,
		max_tokens: maxTokens,
		...(q.system ? { system: q.system } : {}),
		messages: [{ role: "user", content: q.prompt }],
		...(haiku ? {} : { thinking: { type: "adaptive" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
	};
}

export async function askClaude(env: Env, q: Question, client: ClaudeClient): Promise<Answer> {
	const model = (env.AI_MODEL ?? "").trim() || DEFAULT_MODEL;
	const maxTokens = Math.max(256, Math.min(64000, Number(env.MAX_TOKENS ?? 16000) || 16000));
	const msg = await client.beta.messages.stream(claudeParams(model, maxTokens, q)).finalMessage();
	if (msg.stop_reason === "refusal") return { ok: false, status: 422, why: "the model declined this request" };
	const text = msg.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
	return { ok: true, text, model: msg.model, provider: "anthropic" };
}

export async function askCompatible(env: Env, q: Question, key: string): Promise<Answer> {
	const base = (env.AI_ENDPOINT ?? "").trim().replace(/\/+$/, "");
	const model = (env.AI_MODEL ?? "").trim();
	if (!/^https:\/\//.test(base)) return { ok: false, status: 503, why: "AI_ENDPOINT is not an https URL" };
	if (!model) return { ok: false, status: 503, why: "AI_MODEL is not set" };
	const messages = [...(q.system ? [{ role: "system", content: q.system }] : []), { role: "user", content: q.prompt }];
	const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages }) });
	if (!r.ok) return { ok: false, status: 502, why: `the AI endpoint answered ${r.status}` };
	const b = (await r.json().catch(() => ({}))) as { model?: string; choices?: { message?: { content?: unknown } }[] };
	const text = b.choices?.[0]?.message?.content;
	if (typeof text !== "string") return { ok: false, status: 502, why: "the AI endpoint gave no answer" };
	return { ok: true, text, model: b.model ?? model, provider: "openai-compatible" };
}

export async function ask(env: Env, q: Question, makeClient: (key: string) => ClaudeClient = (apiKey) => new Anthropic({ apiKey }) as unknown as ClaudeClient): Promise<Answer> {
	const provider = (env.AI_PROVIDER ?? "anthropic").trim().toLowerCase();
	if (provider !== "anthropic" && provider !== "openai-compatible") return { ok: false, status: 503, why: `AI_PROVIDER '${provider}' is not anthropic or openai-compatible` };
	const key = await keyOf(env);
	if (!key) return { ok: false, status: 503, why: "no AI key held: seal AI_API_KEY in the access worker" };
	try {
		return provider === "anthropic" ? await askClaude(env, q, makeClient(key)) : await askCompatible(env, q, key);
	} catch (e) {
		const status = Number((e as { status?: unknown })?.status ?? 0);
		return { ok: false, status: 502, why: status ? `the AI provider answered ${status}` : "the AI provider did not answer" };
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const who = await caller(req, env, { binding: true, bestlife: true });
		if (!who.ok) { warn(W, "refused", { why: who.why }); return json({ error: who.why }, 403); }
		const { pathname } = new URL(req.url);
		if (pathname === "/healthz") return json({ ok: true, worker: "bestlife-holder-ai", provider: (env.AI_PROVIDER ?? "anthropic").trim() || "anthropic", model: (env.AI_MODEL ?? "").trim() || DEFAULT_MODEL });
		if (pathname === "/ask" && req.method === "POST") {
			let b: Record<string, unknown> = {};
			try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "body must be JSON: { system?, prompt }" }, 400); }
			if (typeof b.prompt !== "string" || !b.prompt.trim()) return json({ error: "prompt is needed" }, 400);
			const started = Date.now();
			const a = await ask(env, { prompt: b.prompt, ...(typeof b.system === "string" && b.system ? { system: b.system } : {}) });
			if (!a.ok) { warn(W, "not answered", { status: a.status, why: a.why, who: who.who }); return json({ error: a.why }, a.status); }
			log(W, "answered", { via: a.provider, name: a.model, size: a.text.length, ms: Date.now() - started, who: who.who });
			return json({ text: a.text, model: a.model, provider: a.provider });
		}
		return json({ error: "not a route", routes: ["POST /ask", "GET /healthz"] }, 404);
	},
};
