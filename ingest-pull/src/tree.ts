// tree.ts -- WHERE EVERY ITEM IS KEPT in the holder's own storage, the same tree Best Life reads:
//
//   <folder>/<evidence>/<address>/<item>.<part>       inbox/email/someone@example.com/9f2c….eml
//
// (This file is the same in every holder worker that files evidence; each folder stands alone.)

export const FOLDERS = ["inbox", "sent", "drafts", "spam", "phishing", "trash"] as const;
export const EVIDENCE = ["email", "mail", "voicemail", "messages", "brain", "attachments"] as const;

const ADDRESS = "[a-z0-9._%+@-]{1,254}";
const ITEM = "[A-Za-z0-9_-]{1,128}\\.[A-Za-z0-9._-]{1,64}";
const PATH = new RegExp(`^(${FOLDERS.join("|")})/(${EVIDENCE.join("|")})/${ADDRESS}/${ITEM}$`);

/** Is this a path in the tree? Pure. */
export const isItemPath = (p: string): boolean => PATH.test(p) && !p.includes("..");

/** Is this a prefix a listing may start from: a folder, a folder and evidence, or down to an address? Pure. */
export function isPrefix(p: string): boolean {
	if (p === "" || p.includes("..")) return p === "";
	const parts = p.replace(/\/$/, "").split("/");
	if (parts.length > 3) return false;
	if (!(FOLDERS as readonly string[]).includes(parts[0]!)) return false;
	if (parts.length > 1 && !(EVIDENCE as readonly string[]).includes(parts[1]!)) return false;
	if (parts.length > 2 && !new RegExp(`^${ADDRESS}$`).test(parts[2]!)) return false;
	return true;
}

/** The path an item is kept at. Pure. */
export const itemPath = (folder: (typeof FOLDERS)[number], evidence: (typeof EVIDENCE)[number], address: string, item: string): string =>
	`${folder}/${evidence}/${address.trim().toLowerCase()}/${item}`;

/** An item's id: the first 32 hex characters of the SHA-256 of its bytes, so the same message is the same item. */
export async function contentId(bytes: ArrayBuffer): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let hex = "";
	for (const b of d) hex += b.toString(16).padStart(2, "0");
	return hex.slice(0, 32);
}
