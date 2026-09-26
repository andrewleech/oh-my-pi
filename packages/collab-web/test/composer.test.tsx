import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GuestSnapshot } from "../src/lib/client";
import { GuestClient } from "../src/lib/client";
import {
	Composer,
	type PastedData,
	partitionImageFiles,
	pastedFiles,
	shouldSubmitOnEnter,
} from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function snapshot(uiRequest: GuestSnapshot["uiRequest"], readOnly = false): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly,
		uiRequest,
		notices: [],
		loading: null,
	};
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })}
			/>,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

describe("Composer image attachments", () => {
	function attachControls(html: string): { button: boolean; input: string | null } {
		const found = { button: false, input: null as string | null };
		new HTMLRewriter()
			.on('button[aria-label="attach images"]', {
				element() {
					found.button = true;
				},
			})
			.on('input[type="file"]', {
				element(el) {
					found.input = `${el.getAttribute("accept")}|${el.hasAttribute("multiple")}`;
				},
			})
			.transform(html);
		return found;
	}

	it("offers an image picker to writable guests", () => {
		const html = renderToStaticMarkup(<Composer client={client} snapshot={snapshot(null)} />);
		expect(attachControls(html)).toEqual({ button: true, input: "image/*|true" });
	});

	it("shows no attach UI to read-only guests", () => {
		const html = renderToStaticMarkup(<Composer client={client} snapshot={snapshot(null, true)} />);
		expect(attachControls(html)).toEqual({ button: false, input: null });
	});

	it("keeps images and counts everything else as ignored", () => {
		const png = new File(["x"], "shot.png", { type: "image/png" });
		const heic = new File(["x"], "photo.heic", { type: "image/heic" });
		const pdf = new File(["x"], "doc.pdf", { type: "application/pdf" });
		const unknown = new File(["x"], "blob");
		expect(partitionImageFiles([pdf, png, unknown, heic])).toEqual({ images: [png, heic], ignored: 2 });
	});
});

describe("pastedFiles", () => {
	const shot = new File(["x"], "image.png", { type: "image/png" });

	function clipboard(opts: { text?: string; files?: File[]; items?: File[] }): PastedData {
		return {
			files: opts.files ?? [],
			items: (opts.items ?? []).map(file => ({ kind: "file", getAsFile: () => file })),
			getData: format => (format === "text/plain" ? (opts.text ?? "") : ""),
		};
	}

	it("attaches a pasted image when the clipboard has no text", () => {
		expect(pastedFiles(clipboard({ files: [shot] }))).toEqual([shot]);
	});

	it("falls back to items when files is empty", () => {
		expect(pastedFiles(clipboard({ items: [shot] }))).toEqual([shot]);
	});

	it("attaches nothing when the image comes with text, as from a spreadsheet or document", () => {
		expect(pastedFiles(clipboard({ text: "A1\tB1", files: [shot], items: [shot] }))).toEqual([]);
	});

	it("attaches an image copied from a browser that carries its address as text", () => {
		expect(pastedFiles(clipboard({ text: "https://example.com/a.png", files: [shot] }))).toEqual([shot]);
	});

	it("treats a URL inside other text as a text paste", () => {
		expect(pastedFiles(clipboard({ text: "see https://example.com/a.png", files: [shot] }))).toEqual([]);
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});
