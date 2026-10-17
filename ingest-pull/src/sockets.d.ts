// sockets.d.ts -- the one function this worker takes from the runtime's TCP sockets, written out here rather than
// taken from a types package.
declare module "cloudflare:sockets" {
	export function connect(
		address: { hostname: string; port: number },
		options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
	): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void> };
}
