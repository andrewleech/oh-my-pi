import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { clearPromptDraft, loadPromptDraft, savePromptDraft } from "../src/components/shell/prompt-history-store";

function createIndexedDB(): IDBFactory {
	const stores = new Map<string, Map<IDBValidKey, Record<string, unknown>>>();
	const keyPaths = new Map<string, string>();
	let version = 0;

	const database = {
		objectStoreNames: { contains: (name: string): boolean => stores.has(name) },
		createObjectStore(name: string, options: { keyPath: string }) {
			stores.set(name, new Map());
			keyPaths.set(name, options.keyPath);
			return { createIndex: () => undefined };
		},
		transaction(name: string) {
			const transaction: { oncomplete: (() => void) | null; onabort: (() => void) | null } = {
				oncomplete: null,
				onabort: null,
			};
			const values = stores.get(name);
			if (!values) throw new Error(`Unknown object store ${name}`);
			const request = (read: () => unknown): { result?: unknown; onsuccess: (() => void) | null } => {
				const result: { result?: unknown; onsuccess: (() => void) | null } = { onsuccess: null };
				queueMicrotask(() => {
					result.result = read();
					result.onsuccess?.();
					transaction.oncomplete?.();
				});
				return result;
			};
			return {
				objectStore: (storeName: string) => {
					const storeValues = stores.get(storeName);
					if (!storeValues) throw new Error(`Unknown object store ${storeName}`);
					return {
						get: (key: IDBValidKey) => request(() => storeValues.get(key)),
						put: (record: Record<string, unknown>) => {
							storeValues.set(record[keyPaths.get(storeName)!] as IDBValidKey, record);
							return request(() => undefined);
						},
						delete: (key: IDBValidKey) => {
							storeValues.delete(key);
							return request(() => undefined);
						},
					};
				},
			};
		},
	};

	return {
		open(_name: string, requestedVersion?: number) {
			const openRequest: {
				result?: typeof database;
				onupgradeneeded: (() => void) | null;
				onsuccess: (() => void) | null;
			} = { onupgradeneeded: null, onsuccess: null };
			queueMicrotask(() => {
				openRequest.result = database;
				if ((requestedVersion ?? version) > version) {
					version = requestedVersion ?? version;
					openRequest.onupgradeneeded?.();
				}
				openRequest.onsuccess?.();
			});
			return openRequest;
		},
	} as unknown as IDBFactory;
}

const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

beforeAll(() => {
	Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: createIndexedDB() });
});

afterAll(() => {
	if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
	else Reflect.deleteProperty(globalThis, "indexedDB");
});

describe("composer draft storage", () => {
	it("isolates drafts by room", async () => {
		await savePromptDraft("room-a", "draft for A");
		await savePromptDraft("room-b", "draft for B");

		expect(await loadPromptDraft("room-a")).toBe("draft for A");
		expect(await loadPromptDraft("room-b")).toBe("draft for B");
	});

	it("restores the latest unsent draft", async () => {
		await savePromptDraft("room-a", "first version");
		await savePromptDraft("room-a", "unfinished prompt");

		expect(await loadPromptDraft("room-a")).toBe("unfinished prompt");
	});

	it("clears only the selected room draft", async () => {
		await savePromptDraft("room-a", "sent prompt");
		await savePromptDraft("room-b", "still unsent");

		await clearPromptDraft("room-a");

		expect(await loadPromptDraft("room-a")).toBeNull();
		expect(await loadPromptDraft("room-b")).toBe("still unsent");
	});
});
