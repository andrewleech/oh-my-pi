import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** Clipboard HTML larger than this is pasted by the browser as-is. */
const MAX_HTML_CHARS = 1_000_000;

/** Clipboard type VS Code sets on copies from its editor; those copies already paste as code text. */
const VSCODE_EDITOR_TYPE = "vscode-editor-data";

/** Elements removed together with their content before conversion. */
const DROPPED_SELECTOR = "script, style, meta, link, title, template, noscript, head, [hidden], [aria-hidden='true']";

const COMMENT_NODE = 8;

const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i;

/** Link and image schemes that survive conversion. Anything else (relative, `javascript:`, `data:`) is dropped. */
const SAFE_LINK = /^(?:https?:|mailto:)/i;
const SAFE_IMAGE = /^https?:/i;

/** Elements whose presence means the clipboard carries structure that plain text would lose. */
const SEMANTIC_SELECTOR = [
	"h1,h2,h3,h4,h5,h6",
	"ul,ol",
	"table",
	"blockquote",
	"pre,code",
	"hr",
	"em,i,strong,b,del,s,strike",
	"a[href]",
	"img",
].join(",");

let service: TurndownService | undefined;

function converter(): TurndownService {
	if (service) return service;
	const td = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "_",
		strongDelimiter: "**",
		linkStyle: "inlined",
	});
	td.use(gfm);
	td.addRule("strikethrough", {
		filter: ["del", "s", "strike"] as (keyof HTMLElementTagNameMap)[],
		replacement: content => `~~${content}~~`,
	});
	td.addRule("listItem", {
		filter: "li",
		replacement: (content, node, options) => {
			const parent = node.parentNode as HTMLElement | null;
			let prefix = `${options.bulletListMarker} `;
			if (parent?.nodeName === "OL") {
				const start = Number(parent.getAttribute("start") ?? 1);
				prefix = `${(Number.isFinite(start) ? start : 1) + Array.from(parent.children).indexOf(node)}. `;
			}
			const body = content
				.replace(/^\n+/, "")
				.replace(/^(\[[ x]\]) +/, "$1 ")
				.replace(/\n+$/, "\n")
				.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
			return prefix + body + (node.nextSibling && !body.endsWith("\n") ? "\n" : "");
		},
	});
	// The GFM cell rule leaves `|` unescaped, which splits the cell.
	td.addRule("tableCell", {
		filter: ["th", "td"],
		replacement: (content, node) => {
			const cells = node.parentNode ? Array.from(node.parentNode.childNodes) : [];
			const prefix = cells.indexOf(node) === 0 ? "| " : " ";
			return `${prefix}${content.trim().replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|")} |`;
		},
	});
	service = td;
	return td;
}

function normalizeSpace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isHidden(el: Element): boolean {
	const style = el.getAttribute("style");
	return style !== null && HIDDEN_STYLE.test(style);
}

function styleValue(el: Element, property: string): string | null {
	const style = el.getAttribute("style");
	if (style === null) return null;
	const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(style);
	return match ? match[1]!.trim().toLowerCase() : null;
}

function isBoldWeight(weight: string): boolean {
	if (weight === "bold" || weight === "bolder") return true;
	const numeric = Number(weight);
	return Number.isFinite(numeric) && numeric >= 600;
}

function replaceWithChildren(el: Element): void {
	el.replaceWith(...Array.from(el.childNodes));
}

function wrapContent(doc: Document, el: Element, tag: string): void {
	const wrapper = doc.createElement(tag);
	wrapper.append(...Array.from(el.childNodes));
	el.append(wrapper);
}

function removeComments(node: Node): void {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === COMMENT_NODE) node.removeChild(child);
		else removeComments(child);
	}
}

function dropUnwanted(doc: Document): void {
	for (const el of Array.from(doc.querySelectorAll(DROPPED_SELECTOR))) el.remove();
	for (const el of Array.from(doc.querySelectorAll("[style]"))) {
		if (isHidden(el)) el.remove();
	}
}

function sanitizeUrls(doc: Document): void {
	for (const a of Array.from(doc.querySelectorAll("a"))) {
		const href = (a.getAttribute("href") ?? "").replace(/\s/g, "");
		if (!SAFE_LINK.test(href)) replaceWithChildren(a);
	}
	for (const img of Array.from(doc.querySelectorAll("img"))) {
		const src = (img.getAttribute("src") ?? "").replace(/\s/g, "");
		if (!SAFE_IMAGE.test(src)) img.remove();
	}
}

/**
 * Rewrites presentational inline styles into the elements they imitate. Google Docs expresses
 * bold, italic and strikethrough as span styles and wraps the whole fragment in a
 * `<b style="font-weight:normal">`, which must not read as bold.
 */
function normalizeInlineStyles(doc: Document): void {
	for (const el of Array.from(doc.querySelectorAll("b, strong"))) {
		const weight = styleValue(el, "font-weight");
		if (weight !== null && !isBoldWeight(weight)) replaceWithChildren(el);
	}
	for (const el of Array.from(doc.querySelectorAll("span[style]"))) {
		const weight = styleValue(el, "font-weight");
		const italic = styleValue(el, "font-style");
		const decoration = `${styleValue(el, "text-decoration") ?? ""} ${styleValue(el, "text-decoration-line") ?? ""}`;
		if (decoration.includes("line-through")) wrapContent(doc, el, "del");
		if (italic === "italic" || italic === "oblique") wrapContent(doc, el, "em");
		if (weight !== null && isBoldWeight(weight)) wrapContent(doc, el, "strong");
	}
}

const WORD_LIST_STYLE = /mso-list\s*:\s*l\d+/i;
const WORD_MARKER_STYLE = /mso-list\s*:\s*ignore\b/i;
const ORDERED_MARKER = /^\s*(?:\d+|[a-z]|[ivxlc]+)[.)]/i;

/**
 * Word marks list paragraphs with `mso-list` and a bullet or number span (`mso-list:Ignore`);
 * rebuild consecutive runs as nested lists and drop the marker spans.
 */
function rebuildWordLists(doc: Document): void {
	let root: Element | null = null;
	const stack: Element[] = [];
	for (const p of Array.from(doc.querySelectorAll("p"))) {
		const style = p.getAttribute("style") ?? "";
		if (!WORD_LIST_STYLE.test(style)) continue;
		if (root?.nextElementSibling !== p) {
			root = null;
			stack.length = 0;
		}
		const level = Number(/level(\d+)/i.exec(style)?.[1] ?? 1);
		const marker = Array.from(p.querySelectorAll("span[style]")).find(span =>
			WORD_MARKER_STYLE.test(span.getAttribute("style") ?? ""),
		);
		const ordered = ORDERED_MARKER.test(marker?.textContent ?? "");
		marker?.remove();
		const item = doc.createElement("li");
		item.append(...Array.from(p.childNodes));
		while (stack.length > level) stack.pop();
		while (stack.length < level) {
			const list = doc.createElement(ordered ? "ol" : "ul");
			const parent = stack[stack.length - 1];
			if (parent) (parent.lastElementChild ?? parent).append(list);
			else {
				p.before(list);
				root = list;
			}
			stack.push(list);
		}
		stack[stack.length - 1]!.append(item);
		p.remove();
	}
}

/** Moves a list nested directly inside another list into the preceding item, as Google Docs emits. */
function nestOrphanLists(doc: Document): void {
	for (const list of Array.from(doc.querySelectorAll("ul > ul, ul > ol, ol > ul, ol > ol"))) {
		const previousItem = list.previousElementSibling;
		if (previousItem?.tagName === "LI") previousItem.append(list);
	}
}

/** Google Docs wraps every list item's text in a `<p>`, which Markdown would render as a loose list. */
function unwrapListParagraphs(doc: Document): void {
	for (const p of Array.from(doc.querySelectorAll("li > p"))) {
		if (p.nextElementSibling?.tagName === "P") p.append(doc.createElement("br"));
		replaceWithChildren(p);
	}
}

/** Turns `<pre>` content into a single `<code>` text node so syntax-highlight spans do not matter. */
function normalizePre(doc: Document): void {
	for (const pre of Array.from(doc.querySelectorAll("pre"))) {
		for (const br of Array.from(pre.querySelectorAll("br"))) br.replaceWith("\n");
		const code = pre.querySelector("code");
		const language = code?.className.match(/language-\S+/)?.[0];
		const next = doc.createElement("code");
		if (language) next.className = language;
		next.textContent = pre.textContent;
		pre.replaceChildren(next);
	}
}

/** GFM tables need a header row; clipboard tables from spreadsheets have none, so the first row becomes it. */
function promoteHeaderRows(doc: Document): void {
	// A leading colgroup (Google Sheets) stops the GFM plugin from seeing the first tbody as the header.
	for (const group of Array.from(doc.querySelectorAll("colgroup, col"))) group.remove();
	for (const table of Array.from(doc.querySelectorAll("table"))) {
		const row = table.querySelector("tr");
		if (!row || row.querySelector("th")) continue;
		for (const cell of Array.from(row.children)) {
			if (cell.tagName !== "TD") continue;
			const header = doc.createElement("th");
			header.append(...Array.from(cell.childNodes));
			cell.replaceWith(header);
		}
	}
}

/**
 * Converts clipboard rich text to Markdown. Returns `null` when the default paste should run:
 * the content is not rich, conversion would not change the text, or the source (VS Code, an
 * oversized document) is better pasted verbatim.
 */
export function htmlClipboardToMarkdown(input: {
	html: string;
	plain: string;
	types: readonly string[];
}): string | null {
	const { html, plain, types } = input;
	if (html.length === 0 || html.length > MAX_HTML_CHARS) return null;
	if (types.includes(VSCODE_EDITOR_TYPE)) return null;

	// DOMParser documents are inert: scripts do not run and resources do not load.
	const doc = new DOMParser().parseFromString(html, "text/html");
	removeComments(doc);
	dropUnwanted(doc);
	sanitizeUrls(doc);
	rebuildWordLists(doc);
	const body = doc.body;
	if (!body || normalizeSpace(body.textContent ?? "").length === 0) return null;
	normalizeInlineStyles(doc);
	nestOrphanLists(doc);
	unwrapListParagraphs(doc);
	normalizePre(doc);
	promoteHeaderRows(doc);
	if (!body.querySelector(SEMANTIC_SELECTOR)) return null;

	const markdown = converter().turndown(body).trim();
	if (markdown.length === 0) return null;
	if (normalizeSpace(markdown) === normalizeSpace(plain)) return null;
	return markdown;
}
