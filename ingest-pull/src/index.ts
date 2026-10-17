// bestlife-holder-ingest-pull -- READS THE HOLDER'S OWN MAILBOXES OVER IMAP on its schedule, and files each new
// message in their own store, as ingest-push does for routed mail. The password for each mailbox is opened by the
// holder's access worker when it is needed. Only its cron runs it: no route, no workers.dev, no preview URL.

import { connect } from "cloudflare:sockets";
import { pullAll, type Connect, type Env } from "./pull";
import { caller, json } from "./caller";
import { log } from "./log";

export default {
	async scheduled(_controller: unknown, env: Env): Promise<void> {
		const r = await pullAll(env, connect as unknown as Connect);
		log("ingest-pull", "run", { count: r.filed, status: r.failed ? "some mailboxes failed" : "ok" });
	},

	/** Only a sibling, over a binding, may ask whether this worker is here. */
	async fetch(req: Request): Promise<Response> {
		const who = caller(req, {}, { binding: true, bestlife: false });
		if (!who.ok) return json({ error: who.why }, 403);
		if (new URL(req.url).pathname === "/healthz") return json({ ok: true, worker: "bestlife-holder-ingest-pull" });
		return json({ error: "not a route: this worker runs on its schedule" }, 404);
	},
};
