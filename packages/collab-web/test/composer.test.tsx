import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	Event as DOMEvent,
	parseHTML,
	type DOMWindow,
	type HTMLElement as DOMHTMLElement,
} from "@oh-my-pi/pi-utils/dom";
import { act, type KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollabCommand } from "@oh-my-pi/pi-wire";
import type { CommandRun, GuestSnapshot } from "../src/lib/client";
import { GuestClient } from "../src/lib/client";
import {
	Composer,
	type PastedData,
	partitionImageFiles,
	pastedFiles,
	shouldSubmitOnEnter,
} from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";
import { createGuestSnapshot } from "./helpers/guest-snapshot";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function snapshot(uiRequest: GuestSnapshot["uiRequest"], overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
	return createGuestSnapshot({
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		history: null,
		commands: null,
		command: null,
		uiRequest,
		...overrides,
	});
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

describe("Composer slash commands", () => {
	const COMMANDS: CollabCommand[] = [{ name: "compact", source: "builtin" }];

	function placeholder(snap: GuestSnapshot): string | undefined {
		let value: string | undefined;
		new HTMLRewriter()
			.on("textarea", {
				element(el) {
					value = el.getAttribute("placeholder") ?? undefined;
				},
			})
			.transform(renderToStaticMarkup(<Composer client={client} snapshot={snap} />));
		return value;
	}

	function resultPanel(command: CommandRun): { status: string; output: string | null; dismissable: boolean } {
		const html = renderToStaticMarkup(<Composer client={client} snapshot={snapshot(null, { command })} />);
		const panel = { status: "", output: null as string | null, dismissable: false };
		new HTMLRewriter()
			.on(".sh-cmd-result-status", {
				text(chunk) {
					panel.status += chunk.text;
				},
			})
			.on(".sh-cmd-result-output", {
				text(chunk) {
					panel.output = (panel.output ?? "") + chunk.text;
				},
			})
			.on('button[aria-label="Dismiss command result"]', {
				element() {
					panel.dismissable = true;
				},
			})
			.transform(html);
		return panel;
	}

	it("mentions / in the placeholder only when the host runs commands", () => {
		expect(placeholder(snapshot(null, { commands: COMMANDS }))).toContain("/ for commands");
		expect(placeholder(snapshot(null))).not.toContain("/");
	});

	it("shows a running command without output or dismiss", () => {
		expect(resultPanel({ reqId: 1, text: "/compact", status: "running", output: "" })).toEqual({
			status: "running…",
			output: null,
			dismissable: false,
		});
	});

	it("shows a finished command's output with a dismiss button", () => {
		expect(resultPanel({ reqId: 1, text: "/session", status: "done", output: "id: s1\ncwd: /work" })).toEqual({
			status: "done",
			output: "id: s1\ncwd: /work",
			dismissable: true,
		});
	});

	it("shows a finished command with no output as a bare done header", () => {
		expect(resultPanel({ reqId: 1, text: "/skill:review", status: "done", output: "" })).toEqual({
			status: "done",
			output: null,
			dismissable: true,
		});
	});

	it("shows a failed command's error", () => {
		expect(resultPanel({ reqId: 1, text: "/compact", status: "error", output: "unknown command" })).toEqual({
			status: "failed",
			output: "unknown command",
			dismissable: true,
		});
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
		const html = renderToStaticMarkup(<Composer client={client} snapshot={snapshot(null, { readOnly: true })} />);
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

describe("Composer image submissions", () => {
	const records = new Map<string, Map<IDBValidKey, Record<string, unknown>>>([
		["prompt-history", new Map()],
		["prompt-drafts", new Map()],
	]);
	const globals = new Map<string, PropertyDescriptor | undefined>();
	let window: DOMWindow;

	function setGlobal(name: string, value: unknown): void {
		if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}

	beforeAll(() => {
		window = parseHTML("<html><head></head><body></body></html>");
		const database = {
			objectStoreNames: { contains: (name: string) => records.has(name) },
			createObjectStore(name: string) {
				records.set(name, new Map());
				return { createIndex() {} };
			},
			transaction(name: string) {
				const values = records.get(name)!;
				const transaction: { oncomplete: (() => void) | null } = { oncomplete: null };
				const request = (operation: () => unknown) => {
					const result: { result?: unknown; onsuccess: (() => void) | null } = { onsuccess: null };
					queueMicrotask(() => {
						result.result = operation();
						result.onsuccess?.();
						transaction.oncomplete?.();
					});
					return result;
				};
				return Object.assign(transaction, {
					objectStore: () => ({
						index: () => ({
							getAll: (roomId: string) =>
								request(() => [...values.values()].filter(value => value.roomId === roomId)),
						}),
						get: (key: IDBValidKey) => request(() => values.get(key)),
						add: (value: Record<string, unknown>) => request(() => values.set(value.id as IDBValidKey, value)),
						put: (value: Record<string, unknown>) =>
							request(() => values.set(value.roomId as IDBValidKey, value)),
						delete: (key: IDBValidKey) => request(() => values.delete(key)),
					}),
				});
			},
		};
		setGlobal("indexedDB", {
			open() {
				const request: {
					result?: typeof database;
					onupgradeneeded: (() => void) | null;
					onsuccess: (() => void) | null;
				} = {
					onupgradeneeded: null,
					onsuccess: null,
				};
				queueMicrotask(() => {
					request.result = database;
					if (records.size === 0) request.onupgradeneeded?.();
					request.onsuccess?.();
				});
				return request;
			},
		});
		setGlobal("window", window);
		setGlobal("document", window.document);
		setGlobal("Node", window.Node);
		setGlobal("HTMLElement", window.HTMLElement);
		setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		setGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} }));
		setGlobal(
			"FileReader",
			class {
				result = "";
				onload: (() => void) | null = null;
				readAsDataURL(blob: Blob) {
					void blob.arrayBuffer().then(bytes => {
						this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
						this.onload?.();
					});
				}
			},
		);
	});

	afterAll(() => {
		for (const [name, descriptor] of globals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	});

	async function submitImage(roomId: string, draft: string) {
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new URL(`https://example.test/#${roomId}#${encodeBase64Url(new Uint8Array(32))}`),
		});
		records.get("prompt-drafts")!.set(roomId, { roomId, text: draft });
		const snap = snapshot(null, { commands: [{ name: "compact", source: "builtin" }] });
		const prompts: unknown[][] = [];
		const commands: string[] = [];
		const guest = {
			getSnapshot: () => snap,
			sendPrompt: (...args: unknown[]) => prompts.push(args),
			sendCommand: (text: string) => commands.push(text),
		} as unknown as GuestClient;
		const container = window.document.createElement("div");
		window.document.body.appendChild(container);
		let root: Root | undefined;
		try {
			await act(async () => {
				root = createRoot(container as unknown as Element);
				root.render(<Composer client={guest} snapshot={snap} />);
			});
			expect((container.querySelector("textarea") as DOMHTMLElement).value).toBe(draft);
			const input = container.querySelector('input[type="file"]')!;
			Object.defineProperty(input, "files", {
				configurable: true,
				value: [new File(["image"], "image.png", { type: "image/png" })],
			});
			await act(async () => {
				input.dispatchEvent(new DOMEvent("change", { bubbles: true }));
			});
			const send = container.querySelector('button[title="send (Enter)"]')! as DOMHTMLElement;
			expect(send.disabled).toBe(false);
			await act(async () => {
				send.click();
			});
			expect(records.get("prompt-drafts")!.has(roomId)).toBe(false);
			return { prompts, commands };
		} finally {
			await act(async () => root?.unmount());
			container.remove();
		}
	}

	it("sends an image with no text when history persistence is active", async () => {
		const result = await submitImage("imageonlyroom123", "");
		expect(result).toEqual({
			prompts: [["", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]]],
			commands: [],
		});
	});

	it("sends command-looking text with an image as a prompt", async () => {
		const result = await submitImage("commandroom12345", "/compact");
		expect(result).toEqual({
			prompts: [["/compact", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]]],
			commands: [],
		});
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
