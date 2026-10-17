// log.ts -- ONE READABLE LINE PER EVENT, and never the evidence or a secret. Only the fields named in SAFE are
// written; anything else handed in is dropped, so a message body, a subject, a prompt or a key cannot reach the
// logs by mistake. (This file is the same in every holder worker; each folder stands alone.)

const SAFE = ["worker", "event", "path", "address", "id", "size", "status", "via", "why", "count", "name", "who", "ms"] as const;
type Field = (typeof SAFE)[number];

/** The line that would be logged: the event, then the safe fields in a fixed order. Pure. */
export function line(worker: string, event: string, fields: Partial<Record<Field | string, unknown>> = {}): string {
	const out: Record<string, unknown> = { worker, event };
	for (const k of SAFE) if (k !== "worker" && k !== "event" && fields[k] !== undefined) out[k] = fields[k];
	return JSON.stringify(out);
}

export const log = (worker: string, event: string, fields?: Partial<Record<Field | string, unknown>>): void => console.log(line(worker, event, fields));
export const warn = (worker: string, event: string, fields?: Partial<Record<Field | string, unknown>>): void => console.warn(line(worker, event, fields));
