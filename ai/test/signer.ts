// signer.ts -- TESTS ONLY: signs a request the way Best Life does, with a key made for the test run. The real private
// key never leaves Best Life's key holder; this one never leaves the test. (The same in every holder worker's tests.)
import { Database } from "bun:sqlite";
import { signedText, type NonceNamespace } from "../src/caller";
import { SeenNonces } from "../src/nonces";

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

/** The test key's public half, as a holder worker's BESTLIFE_CALLER_KEY. */
export const TEST_KEY = `-----BEGIN PUBLIC KEY-----\n${b64(await crypto.subtle.exportKey("spki", pair.publicKey))}\n-----END PUBLIC KEY-----\n`;
export const TEST_CN = "bestlife-caller";

/** A request signed as Best Life signs one, arriving from the internet (it carries `cf`). */
export async function signed(url: string, init: RequestInit = {}, o: { cn?: string; time?: number; tamper?: boolean; key?: CryptoKey } = {}): Promise<Request> {
	const u = new URL(url);
	const method = (init.method ?? "GET").toUpperCase();
	const body = init.body === undefined || init.body === null ? new ArrayBuffer(0) : await new Response(init.body as BodyInit).arrayBuffer();
	const time = String(o.time ?? Math.floor(Date.now() / 1000));
	const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
	const cn = o.cn ?? TEST_CN;
	const text = signedText(cn, u.host, method, u.pathname + u.search, time, nonce, hex(await crypto.subtle.digest("SHA-256", body)));
	const sig = b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.key ?? pair.privateKey, new TextEncoder().encode(text)));
	const headers = new Headers(init.headers);
	headers.set("x-bestlife-caller", cn);
	headers.set("x-bestlife-time", time);
	headers.set("x-bestlife-nonce", nonce);
	headers.set("x-bestlife-signature", sig);
	const req = new Request(url, { ...init, method, headers, body: method === "GET" || method === "HEAD" ? undefined : o.tamper ? "tampered" : body }) as Request & { cf?: unknown };
	Object.defineProperty(req, "cf", { value: {} });
	return req;
}

/** Another key, not Best Life's: a signature by it must be refused. */
export const OTHER_KEY = ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;

/** The nonce Durable Object, the real class, on an in-memory SQLite database: one object, as in the worker. */
export function testNonces(): NonceNamespace {
	const db = new Database(":memory:");
	const sql = { exec: (q: string, ...b: unknown[]) => { const rows = db.query(q).all(...(b as never[])); return { toArray: () => rows }; } };
	const one = new SeenNonces({ storage: { sql } });
	return { idFromName: (n: string) => n, get: () => ({ fetch: (input: string, init?: { method?: string }) => one.fetch(new Request(input, init)) }) };
}
