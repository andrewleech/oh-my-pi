import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { type CommandSuggestion, commandSuggestions, matchCommand } from "../../lib/commands";
import { CommandResultPanel, CommandSuggestionList } from "./CommandUi";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

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

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	/** Row picked with the arrow keys; `null` shows the first row without an explicit choice. */
	const [highlight, setHighlight] = useState<number | null>(null);
	/** Composer text at which Escape hid the suggestions; they return once the text changes. */
	const [dismissedAt, setDismissedAt] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const listId = useId();
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const commands = snapshot.commands;
	const commandRunning = snapshot.command?.status === "running";
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const trimmed = text.trim();
	const matched = commands ? matchCommand(commands, trimmed) : undefined;
	// One command at a time per guest: a second one waits for the first result.
	const canSend = canPrompt && trimmed.length > 0 && !(matched && commandRunning);

	const suggestions = useMemo(
		() => (commands && text.startsWith("/") ? commandSuggestions(commands, text) : []),
		[commands, text],
	);
	const listOpen = canPrompt && suggestions.length > 0 && dismissedAt !== text;
	const active = Math.min(highlight ?? 0, suggestions.length - 1);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const updateText = (next: string): void => {
		setText(next);
		setHighlight(null);
		setDismissedAt(null);
	};

	const applySuggestion = (suggestion: CommandSuggestion): void => {
		updateText(suggestion.replacement);
		taRef.current?.focus();
	};

	const send = useCallback((): void => {
		if (!canSend) return;
		if (matched) client.sendCommand(trimmed);
		else client.sendPrompt(trimmed);
		setText("");
	}, [canSend, client, matched, trimmed]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		const composing = e.nativeEvent.isComposing || composingRef.current;
		if (listOpen && !composing) {
			const suggestion = suggestions[active]!;
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setHighlight((active + 1) % suggestions.length);
					return;
				case "ArrowUp":
					e.preventDefault();
					setHighlight((active - 1 + suggestions.length) % suggestions.length);
					return;
				case "Tab":
					e.preventDefault();
					applySuggestion(suggestion);
					return;
				case "Escape":
					e.preventDefault();
					setDismissedAt(text);
					return;
				case "Enter": {
					// Enter completes only when that changes the command line, and not
					// right after a typed space unless a row was picked: `/model ` + Enter
					// runs `/model` rather than its first subcommand.
					const changes = suggestion.replacement.trimEnd() !== text.trimEnd();
					if (!e.shiftKey && changes && (highlight !== null || !/\s$/.test(text))) {
						e.preventDefault();
						applySuggestion(suggestion);
						return;
					}
					break;
				}
			}
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
			{snapshot.command && <CommandResultPanel run={snapshot.command} onDismiss={() => client.dismissCommand()} />}
			<div className="sh-composer-field">
				{listOpen && (
					<CommandSuggestionList id={listId} suggestions={suggestions} active={active} onApply={applySuggestion} />
				)}
				<div className="sh-composer-inner">
					<textarea
						ref={taRef}
						className="sh-composer-input"
						value={text}
						onChange={e => updateText(e.target.value)}
						onKeyDown={onKeyDown}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={onCompositionEnd}
						placeholder={
							readOnly
								? "Read-only session — watching only"
								: live
									? commands
										? "Prompt the host agent, or / for commands…"
										: "Prompt the host agent…"
									: "Waiting for the session…"
						}
						disabled={!canPrompt}
						rows={1}
						spellCheck={false}
						aria-autocomplete={commands ? "list" : undefined}
						aria-controls={listOpen ? listId : undefined}
						aria-activedescendant={listOpen ? `${listId}-${active}` : undefined}
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
			</div>
		</div>
	);
}
