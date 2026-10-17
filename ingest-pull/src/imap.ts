// imap.ts -- JUST ENOUGH IMAP (RFC 9051 / 3501) TO READ NEW MESSAGES, without changing anything in the mailbox:
// LOGIN, SELECT INBOX, UID SEARCH, UID FETCH BODY.PEEK[] (PEEK: the message is not marked read), LOGOUT.
//
// A server's answer can hold literals -- {1234}\r\n then exactly 1234 bytes -- inside a line, so the reader counts
// bytes for each literal rather than reading to the next line break.

export interface Duplex { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }

export interface Answer { status: "OK" | "NO" | "BAD"; text: string; lines: string[]; literals: Uint8Array[] }

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

/** A quoted IMAP string. A value with a line break cannot be quoted, and is refused. Pure. */
export function quoted(s: string): string {
	if (/[\r\n]/.test(s)) throw new Error("a line break cannot go in an IMAP string");
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class Imap {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private buf = new Uint8Array(0);
	private n = 0;

	constructor(socket: Duplex) {
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
	}

	private async more(): Promise<void> {
		const { value, done } = await this.reader.read();
		if (done || !value) throw new Error("the server closed the connection");
		const next = new Uint8Array(this.buf.length + value.length);
		next.set(this.buf);
		next.set(value, this.buf.length);
		this.buf = next;
	}

	/** One line, without its CRLF. */
	private async line(): Promise<string> {
		for (;;) {
			for (let i = 0; i + 1 < this.buf.length; i++) {
				if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
					const s = dec.decode(this.buf.subarray(0, i));
					this.buf = this.buf.slice(i + 2);
					return s;
				}
			}
			await this.more();
		}
	}

	/** Exactly n bytes. */
	private async bytes(n: number): Promise<Uint8Array> {
		while (this.buf.length < n) await this.more();
		const out = this.buf.slice(0, n);
		this.buf = this.buf.slice(n);
		return out;
	}

	/** One whole response line, with any literals it carries read out. */
	private async response(): Promise<{ line: string; literals: Uint8Array[] }> {
		let line = "";
		const literals: Uint8Array[] = [];
		for (;;) {
			const part = await this.line();
			const m = /\{(\d+)\+?\}$/.exec(part);
			if (!m) return { line: line + part, literals };
			literals.push(await this.bytes(Number(m[1])));
			line += part.slice(0, m.index) + "{literal}";
		}
	}

	/** The server's greeting. */
	async greeting(): Promise<string> {
		const { line } = await this.response();
		if (!/^\* (OK|PREAUTH)/i.test(line)) throw new Error("the server did not greet with OK");
		return line;
	}

	/** Send a command; read until its tagged answer. */
	async command(text: string): Promise<Answer> {
		this.n += 1;
		const tag = `b${this.n}`;
		await this.writer.write(enc.encode(`${tag} ${text}\r\n`));
		const lines: string[] = [];
		const literals: Uint8Array[] = [];
		for (;;) {
			const r = await this.response();
			literals.push(...r.literals);
			if (r.line.startsWith(`${tag} `)) {
				const rest = r.line.slice(tag.length + 1);
				const status = (/^(OK|NO|BAD)/i.exec(rest)?.[1]?.toUpperCase() ?? "BAD") as Answer["status"];
				return { status, text: rest, lines, literals };
			}
			lines.push(r.line);
		}
	}

	async close(): Promise<void> {
		try { await this.command("LOGOUT"); } catch { /* the server may close first */ }
		try { this.reader.releaseLock(); await this.writer.close(); } catch { /* already closed */ }
	}
}

/** UIDVALIDITY from SELECT's answer, or null. Pure. */
export const uidValidity = (lines: string[]): string | null => {
	for (const l of lines) { const m = /\[UIDVALIDITY (\d+)\]/i.exec(l); if (m) return m[1]!; }
	return null;
};

/** The UIDs a UID SEARCH answered with. Pure. */
export const searched = (lines: string[]): number[] =>
	lines.filter((l) => /^\* SEARCH\b/i.test(l)).flatMap((l) => l.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number)).filter((n) => Number.isInteger(n) && n > 0);
