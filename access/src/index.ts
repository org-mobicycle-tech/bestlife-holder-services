// bestlife-holder-access -- THE HOLDER'S KEYS, sealed with the holder's own encryption key, handed only to the
// holder's own workers over service bindings. Best Life never holds these keys and cannot reach this worker: it has
// no route, no workers.dev and no preview URL, and refuses any request that did not come over a binding.
//
//   POST /seal   { name, value }   seal a key into KEYS under the holder's ENCRYPTION_KEY
//   POST /open   { name }          the key's value: a KEY_<NAME> secret set at deploy, else the sealed one in KEYS
//   GET  /names                    the names of the keys held (never a value)
//   GET  /healthz                  whether the encryption key is set
//
// A name is upper case letters, digits and _ (IMAP_PASSWORD, RESEND_API_KEY, AI_API_KEY). Sealing is AES-GCM with
// a fresh 12-byte IV and the name as additional data, so a sealed value moved under another name will not open.

import { caller, json } from "./caller";
import { log, warn } from "./log";
import { type Kv } from "./runtime";

export interface Env {
	ENCRYPTION_KEY?: string;
	KEYS: Kv;
	[secret: string]: unknown;
}

const W = "access";
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The holder's encryption key, or why it cannot be used. */
export async function keyOf(env: Env): Promise<CryptoKey | string> {
	const raw = String(env.ENCRYPTION_KEY ?? "").trim();
	if (!raw) return "ENCRYPTION_KEY is not set";
	let bytes: Uint8Array<ArrayBuffer>;
	try { bytes = unb64(raw); } catch { return "ENCRYPTION_KEY is not base64"; }
	if (bytes.length !== 32) return `ENCRYPTION_KEY must be 32 bytes (it is ${bytes.length})`;
	return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, name: string, value: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(name) }, key, enc.encode(value)));
	return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function unseal(key: CryptoKey, name: string, sealed: string): Promise<string | null> {
	const [v, iv, ct] = sealed.split(".");
	if (v !== "v1" || !iv || !ct) return null;
	try {
		return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(name) }, key, unb64(ct)));
	} catch { return null; }
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
	try { const b = (await req.json()) as unknown; return b && typeof b === "object" ? (b as Record<string, unknown>) : null; } catch { return null; }
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const who = await caller(req, {}, { binding: true, bestlife: false });
		if (!who.ok) { warn(W, "refused", { why: who.why }); return json({ error: who.why }, 403); }
		const { pathname } = new URL(req.url);

		if (pathname === "/healthz") {
			const k = await keyOf(env);
			return json({ ok: typeof k !== "string", worker: "bestlife-holder-access", ...(typeof k === "string" ? { why: k } : {}) });
		}

		if (pathname === "/names" && req.method === "GET") {
			const fromSecrets = Object.keys(env).filter((k) => k.startsWith("KEY_") && typeof env[k] === "string" && String(env[k]).trim()).map((k) => k.slice(4));
			const fromKv: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await env.KEYS.list({ prefix: "key:", ...(cursor ? { cursor } : {}) });
				for (const k of page.keys) fromKv.push(k.name.slice(4));
				cursor = page.list_complete ? undefined : page.cursor;
			} while (cursor);
			return json({ names: [...new Set([...fromSecrets, ...fromKv])].sort() });
		}

		if ((pathname === "/seal" || pathname === "/open") && req.method === "POST") {
			const b = await body(req);
			const name = String(b?.name ?? "").trim();
			if (!NAME.test(name)) return json({ error: `'${name}' is not a key name (A-Z, 0-9, _)` }, 400);

			if (pathname === "/open") {
				const secret = env[`KEY_${name}`];
				if (typeof secret === "string" && secret.trim()) { log(W, "opened", { name, via: "secret" }); return json({ name, value: secret }); }
				const sealed = await env.KEYS.get(`key:${name}`);
				if (!sealed) { log(W, "not held", { name }); return json({ error: `no key named ${name}` }, 404); }
				const key = await keyOf(env);
				if (typeof key === "string") return json({ error: key }, 503);
				const value = await unseal(key, name, sealed);
				if (value === null) { warn(W, "would not open", { name }); return json({ error: `${name} would not open with this ENCRYPTION_KEY` }, 500); }
				log(W, "opened", { name, via: "sealed" });
				return json({ name, value });
			}

			const value = b?.value;
			if (typeof value !== "string" || !value) return json({ error: "value must be a non-empty string" }, 400);
			const key = await keyOf(env);
			if (typeof key === "string") return json({ error: key }, 503);
			await env.KEYS.put(`key:${name}`, await seal(key, name, value));
			log(W, "sealed", { name });
			return json({ name, sealed: true });
		}

		return json({ error: "not a route", routes: ["POST /seal", "POST /open", "GET /names", "GET /healthz"] }, 404);
	},
};
