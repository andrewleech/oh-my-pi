import type { PromptHistoryItem } from "./prompt-history";

const DB_NAME = "omp-collab-guest";
const DB_VERSION = 2;
const STORE_NAME = "prompt-history";
const DRAFT_STORE_NAME = "prompt-drafts";

interface StoredPrompt extends PromptHistoryItem {
	roomId: string;
}

interface StoredDraft {
	roomId: string;
	text: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise;
	if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));

	const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
	databasePromise = promise;
	void promise.catch(() => {
		if (databasePromise === promise) databasePromise = null;
	});
	let request: IDBOpenDBRequest;
	try {
		request = indexedDB.open(DB_NAME, DB_VERSION);
	} catch (error) {
		reject(error);
		return promise;
	}
	request.onupgradeneeded = () => {
		const db = request.result;
		if (!db.objectStoreNames.contains(STORE_NAME)) {
			const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
			store.createIndex("roomId", "roomId");
		}
		if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
			db.createObjectStore(DRAFT_STORE_NAME, { keyPath: "roomId" });
		}
	};
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error ?? new Error("Could not open prompt history"));
	request.onblocked = () => reject(new Error("Prompt history is blocked by another tab"));
	return promise;
}

export async function loadPromptHistory(roomId: string): Promise<PromptHistoryItem[]> {
	const db = await openDatabase();
	const { promise, resolve, reject } = Promise.withResolvers<PromptHistoryItem[]>();
	const transaction = db.transaction(STORE_NAME, "readonly");
	const request = transaction.objectStore(STORE_NAME).index("roomId").getAll(roomId);
	let records: StoredPrompt[] = [];
	request.onsuccess = () => {
		records = request.result as StoredPrompt[];
	};
	request.onerror = () => reject(request.error ?? new Error("Could not load prompt history"));
	transaction.oncomplete = () => {
		records.sort((a, b) => a.createdAt - b.createdAt);
		resolve(records.map(({ id, text, createdAt }) => ({ id, text, createdAt })));
	};
	transaction.onabort = () => reject(transaction.error ?? new Error("Could not load prompt history"));
	return promise;
}

export async function savePromptHistory(roomId: string, item: PromptHistoryItem): Promise<void> {
	const db = await openDatabase();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const transaction = db.transaction(STORE_NAME, "readwrite");
	transaction.objectStore(STORE_NAME).add({ ...item, roomId } satisfies StoredPrompt);
	transaction.oncomplete = () => resolve();
	transaction.onabort = () => reject(transaction.error ?? new Error("Could not save prompt history"));
	transaction.onerror = () => reject(transaction.error ?? new Error("Could not save prompt history"));
	return promise;
}

export async function loadPromptDraft(roomId: string): Promise<string | null> {
	const db = await openDatabase();
	const { promise, resolve, reject } = Promise.withResolvers<string | null>();
	const transaction = db.transaction(DRAFT_STORE_NAME, "readonly");
	const request = transaction.objectStore(DRAFT_STORE_NAME).get(roomId);
	let text: string | null = null;
	request.onsuccess = () => {
		const draft = request.result as StoredDraft | undefined;
		text = draft?.text ?? null;
	};
	request.onerror = () => reject(request.error ?? new Error("Could not load prompt draft"));
	transaction.oncomplete = () => resolve(text);
	transaction.onabort = () => reject(transaction.error ?? new Error("Could not load prompt draft"));
	return promise;
}

export async function savePromptDraft(roomId: string, text: string): Promise<void> {
	const db = await openDatabase();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
	transaction.objectStore(DRAFT_STORE_NAME).put({ roomId, text } satisfies StoredDraft);
	transaction.oncomplete = () => resolve();
	transaction.onabort = () => reject(transaction.error ?? new Error("Could not save prompt draft"));
	transaction.onerror = () => reject(transaction.error ?? new Error("Could not save prompt draft"));
	return promise;
}
export async function clearPromptDraft(roomId: string): Promise<void> {
	const db = await openDatabase();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
	transaction.objectStore(DRAFT_STORE_NAME).delete(roomId);
	transaction.oncomplete = () => resolve();
	transaction.onabort = () => reject(transaction.error ?? new Error("Could not clear prompt draft"));
	transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear prompt draft"));
	return promise;
}
