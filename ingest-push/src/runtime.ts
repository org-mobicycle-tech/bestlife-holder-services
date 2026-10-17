// runtime.ts -- THE FEW PLATFORM SHAPES THIS WORKER USES, written out here rather than taken from a types package.
// Only the methods called are listed. (This file is the same in every holder worker; each folder stands alone.)

/** A sibling worker, over a service binding. */
export interface Fetcher { fetch(request: Request): Promise<Response> }

/** A KV namespace: text values only. */
export interface Kv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
	list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}
