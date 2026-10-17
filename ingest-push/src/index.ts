// bestlife-holder-ingest-push -- THE EMAIL ROUTING TARGET for the holder's own domain. Each message that arrives is
// filed, as it came, in the holder's own store (inbox/email/<to>/<id>.eml) with its envelope in their index, and
// Best Life is told it arrived -- metadata only: who it is for, the address, the id, the size, when.
//
// It never forwards and never replies. It has no route, no workers.dev and no preview URL: Email Routing is the only
// way in (Email › Email Routing › Routing rules › Send to a Worker › bestlife-holder-ingest-push). If the store
// refuses, the message is rejected back to Email Routing so it is not lost silently.

import { fileMessage, envelopeOf, type FileEnv } from "./file";
import { caller, json } from "./caller";
import { warn } from "./log";

/** The incoming message, as Email Routing hands it to the worker (only what is used). */
export interface IncomingEmail {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	setReject(reason: string): void;
}

export type Env = FileEnv;

const W = "ingest-push";

export default {
	async email(message: IncomingEmail, env: Env): Promise<void> {
		const raw = await new Response(message.raw).arrayBuffer();
		const address = message.to.trim().toLowerCase();
		try {
			await fileMessage(env, W, address, raw, envelopeOf(raw, { from: message.from, to: message.to }));
		} catch (e) {
			warn(W, "not filed", { address, size: raw.byteLength, why: e instanceof Error ? e.message.replace(/[^\w ./:@-]/g, "") : "error" });
			message.setReject("temporarily unable to accept this message");
			throw e;
		}
	},

	/** Only a sibling, over a binding, may ask whether this worker is here. */
	async fetch(req: Request): Promise<Response> {
		const who = caller(req, {}, { binding: true, bestlife: false });
		if (!who.ok) return json({ error: who.why }, 403);
		if (new URL(req.url).pathname === "/healthz") return json({ ok: true, worker: "bestlife-holder-ingest-push" });
		return json({ error: "not a route: this worker is reached by Email Routing" }, 404);
	},
};
