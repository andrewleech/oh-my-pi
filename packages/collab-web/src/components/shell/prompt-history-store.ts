import type { PromptHistoryItem } from "./prompt-history";

const DB_NAME = "omp-collab-guest";
const DB_VERSION = 1;
const STORE_NAME = "prompt-history";

interface StoredPrompt extends PromptHistoryItem {
	roomId: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise;
	if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));

	databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
				store.createIndex("roomId", "roomId");
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open prompt history"));
		request.onblocked = () => reject(new Error("Prompt history is blocked by another tab"));
	});
	void databasePromise.catch(() => {
		databasePromise = null;
	});
	return databasePromise;
}

export async function loadPromptHistory(roomId: string): Promise<PromptHistoryItem[]> {
	const db = await openDatabase();
	return new Promise((resolve, reject) => {
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
	});
}

export async function savePromptHistory(roomId: string, item: PromptHistoryItem): Promise<void> {
	const db = await openDatabase();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).add({ ...item, roomId } satisfies StoredPrompt);
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? new Error("Could not save prompt history"));
		transaction.onerror = () => reject(transaction.error ?? new Error("Could not save prompt history"));
	});
}
