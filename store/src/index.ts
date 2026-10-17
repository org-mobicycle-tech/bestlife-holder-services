// bestlife-holder-store -- THE HOLDER'S OWN STORAGE, DATABASE AND CACHE for their evidence, in their own account.
//
//   STORAGE (R2)  every item as it came, at <folder>/<evidence>/<address>/<item>.<part>
//   DB      (D1)  the index: one envelope per item (from, to, subject, date, size, when it was filed)
//   CACHE   (KV)  envelopes just read, for an hour; dropped when the envelope is written again
//
//   PUT /item?path=            keep an item; an item already kept stays as it is (the same bytes have the same path)
//   GET /item?path=            the item
//   GET /list?prefix=&cursor=  the items under a folder, evidence or address: path, size, when
//   PUT /index?path=           write an item's envelope            GET /index?path=   read it
//   GET /envelopes?prefix=     the newest envelopes under a prefix (200 at most)
//   GET /healthz               whether storage, db and cache are bound
//
// WHO MAY ASK: the holder's own ingest workers, over a binding; and Best Life, its request signed with its caller
// key (caller.ts). Nothing here deletes: moving an item to trash and emptying it
// is Best Life's trash method, asked of the holder, never done by this worker on its own.

import { caller, json } from "./caller";
import { log, warn } from "./log";
import { type Kv } from "./runtime";
import { type D1Database, type R2Bucket } from "./platform";
import { isItemPath, isPrefix } from "./tree";

export interface Env {
	STORAGE: R2Bucket;
	DB: D1Database;
	CACHE: Kv;
	BESTLIFE_CALLER_CN?: string;
	BESTLIFE_CALLER_KEY?: string;
}

const W = "store";
const SCHEMA = "CREATE TABLE IF NOT EXISTS items (path TEXT PRIMARY KEY, folder TEXT NOT NULL, evidence TEXT NOT NULL, address TEXT NOT NULL, envelope TEXT NOT NULL, at TEXT NOT NULL)";
let schemaReady = false;
const ready = async (db: D1Database): Promise<void> => { if (!schemaReady) { await db.exec(SCHEMA); schemaReady = true; } };

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const who = await caller(req, env, { binding: true, bestlife: true });
		if (!who.ok) { warn(W, "refused", { why: who.why }); return json({ error: who.why }, 403); }
		const url = new URL(req.url);
		const path = url.searchParams.get("path") ?? "";

		if (url.pathname === "/healthz") return json({ ok: !!(env.STORAGE && env.DB && env.CACHE), worker: "bestlife-holder-store", storage: !!env.STORAGE, db: !!env.DB, cache: !!env.CACHE });

		if (url.pathname === "/item" || url.pathname === "/index") {
			if (!isItemPath(path)) return json({ error: `'${path}' is not a path in the tree (<folder>/<evidence>/<address>/<item>.<part>)` }, 400);
		}

		if (url.pathname === "/item" && req.method === "PUT") {
			const had = await env.STORAGE.head(path);
			if (had) { log(W, "already kept", { path, size: had.size, who: who.who }); return json({ path, kept: true, existed: true, size: had.size }); }
			const bytes = await req.arrayBuffer();
			if (!bytes.byteLength) return json({ error: "an item has bytes" }, 400);
			await env.STORAGE.put(path, bytes, { httpMetadata: { contentType: req.headers.get("content-type") ?? "application/octet-stream" } });
			log(W, "kept", { path, size: bytes.byteLength, who: who.who });
			return json({ path, kept: true, existed: false, size: bytes.byteLength }, 201);
		}

		if (url.pathname === "/item" && req.method === "GET") {
			const o = await env.STORAGE.get(path);
			if (!o) return json({ error: `nothing kept at ${path}` }, 404);
			log(W, "read", { path, size: o.size, who: who.who });
			return new Response(await o.arrayBuffer(), { headers: { "content-type": o.httpMetadata?.contentType ?? "application/octet-stream" } });
		}

		if (url.pathname === "/list" && req.method === "GET") {
			const prefix = url.searchParams.get("prefix") ?? "";
			if (!isPrefix(prefix)) return json({ error: `'${prefix}' is not a folder, evidence or address in the tree` }, 400);
			const cursor = url.searchParams.get("cursor") ?? undefined;
			const page = await env.STORAGE.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
			log(W, "listed", { path: prefix, count: page.objects.length, who: who.who });
			return json({ items: page.objects.map((o) => ({ path: o.key, size: o.size, at: o.uploaded.toISOString() })), cursor: page.truncated ? page.cursor : null });
		}

		if (url.pathname === "/index" && req.method === "PUT") {
			let envelope: unknown;
			try { envelope = await req.json(); } catch { return json({ error: "the envelope is JSON" }, 400); }
			if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return json({ error: "the envelope is a JSON object" }, 400);
			const [folder, evidence, address] = path.split("/");
			await ready(env.DB);
			await env.DB.prepare("INSERT INTO items (path, folder, evidence, address, envelope, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(path) DO UPDATE SET envelope = excluded.envelope")
				.bind(path, folder, evidence, address, JSON.stringify(envelope), new Date().toISOString()).run();
			await env.CACHE.delete(`env:${path}`);
			log(W, "indexed", { path, who: who.who });
			return json({ path, indexed: true });
		}

		if (url.pathname === "/index" && req.method === "GET") {
			const cached = await env.CACHE.get(`env:${path}`);
			if (cached) return new Response(cached, { headers: { "content-type": "application/json", "x-cache": "hit" } });
			await ready(env.DB);
			const row = await env.DB.prepare("SELECT envelope FROM items WHERE path = ?1").bind(path).first<{ envelope: string }>();
			if (!row) return json({ error: `no envelope for ${path}` }, 404);
			await env.CACHE.put(`env:${path}`, row.envelope, { expirationTtl: 3600 });
			return new Response(row.envelope, { headers: { "content-type": "application/json", "x-cache": "miss" } });
		}

		if (url.pathname === "/envelopes" && req.method === "GET") {
			const prefix = url.searchParams.get("prefix") ?? "";
			if (!prefix || !isPrefix(prefix)) return json({ error: `'${prefix}' is not a folder, evidence or address in the tree` }, 400);
			await ready(env.DB);
			const like = prefix.replace(/\/$/, "") + "/%";
			const rows = await env.DB.prepare("SELECT path, envelope, at FROM items WHERE path LIKE ?1 ORDER BY at DESC LIMIT 200").bind(like).all<{ path: string; envelope: string; at: string }>();
			log(W, "envelopes", { path: prefix, count: rows.results.length, who: who.who });
			return json({ envelopes: rows.results.map((r) => ({ path: r.path, at: r.at, ...(JSON.parse(r.envelope) as Record<string, unknown>) })) });
		}

		return json({ error: "not a route", routes: ["PUT /item?path=", "GET /item?path=", "GET /list?prefix=", "PUT /index?path=", "GET /index?path=", "GET /envelopes?prefix=", "GET /healthz"] }, 404);
	},
};
