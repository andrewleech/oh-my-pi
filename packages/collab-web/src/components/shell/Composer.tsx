import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject, TouchEvent } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import { parseCollabLink } from "../../lib/link";
import { loadPromptHistory, savePromptHistory } from "./prompt-history-store";
import {
	mergePromptHistory,
	navigatePromptHistory,
	promptHistorySwipeDirection,
	transcriptPrompts,
	type PromptHistoryCursor,
	type PromptHistoryItem,
} from "./prompt-history";

export interface ComposerProps {
	client: GuestClient;
	phase: ConnectionPhase;
	readOnly: boolean;
	entries: readonly SessionEntry[];
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;
function mergeStoredHistory(
	current: readonly PromptHistoryItem[],
	incoming: readonly PromptHistoryItem[],
): PromptHistoryItem[] {
	const byId = new Map(current.map(item => [item.id, item]));
	for (const item of incoming) byId.set(item.id, item);
	return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	entries,
	uiRequest,
	working,
	queuedMessageCount,
}: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [submittedHistory, setSubmittedHistory] = useState<PromptHistoryItem[]>([]);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [savingPrompt, setSavingPrompt] = useState(false);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const sendingPrompt = useRef(false);
	const mounted = useRef(true);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const roomId = useMemo(() => {
		if (typeof window === "undefined") return null;
		const link = window.location.hash.slice(1);
		if (!link) return null;
		const parsed = parseCollabLink(link);
		return "error" in parsed ? null : parsed.roomId;
	}, []);
	const promptHistory = useMemo(
		() => mergePromptHistory(transcriptPrompts(entries), submittedHistory),
		[entries, submittedHistory],
	);
	const historyCursor = useRef<PromptHistoryCursor>({ index: -1, draft: "" });
	const touchStart = useRef<{ x: number; y: number } | null>(null);
	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const queued = queuedMessageCount;
	const canSend = canPrompt && text.trim().length > 0 && !savingPrompt;

	useEffect(() => {
		let active = true;
		setSubmittedHistory([]);
		setHistoryError(null);
		if (!roomId) return;
		void loadPromptHistory(roomId)
			.then(items => {
				if (active) setSubmittedHistory(current => mergeStoredHistory(current, items));
			})
			.catch(() => {
				if (active) setHistoryError("Previously saved prompt history could not be loaded.");
			});
		return () => {
			active = false;
		};
	}, [roomId]);

	useEffect(
		() => () => {
			mounted.current = false;
		},
		[],
	);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const send = useCallback(async (): Promise<void> => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly || sendingPrompt.current) return;
		if (!roomId) {
			setHistoryError("This session link is unavailable, so the prompt could not be saved or sent.");
			return;
		}
		sendingPrompt.current = true;
		setSavingPrompt(true);
		setHistoryError(null);
		const item: PromptHistoryItem = { id: crypto.randomUUID(), text: trimmed, createdAt: Date.now() };
		try {
			await savePromptHistory(roomId, item);
			if (!mounted.current) return;
			setSubmittedHistory(current => [...current, item]);
			client.sendPrompt(trimmed);
			setText("");
			historyCursor.current = { index: -1, draft: "" };
		} catch {
			if (mounted.current) {
				setHistoryError(
					"The prompt was not sent because it could not be saved in browser history. The text is still in the composer.",
				);
			}
		} finally {
			sendingPrompt.current = false;
			if (mounted.current) setSavingPrompt(false);
		}
	}, [client, live, readOnly, roomId, text]);

	const navigateHistory = (direction: "up" | "down"): boolean => {
		const next = navigatePromptHistory(historyCursor.current, direction, promptHistory, text);
		if (next === null) return false;
		historyCursor.current = next.cursor;
		setText(next.text);
		return true;
	};

	const onTextChange = (value: string): void => {
		setText(value);
		setHistoryError(null);
		if (historyCursor.current.index === -1) historyCursor.current = { ...historyCursor.current, draft: value };
	};

	const onTouchStart = (event: TouchEvent<HTMLTextAreaElement>): void => {
		const touch = event.touches[0];
		touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
	};

	const onTouchMove = (event: TouchEvent<HTMLTextAreaElement>): void => {
		const start = touchStart.current;
		const touch = event.touches[0];
		if (!start || !touch) return;
		const direction = promptHistorySwipeDirection(start.x, start.y, touch.clientX, touch.clientY);
		if (direction && navigateHistory(direction)) touchStart.current = null;
	};

	const onTouchEnd = (event: TouchEvent<HTMLTextAreaElement>): void => {
		const start = touchStart.current;
		touchStart.current = null;
		const touch = event.changedTouches[0];
		if (!start || !touch) return;
		const direction = promptHistorySwipeDirection(start.x, start.y, touch.clientX, touch.clientY);
		if (direction) navigateHistory(direction);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (
			e.key === "ArrowUp" &&
			!e.shiftKey &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			(historyCursor.current.index !== -1 ||
				!e.currentTarget.value.includes("\n") ||
				e.currentTarget.selectionStart === 0) &&
			navigateHistory("up")
		) {
			e.preventDefault();
			return;
		}
		if (
			e.key === "ArrowDown" &&
			!e.shiftKey &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			(historyCursor.current.index !== -1 ||
				!e.currentTarget.value.includes("\n") ||
				e.currentTarget.selectionEnd === e.currentTarget.value.length) &&
			navigateHistory("down")
		) {
			e.preventDefault();
			return;
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => onTextChange(e.target.value)}
					onKeyDown={onKeyDown}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
					onTouchCancel={() => {
						touchStart.current = null;
					}}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "Read-only session — watching only"
							: live
								? "Prompt the host agent…"
								: "Waiting for the session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
			{historyError && (
				<div className="sh-history-error" role="alert">
					{historyError}
				</div>
			)}
		</div>
	);
});
