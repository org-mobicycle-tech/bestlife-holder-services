// platform.ts -- THE STORAGE SHAPES THE STORE USES (R2 and D1), written out here rather than taken from a types
// package. Only the methods called are listed.

export interface R2Object { key: string; size: number; uploaded: Date; httpMetadata?: { contentType?: string } }
export interface R2Body extends R2Object { arrayBuffer(): Promise<ArrayBuffer> }
export interface R2Bucket {
	head(key: string): Promise<R2Object | null>;
	get(key: string): Promise<R2Body | null>;
	put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<R2Object>;
	list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
}

export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	run(): Promise<unknown>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Database { prepare(sql: string): D1Statement; exec(sql: string): Promise<unknown> }
