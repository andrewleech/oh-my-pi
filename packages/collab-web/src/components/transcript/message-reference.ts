import type { SessionEntry } from "@oh-my-pi/pi-wire";

const PREVIEW_CHARS = 100;
const LABEL_MAX_CHARS = 64;

export interface MessageReferenceInput {
	/** Collab header id of the session. */
	sessionId: string;
	/** Last entry of the published active branch. */
	leafId: string;
	entry: SessionEntry;
	/** Session label supplied by the embedding page. */
	label?: string | null;
}

function entryRole(entry: SessionEntry): string {
	if (entry.type === "message") return entry.message.role;
	if (entry.type === "custom_message") return entry.attribution === "user" ? "user" : entry.type;
	return entry.type;
}

function firstText(entry: SessionEntry): string {
	let content: unknown;
	if (entry.type === "message") content = entry.message.content;
	else if (entry.type === "custom_message") content = entry.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return block.text;
	}
	return "";
}

function preview(entry: SessionEntry): string {
	const text = firstText(entry).replace(/\s+/g, " ").trim();
	const chars = Array.from(text);
	return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("").trimEnd()}…` : text;
}

/** Label from the guest page's `label` query parameter: trimmed, capped, null when empty. */
export function sessionLabelFromUrl(href: string): string | null {
	let value: string | null;
	try {
		value = new URL(href).searchParams.get("label");
	} catch {
		return null;
	}
	const label = value?.trim().replace(/\s+/g, " ");
	return label ? Array.from(label).slice(0, LABEL_MAX_CHARS).join("") : null;
}

/** Plain-text reference that a session's agent resolves through `history://current/entry/<id>`. */
export function buildMessageReference({ sessionId, leafId, entry, label }: MessageReferenceInput): string {
	const lines = ["omp message reference"];
	const name = label?.trim();
	if (name) lines.push(`session: ${name}`);
	lines.push(`role: ${entryRole(entry)}`);
	const text = preview(entry);
	if (text !== "") lines.push(`preview: ${text}`);
	lines.push(
		`read: history://current/entry/${encodeURIComponent(entry.id)}?session=${encodeURIComponent(sessionId)}&leaf=${encodeURIComponent(leafId)}`,
	);
	return lines.join("\n");
}

/** Copies text via the async clipboard API, falling back to a hidden textarea for iframes and insecure contexts. */
export async function copyText(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// Fall through to the execCommand path.
		}
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
	document.body.appendChild(area);
	const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	try {
		area.select();
		if (!document.execCommand("copy")) throw new Error("Copy to clipboard failed");
	} finally {
		area.remove();
		previous?.focus();
	}
}
