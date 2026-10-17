// pull.ts -- ONE RUN OF THE PULL: for each of the holder's mailboxes, the new messages since the last run, filed in
// the holder's own store. The password comes from the holder's access worker at the moment it is needed and is
// never kept or logged. The mailbox is only read: messages are fetched with PEEK, so nothing is marked read,
// moved or deleted.
//
//   MAILBOXES  [{ "address": "someone@example.com", "host": "imap.example.com", "port": 993,
//                 "user": "someone@example.com", "key": "IMAP_PASSWORD" }]
//   STATE      per mailbox: the UIDVALIDITY and the last UID filed

import { Imap, quoted, searched, uidValidity, type Duplex } from "./imap";
import { fileMessage, envelopeOf, type FileEnv } from "./file";
import { type Fetcher, type Kv } from "./runtime";
import { log, warn } from "./log";

export interface Env extends FileEnv {
	ACCESS: Fetcher;
	STATE: Kv;
	MAILBOXES?: string;
	PER_RUN?: string;
}

export interface Mailbox { address: string; host: string; port: number; user: string; key: string }

export type Connect = (address: { hostname: string; port: number }, options: { secureTransport: "on"; allowHalfOpen: boolean }) => Duplex & { close(): Promise<void> };

const W = "ingest-pull";
const MAX_BYTES = 25 * 1024 * 1024;

/** The mailboxes the holder set, each checked; the ones that are not whole are named and left out. Pure. */
export function mailboxesOf(raw: string | undefined): { boxes: Mailbox[]; bad: string[] } {
	let list: unknown;
	try { list = JSON.parse(raw?.trim() || "[]"); } catch { return { boxes: [], bad: ["MAILBOXES is not JSON"] }; }
	if (!Array.isArray(list)) return { boxes: [], bad: ["MAILBOXES is not a list"] };
	const boxes: Mailbox[] = [];
	const bad: string[] = [];
	list.forEach((m: Record<string, unknown>, i) => {
		const address = String(m?.address ?? "").trim().toLowerCase();
		const host = String(m?.host ?? "").trim();
		const user = String(m?.user ?? address).trim();
		const key = String(m?.key ?? "").trim();
		const port = Number(m?.port ?? 993);
		if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(address) || !host || !user || !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || !Number.isInteger(port)) bad.push(`mailbox ${i + 1}`);
		else boxes.push({ address, host, port, user, key });
	});
	return { boxes, bad };
}

async function password(env: Env, key: string): Promise<string | null> {
	const r = await env.ACCESS.fetch(new Request("https://access/open", { method: "POST", body: JSON.stringify({ name: key }), headers: { "content-type": "application/json" } }));
	if (!r.ok) return null;
	const b = (await r.json()) as { value?: unknown };
	return typeof b.value === "string" ? b.value : null;
}

/** Pull one mailbox. Returns how many messages were filed. */
export async function pullOne(env: Env, connect: Connect, box: Mailbox, perRun: number): Promise<number> {
	const pass = await password(env, box.key);
	if (pass === null) { warn(W, "no password", { address: box.address, name: box.key }); return 0; }
	const socket = connect({ hostname: box.host, port: box.port }, { secureTransport: "on", allowHalfOpen: false });
	const imap = new Imap(socket);
	let filed = 0;
	try {
		await imap.greeting();
		const login = await imap.command(`LOGIN ${quoted(box.user)} ${quoted(pass)}`);
		if (login.status !== "OK") { warn(W, "login refused", { address: box.address, status: login.status }); return 0; }
		const sel = await imap.command("SELECT INBOX");
		if (sel.status !== "OK") { warn(W, "inbox not opened", { address: box.address, status: sel.status }); return 0; }
		const validity = uidValidity(sel.lines) ?? "";
		const saved = JSON.parse((await env.STATE.get(`uid:${box.address}`)) ?? "{}") as { validity?: string; last?: number };
		const last = saved.validity === validity ? saved.last ?? 0 : 0;
		const search = await imap.command(`UID SEARCH UID ${last + 1}:*`);
		const uids = searched(search.lines).filter((u) => u > last).sort((a, b) => a - b).slice(0, perRun);
		let upTo = last;
		for (const uid of uids) {
			const f = await imap.command(`UID FETCH ${uid} BODY.PEEK[]`);
			const bytes = f.literals[0];
			if (f.status !== "OK" || !bytes) { warn(W, "not fetched", { address: box.address, id: uid, status: f.status }); break; }
			if (bytes.byteLength <= MAX_BYTES) {
				const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				await fileMessage(env, W, box.address, raw, envelopeOf(raw, { from: "", to: box.address }));
				filed += 1;
			} else warn(W, "too large to file", { address: box.address, id: uid, size: bytes.byteLength });
			upTo = uid;
			await env.STATE.put(`uid:${box.address}`, JSON.stringify({ validity, last: upTo }));
		}
		log(W, "pulled", { address: box.address, count: filed });
		return filed;
	} finally {
		await imap.close();
		try { await socket.close(); } catch { /* closed */ }
	}
}

/** One run over every mailbox; a mailbox that fails does not stop the others. */
export async function pullAll(env: Env, connect: Connect): Promise<{ filed: number; failed: number }> {
	const { boxes, bad } = mailboxesOf(env.MAILBOXES);
	for (const b of bad) warn(W, "mailbox left out", { why: `${b} is not whole: address, host, user and key are needed` });
	const perRun = Math.max(1, Math.min(100, Number(env.PER_RUN ?? 25) || 25));
	let filed = 0;
	let failed = 0;
	for (const box of boxes) {
		try { filed += await pullOne(env, connect, box, perRun); } catch (e) { failed += 1; warn(W, "mailbox failed", { address: box.address, why: e instanceof Error ? e.message.replace(/[^\w ./:@-]/g, "") : "error" }); }
	}
	return { filed, failed };
}
