// file.ts -- FILE ONE ARRIVED MESSAGE, then tell Best Life it arrived. Shared by ingest-push and ingest-pull.
//
//   1. the message, as it came, to the holder's own store:  PUT /item?path=inbox/email/<address>/<id>.eml
//   2. its envelope beside it in the store's index:         PUT /index?path=…  (the holder's own db)
//   3. Best Life is told "arrived", with metadata only:      { evidence, address, id, size, at }
//
// THE NOTICE IS SIGNED WITH THE HOLDER'S CONNECTION KEY (the CONNECTION_KEY secret: `blck1.<base64url JSON>`, made in
// Best Life's Settings, holding who, which key, its Ed25519 private half and Best Life's door). Best Life's door checks
// the signature against the public half it keeps, that it is fresh, and that the holder holds the address. No token is
// sent, and without a connection key nothing is told: the mail is still filed.
//
// The message never goes to Best Life, and is never forwarded. A store failure throws, so the message is not lost
// silently; a failed "arrived" notice is logged and the message stays filed (Best Life also lists the store).
// (This file is the same in both ingest workers; each folder stands alone.)

import { type Fetcher } from "./runtime";
import { contentId, itemPath } from "./tree";
import { log, warn } from "./log";

export interface FileEnv {
	STORE: Fetcher;
	CONNECTION_KEY?: string;
}

export interface Envelope { from: string; to: string; subject?: string; date?: string; messageId?: string }

export interface Arrived { evidence: "email"; address: string; id: string; size: number; at: string }

export interface ConnectionKey { user: string; keyId: string; privateKey: string; door: string }

const b64url = (b: ArrayBuffer): string => {
	const u = new Uint8Array(b);
	let s = "";
	for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string): Uint8Array<ArrayBuffer> => {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
	const out = new Uint8Array(new ArrayBuffer(bin.length));
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};
const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** The connection key, read; or why it is not one. Pure. */
export function parseConnectionKey(text: string): ConnectionKey | { why: string } {
	const t = text.trim();
	if (!t.startsWith("blck1.")) return { why: "CONNECTION_KEY is not a connection key (blck1.…)" };
	try {
		const v = JSON.parse(new TextDecoder().decode(unb64url(t.slice(6)))) as { u?: unknown; k?: unknown; d?: unknown; url?: unknown };
		const user = String(v.u ?? ""), keyId = String(v.k ?? ""), privateKey = String(v.d ?? ""), door = String(v.url ?? "");
		if (!/^[a-z][a-z0-9-]*$/.test(user) || !/^[0-9a-f]{12}$/.test(keyId) || !privateKey || !/^https:\/\/[a-z0-9.-]+$/.test(door)) return { why: "CONNECTION_KEY is incomplete" };
		return { user, keyId, privateKey, door };
	} catch {
		return { why: "CONNECTION_KEY cannot be read" };
	}
}

/** What is signed: the version, the time, who, which key, the path and query, and the body's SHA-256 -- the door's own. Pure. */
export const signedText = (time: string, user: string, keyId: string, pathAndQuery: string, bodySha256: string): string =>
	`bl1\n${time}\n${user}\n${keyId}\n${pathAndQuery}\n${bodySha256}`;

/** The arrived notice, signed with the connection key. */
export async function signedNotice(key: ConnectionKey, notice: Arrived, now = Date.now()): Promise<Request> {
	const pathAndQuery = `/int-cloud-to-cloud-push/held?${new URLSearchParams({ to: notice.address, id: notice.id })}`;
	const body = new TextEncoder().encode(JSON.stringify(notice));
	const time = String(Math.floor(now / 1000));
	const priv = await crypto.subtle.importKey("pkcs8", unb64url(key.privateKey), { name: "Ed25519" }, false, ["sign"]);
	const text = signedText(time, key.user, key.keyId, pathAndQuery, hex(await crypto.subtle.digest("SHA-256", body)));
	const signature = b64url(await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(text)));
	return new Request(`${key.door}${pathAndQuery}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-bl-user": key.user, "x-bl-key": key.keyId, "x-bl-time": time, "x-bl-signature": signature },
		body,
	});
}

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
	await arrived(env, worker, { evidence: "email", address: address.toLowerCase(), id, size: raw.byteLength, at: new Date().toISOString() });
	return { id, path };
}

/** Tell Best Life an item arrived: metadata only, signed with the holder's connection key. */
export async function arrived(env: FileEnv, worker: string, notice: Arrived): Promise<boolean> {
	const raw = (env.CONNECTION_KEY ?? "").trim();
	if (!raw) { log(worker, "arrived not sent", { id: notice.id, why: "no CONNECTION_KEY: the mail is filed, Best Life is not told" }); return false; }
	const key = parseConnectionKey(raw);
	if ("why" in key) { warn(worker, "arrived not sent", { id: notice.id, why: key.why }); return false; }
	try {
		const r = await fetch(await signedNotice(key, notice));
		if (!r.ok) { warn(worker, "arrived refused", { id: notice.id, status: r.status }); return false; }
		log(worker, "arrived sent", { id: notice.id });
		return true;
	} catch (e) {
		warn(worker, "arrived failed", { id: notice.id, why: e instanceof Error ? e.name : "error" });
		return false;
	}
}
