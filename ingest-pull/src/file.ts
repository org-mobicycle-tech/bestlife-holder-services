// file.ts -- FILE ONE ARRIVED MESSAGE, then tell Best Life it arrived. Shared by ingest-push and ingest-pull.
//
//   1. the message, as it came, to the holder's own store:  PUT /item?path=inbox/email/<address>/<id>.eml
//   2. its envelope beside it in the store's index:         PUT /index?path=…  (the holder's own db)
//   3. Best Life is told "arrived", with metadata only:      { holder, evidence, address, id, size, at }
//
// The message never goes to Best Life, and is never forwarded. A store failure throws, so the message is not lost
// silently; a failed "arrived" notice is logged and the message stays filed (Best Life also lists the store).
// (This file is the same in both ingest workers; each folder stands alone.)

import { type Fetcher } from "./runtime";
import { contentId, itemPath } from "./tree";
import { log, warn } from "./log";

export interface FileEnv {
	STORE: Fetcher;
	BESTLIFE_HOLDER?: string;
	BESTLIFE_ARRIVED_URL?: string;
	BESTLIFE_TOKEN?: string;
}

export interface Envelope { from: string; to: string; subject?: string; date?: string; messageId?: string }

export interface Arrived { holder: string; evidence: "email"; address: string; id: string; size: number; at: string }

/** The few headers of a raw message that make its envelope. Reads only the header block. Pure. */
export function envelopeOf(raw: ArrayBuffer, fallback: { from: string; to: string }): Envelope {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(raw.slice(0, Math.min(raw.byteLength, 65536)));
	const head = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
	const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
	const get = (name: string): string | undefined => {
		const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(unfolded);
		return m?.[1]?.trim() || undefined;
	};
	return { from: get("From") ?? fallback.from, to: get("To") ?? fallback.to, subject: get("Subject"), date: get("Date"), messageId: get("Message-ID") };
}

/** File the message under the address it was sent to, and tell Best Life. Returns the item's id. */
export async function fileMessage(env: FileEnv, worker: string, address: string, raw: ArrayBuffer, envelope: Envelope): Promise<{ id: string; path: string }> {
	const id = await contentId(raw);
	const path = itemPath("inbox", "email", address, `${id}.eml`);
	const put = await env.STORE.fetch(new Request(`https://store/item?path=${encodeURIComponent(path)}`, { method: "PUT", body: raw, headers: { "content-type": "message/rfc822" } }));
	if (!put.ok) {
		warn(worker, "store refused", { path, status: put.status });
		throw new Error(`store refused ${path}: ${put.status}`);
	}
	const idx = await env.STORE.fetch(new Request(`https://store/index?path=${encodeURIComponent(path)}`, {
		method: "PUT",
		body: JSON.stringify({ ...envelope, size: raw.byteLength, at: new Date().toISOString() }),
		headers: { "content-type": "application/json" },
	}));
	if (!idx.ok) warn(worker, "index refused", { path, status: idx.status });
	log(worker, "filed", { path, size: raw.byteLength });
	await arrived(env, worker, { holder: (env.BESTLIFE_HOLDER ?? "").trim(), evidence: "email", address: address.toLowerCase(), id, size: raw.byteLength, at: new Date().toISOString() });
	return { id, path };
}

/** Tell Best Life an item arrived: metadata only, on the registration token Best Life issued to this holder. */
export async function arrived(env: FileEnv, worker: string, notice: Arrived): Promise<boolean> {
	const url = (env.BESTLIFE_ARRIVED_URL ?? "").trim();
	const token = (env.BESTLIFE_TOKEN ?? "").trim();
	if (!url || !token || !notice.holder) { log(worker, "arrived not sent", { id: notice.id, why: "BESTLIFE_ARRIVED_URL, BESTLIFE_HOLDER or BESTLIFE_TOKEN not set" }); return false; }
	try {
		const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(notice) });
		if (!r.ok) { warn(worker, "arrived refused", { id: notice.id, status: r.status }); return false; }
		log(worker, "arrived sent", { id: notice.id });
		return true;
	} catch (e) {
		warn(worker, "arrived failed", { id: notice.id, why: e instanceof Error ? e.name : "error" });
		return false;
	}
}
