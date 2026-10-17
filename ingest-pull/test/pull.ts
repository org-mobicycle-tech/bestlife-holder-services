// INGEST-PULL against a fake IMAP server: literals are read by count even when split across reads and when they
// hold line breaks; only new messages are filed; nothing in the mailbox is changed; the password is never logged.
//
//   bun test/pull.ts
import { pullAll, mailboxesOf, type Env, type Connect } from "../src/pull";
import { quoted, searched, uidValidity } from "../src/imap";

let failed = 0;
const is = (what: string, ok: boolean, saw = ""): void => {
	process.stdout.write((ok ? "ok    " : "FAIL  ") + what + (ok ? "" : "\n      " + saw) + "\n");
	if (!ok) failed += 1;
};

const MESSAGES: Record<number, string> = {
	7: "From: a@b.org\r\nTo: someone@example.com\r\nSubject: private one\r\n\r\nline one\r\n{5}\r\nnot a literal\r\n",
	9: "From: c@d.org\r\nTo: someone@example.com\r\nSubject: private two\r\n\r\nbody two\r\n",
};
const commands: string[] = [];
const enc = new TextEncoder();

const fakeServer: Connect = () => {
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	// Send each answer in small, uneven pieces, so the reader must join reads.
	const send = (s: string) => { const b = enc.encode(s); for (let i = 0; i < b.length; i += 7) ctrl.enqueue(b.slice(i, i + 7)); };
	const readable = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; send("* OK fake IMAP ready\r\n"); } });
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			const line = new TextDecoder().decode(chunk).replace(/\r\n$/, "");
			const [tag, ...rest] = line.split(" ");
			const cmd = rest.join(" ");
			commands.push(cmd.startsWith("LOGIN") ? "LOGIN …" : cmd);
			if (cmd.startsWith("LOGIN")) send(cmd === `LOGIN "someone@example.com" "pa\\"ss"` ? `${tag} OK logged in\r\n` : `${tag} NO bad login\r\n`);
			else if (cmd === "SELECT INBOX") send(`* 2 EXISTS\r\n* OK [UIDVALIDITY 4242] ok\r\n${tag} OK [READ-WRITE] selected\r\n`);
			else if (cmd.startsWith("UID SEARCH UID ")) {
				const from = Number(/UID (\d+):\*/.exec(cmd)![1]);
				const have = Object.keys(MESSAGES).map(Number).filter((u) => u >= from);
				send(`* SEARCH ${(have.length ? have : [9]).join(" ")}\r\n${tag} OK search done\r\n`);
			} else if (cmd.startsWith("UID FETCH ")) {
				const uid = Number(cmd.split(" ")[2]);
				const m = MESSAGES[uid]!;
				send(`* ${uid} FETCH (UID ${uid} BODY[] {${enc.encode(m).length}}\r\n${m})\r\n${tag} OK fetch done\r\n`);
			} else if (cmd === "LOGOUT") { send(`* BYE\r\n${tag} OK bye\r\n`); }
			else send(`${tag} BAD unknown\r\n`);
		},
	});
	return { readable, writable, close: async () => {} };
};

const filed: { path: string; body: string }[] = [];
const STORE = {
	fetch: async (r: Request) => {
		if (r.url.includes("/item?")) filed.push({ path: new URL(r.url).searchParams.get("path")!, body: await r.text() });
		return Response.json({ ok: true }, { status: 201 });
	},
};
const ACCESS = { fetch: async (r: Request) => ((await r.json()) as { name: string }).name === "IMAP_PASSWORD" ? Response.json({ value: 'pa"ss' }) : Response.json({ error: "no" }, { status: 404 }) };
const state = new Map<string, string>();
const STATE = { get: async (k: string) => state.get(k) ?? null, put: async (k: string, v: string) => { state.set(k, v); }, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) };
globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

const env: Env = {
	STORE, ACCESS, STATE,
	MAILBOXES: JSON.stringify([{ address: "Someone@Example.com", host: "imap.example.com", port: 993, user: "someone@example.com", key: "IMAP_PASSWORD" }]),
};

const lines: string[] = [];
const was = { log: console.log, warn: console.warn };
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
const r1 = await pullAll(env, fakeServer);
const r2 = await pullAll(env, fakeServer);
console.log = was.log;
console.warn = was.warn;

is("the first run files both messages", r1.filed === 2 && filed.length === 2, JSON.stringify(r1));
is("each is filed under its address", filed.every((f) => /^inbox\/email\/someone@example\.com\/[0-9a-f]{32}\.eml$/.test(f.path)), JSON.stringify(filed.map((f) => f.path)));
is("a literal is read by count, line breaks and braces included", filed[0]!.body === MESSAGES[7], JSON.stringify(filed[0]?.body));
is("the last UID is kept with its UIDVALIDITY", state.get("uid:someone@example.com") === JSON.stringify({ validity: "4242", last: 9 }), state.get("uid:someone@example.com"));
is("the next run files nothing new (the server's * answer is not taken as new)", r2.filed === 0 && filed.length === 2, JSON.stringify(r2));
is("messages are fetched with PEEK, so none is marked read", commands.filter((c) => c.startsWith("UID FETCH")).every((c) => c.endsWith("BODY.PEEK[]")));
is("nothing in the mailbox is changed", !commands.some((c) => /STORE|EXPUNGE|MOVE|COPY|DELETE/i.test(c)), commands.join(" | "));
is("the password never reaches the logs", lines.every((l) => !l.includes("pa\\\"ss") && !l.includes('pa"ss')), lines.join("\n"));
is("the logs never carry a subject or body", lines.every((l) => !l.includes("private")), lines.join("\n"));

// A WRONG PASSWORD
const bad: Env = { ...env, ACCESS: { fetch: async () => Response.json({ value: "wrong" }) }, STATE: { ...STATE, get: async () => null } };
filed.length = 0;
const r3 = await pullAll(bad, fakeServer);
is("a refused login files nothing", r3.filed === 0 && filed.length === 0);

// PURE PARTS
is("mailboxes that are not whole are left out and named", (() => { const m = mailboxesOf(JSON.stringify([{ address: "x" }, { address: "a@b.co", host: "h", key: "K" }])); return m.boxes.length === 1 && m.bad[0] === "mailbox 1"; })());
is("a quoted string escapes quotes and backslashes", quoted('a"b\\c') === '"a\\"b\\\\c"');
is("a line break cannot be quoted", (() => { try { quoted("a\r\nb"); return false; } catch { return true; } })());
is("UIDVALIDITY is read from SELECT", uidValidity(["* OK [UIDVALIDITY 99] x"]) === "99");
is("SEARCH answers are read", JSON.stringify(searched(["* SEARCH 3 4 10"])) === "[3,4,10]");

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
