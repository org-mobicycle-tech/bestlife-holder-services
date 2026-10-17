// nonces.ts -- THE NONCES THIS WORKER HAS ALREADY LET IN, so a signed request from Best Life works once and only once.
//
// A signature is good for five minutes (caller.ts). Without this, a request captured in those five minutes could be
// sent again -- the same email sent twice. Every signed request carries a fresh nonce; this keeps each one it has
// seen, and refuses a nonce it has seen before.
//
// A SQLite-backed Durable Object: one object per worker, strongly consistent, and on the Workers Free plan ("Durable
// Objects are available both on Workers Free and Workers Paid plans. Workers Free plan: Only Durable Objects with
// SQLite storage backend are available", https://developers.cloudflare.com/durable-objects/platform/pricing/). Not
// KV: KV is eventually consistent, so two copies of one request at two places could both get in. Here the check and
// the keeping are one SQL statement, run by the one object, one request at a time.
//
// A nonce is kept ten minutes, twice the signature's window, then let go: a request older than that is refused by
// its time anyway.

interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }
export interface NonceState { storage: { sql: Sql } }

/** How long a nonce is kept, in seconds. */
export const KEEP = 600;

export class SeenNonces {
	private sql: Sql;
	constructor(state: NonceState) {
		this.sql = state.storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS seen (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	}

	/** POST /seen?nonce= : 200 the first time, 409 every time after. */
	async fetch(req: Request): Promise<Response> {
		const nonce = new URL(req.url).searchParams.get("nonce") ?? "";
		if (!/^[0-9a-f]{32}$/.test(nonce)) return new Response("not a nonce", { status: 400 });
		const now = Math.floor(Date.now() / 1000);
		this.sql.exec("DELETE FROM seen WHERE at < ?", now - KEEP);
		const kept = this.sql.exec("INSERT INTO seen (nonce, at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING RETURNING nonce", nonce, now).toArray();
		return new Response(kept.length ? "first" : "seen", { status: kept.length ? 200 : 409 });
	}
}
