import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

const RICH_HTML = `<h2>Title</h2><p>some <b>bold</b> text</p>`;
const RICH_MARKDOWN = "## Title\n\nsome **bold** text";

type ExecCommand = (command: string, showUi?: boolean, value?: string) => boolean;

const window = new Window();
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const globals: Record<string, unknown> = {
	window,
	document: window.document,
	navigator: window.navigator,
	DOMParser: window.DOMParser,
	Node: window.Node,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	HTMLIFrameElement: window.HTMLIFrameElement,
	SVGElement: window.SVGElement,
	Event: window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

// react-dom decides at import time whether the `input` event drives onChange, so it must load
// after the DOM globals exist.
const { Composer, isPlainPasteShortcut } = await import("../src/components/shell/Composer");
const { createRoot } = await import("react-dom/client");

let root: Root | null = null;

afterEach(async () => {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
		root = null;
	}
	window.document.body.innerHTML = "";
});

afterAll(() => {
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

async function mount(): Promise<{ textarea: HTMLTextAreaElement; sendDisabled: () => boolean }> {
	const container = window.document.createElement("div");
	window.document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<Composer
				client={client}
				phase="live"
				readOnly={false}
				uiRequest={null}
				working={false}
				queuedMessageCount={0}
				entries={[]}
				commands={null}
				command={null}
			/>,
		);
	});
	const textarea = container.querySelector("textarea");
	if (!textarea) throw new Error("textarea not rendered");
	(textarea as unknown as HTMLTextAreaElement).focus();
	const send = container.querySelector('button[title="send (Enter)"]');
	if (!send) throw new Error("send button not rendered");
	return {
		textarea: textarea as unknown as HTMLTextAreaElement,
		sendDisabled: () => (send as unknown as HTMLButtonElement).disabled,
	};
}

function installExecCommand(impl: ExecCommand): void {
	Object.defineProperty(window.document, "execCommand", { configurable: true, value: impl });
}

/** Mimics a browser `insertText`: edits the selection and fires the `input` event React listens to. */
function browserInsertText(textarea: HTMLTextAreaElement): ExecCommand {
	return (command, _showUi, value) => {
		if (command !== "insertText" || value === undefined) return false;
		const { selectionStart: start, selectionEnd: end } = textarea;
		const next = textarea.value.slice(0, start) + value + textarea.value.slice(end);
		// The prototype setter bypasses React's value tracker, like a native edit does.
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set?.call(textarea, next);
		textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
		return true;
	};
}

function paste(textarea: HTMLTextAreaElement, data: Record<string, string>): Event {
	const event = new window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			types: Object.keys(data),
			getData: (type: string) => data[type] ?? "",
			files: [],
			items: [],
		},
	});
	textarea.dispatchEvent(event as unknown as Event);
	return event as unknown as Event;
}

function key(textarea: HTMLTextAreaElement, type: "keydown" | "keyup", init: { key: string; ctrlKey: boolean; shiftKey: boolean }): void {
	textarea.dispatchEvent(new window.KeyboardEvent(type, { bubbles: true, ...init }) as unknown as Event);
}

describe("Composer rich-text paste", () => {
	it("inserts markdown at the selection through execCommand", async () => {
		const { textarea } = await mount();
		installExecCommand(browserInsertText(textarea));
		await act(async () => {
			textarea.value = "ab";
			textarea.setSelectionRange(1, 1);
		});

		let event: Event | undefined;
		await act(async () => {
			event = paste(textarea, { "text/html": RICH_HTML, "text/plain": "Title\nsome bold text" });
		});

		expect(event?.defaultPrevented).toBe(true);
		expect(textarea.value).toBe(`a${RICH_MARKDOWN}b`);
	});

	it("falls back to setRangeText and still updates state when execCommand fails", async () => {
		const { textarea, sendDisabled } = await mount();
		installExecCommand(() => false);
		expect(sendDisabled()).toBe(true);

		let event: Event | undefined;
		await act(async () => {
			event = paste(textarea, { "text/html": RICH_HTML, "text/plain": "Title\nsome bold text" });
		});

		expect(event?.defaultPrevented).toBe(true);
		expect(textarea.value).toBe(RICH_MARKDOWN);
		expect(sendDisabled()).toBe(false);
	});

	it("leaves plain-text and structure-free html pastes to the browser", async () => {
		const { textarea } = await mount();
		let calls = 0;
		installExecCommand(() => {
			calls += 1;
			return true;
		});

		let plainOnly: Event | undefined;
		let spans: Event | undefined;
		await act(async () => {
			plainOnly = paste(textarea, { "text/plain": "hello" });
			spans = paste(textarea, { "text/html": "<span>a</span><span> b</span>", "text/plain": "a b" });
		});

		expect(plainOnly?.defaultPrevented).toBe(false);
		expect(spans?.defaultPrevented).toBe(false);
		expect(calls).toBe(0);
	});

	it("skips conversion for a Ctrl+Shift+V paste and resumes afterwards", async () => {
		const { textarea } = await mount();
		installExecCommand(() => false);
		const data = { "text/html": RICH_HTML, "text/plain": "Title\nsome bold text" };

		let plain: Event | undefined;
		let rich: Event | undefined;
		await act(async () => {
			key(textarea, "keydown", { key: "V", ctrlKey: true, shiftKey: true });
			plain = paste(textarea, data);
			key(textarea, "keyup", { key: "V", ctrlKey: true, shiftKey: true });
			rich = paste(textarea, data);
		});

		expect(plain?.defaultPrevented).toBe(false);
		expect(rich?.defaultPrevented).toBe(true);
	});
});

describe("isPlainPasteShortcut", () => {
	it("matches Ctrl/Cmd+Shift+V only", () => {
		expect(isPlainPasteShortcut({ key: "V", ctrlKey: true, metaKey: false, shiftKey: true })).toBe(true);
		expect(isPlainPasteShortcut({ key: "v", ctrlKey: false, metaKey: true, shiftKey: true })).toBe(true);
		expect(isPlainPasteShortcut({ key: "v", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(false);
		expect(isPlainPasteShortcut({ key: "x", ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false);
	});
});
