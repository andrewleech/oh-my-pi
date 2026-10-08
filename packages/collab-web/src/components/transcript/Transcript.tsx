import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import type {
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactNode,
} from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	canRewind?: boolean;
	actionsEnabled?: boolean;
	onRewind?: (entryId: string) => Promise<void>;
	onFork?: (entryId: string, name: string) => Promise<void>;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

function Row({
	kind,
	gutter,
	title,
	entryId,
	children,
	onContextMenu,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	onPointerCancel,
	onKeyDown,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	entryId?: string;
	children: ReactNode;
	onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
	onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}): ReactNode {
	return (
		<div
			className={`tr-row tr-row--${kind}`}
			data-entry-id={entryId}
			tabIndex={onKeyDown === undefined ? undefined : 0}
			aria-haspopup={onContextMenu === undefined ? undefined : "menu"}
			onContextMenu={onContextMenu}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onKeyDown={onKeyDown}
		>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	actionsEnabled: boolean;
	onPromptContextMenu?: (entryId: string, event: ReactMouseEvent<HTMLDivElement>) => void;
	onPromptPointerDown?: (entryId: string, event: ReactPointerEvent<HTMLDivElement>) => void;
	onPromptPointerMove?: (entryId: string, event: ReactPointerEvent<HTMLDivElement>) => void;
	onPromptPointerEnd?: (entryId: string, event: ReactPointerEvent<HTMLDivElement>) => void;
	onPromptKeyboard?: (entryId: string, event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

function isUserPromptTarget(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user";
	return (
		entry.type === "custom_message" &&
		entry.attribution === "user" &&
		(entry.customType === "skill-prompt" || entry.customType === COLLAB_PROMPT_MESSAGE_TYPE)
	);
}
/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (
		prev.entry !== next.entry ||
		prev.host !== next.host ||
		prev.actionsEnabled !== next.actionsEnabled ||
		prev.onPromptContextMenu !== next.onPromptContextMenu ||
		prev.onPromptPointerDown !== next.onPromptPointerDown ||
		prev.onPromptPointerMove !== next.onPromptPointerMove ||
		prev.onPromptPointerEnd !== next.onPromptPointerEnd ||
		prev.onPromptKeyboard !== next.onPromptKeyboard
	)
		return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({
	entry,
	results,
	active,
	host,
	actionsEnabled,
	onPromptContextMenu,
	onPromptPointerDown,
	onPromptPointerMove,
	onPromptPointerEnd,
	onPromptKeyboard,
}: EntryRowProps): ReactNode {
	const promptProps =
		actionsEnabled && isUserPromptTarget(entry)
			? {
					onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => onPromptContextMenu?.(entry.id, event),
					onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onPromptPointerDown?.(entry.id, event),
					onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => onPromptPointerMove?.(entry.id, event),
					onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => onPromptPointerEnd?.(entry.id, event),
					onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => onPromptPointerEnd?.(entry.id, event),
					onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
						if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
							event.preventDefault();
							onPromptKeyboard?.(entry.id, event);
						}
					},
				}
			: {};
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row {...promptProps} kind="user" gutter="host" title={entry.timestamp} entryId={entry.id}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row
						{...promptProps}
						kind="user"
						gutter={<span className="tr-badge">{from}</span>}
						title={entry.timestamp}
						entryId={entry.id}
					>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row {...promptProps} kind="custom" gutter="" title={entry.timestamp} entryId={entry.id}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase } = props;
	const [promptMenu, setPromptMenu] = useState<{ entryId: string; x: number; y: number } | null>(null);
	const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const touchOrigin = useRef<{ x: number; y: number } | null>(null);
	const actionsEnabled =
		props.canRewind === true &&
		props.actionsEnabled !== false &&
		props.onRewind !== undefined &&
		props.onFork !== undefined;
	const openPromptMenu = (entryId: string, x: number, y: number): void => {
		setPromptMenu({ entryId, x, y });
	};
	const onPromptContextMenu = (entryId: string, event: ReactMouseEvent<HTMLDivElement>): void => {
		event.preventDefault();
		openPromptMenu(entryId, event.clientX, event.clientY);
	};
	const onPromptKeyboard = (entryId: string, event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const rect = event.currentTarget.getBoundingClientRect();
		openPromptMenu(entryId, rect.left, rect.bottom);
	};
	const onPromptPointerDown = (entryId: string, event: ReactPointerEvent<HTMLDivElement>): void => {
		if (event.pointerType !== "touch") return;
		touchOrigin.current = { x: event.clientX, y: event.clientY };
		touchTimer.current = setTimeout(() => openPromptMenu(entryId, event.clientX, event.clientY), 600);
	};
	const onPromptPointerMove = (_entryId: string, event: ReactPointerEvent<HTMLDivElement>): void => {
		const origin = touchOrigin.current;
		if (origin !== null && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
			clearTimeout(touchTimer.current);
			touchTimer.current = undefined;
		}
	};
	const onPromptPointerEnd = (): void => {
		clearTimeout(touchTimer.current);
		touchTimer.current = undefined;
		touchOrigin.current = null;
	};

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/**
	 * First visible row and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries.
	 */
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	useEffect(() => {
		if (promptMenu !== null) rootRef.current?.querySelector<HTMLButtonElement>(".tr-prompt-menu button")?.focus();
	}, [promptMenu]);

	useEffect(() => {
		if (!actionsEnabled) setPromptMenu(null);
	}, [actionsEnabled]);

	useEffect(
		() => () => {
			clearTimeout(touchTimer.current);
			touchTimer.current = undefined;
		},
		[],
	);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				updateTranscriptTailLock(el, lockRef);
				// Back at the bottom: drop the pin so the window trims to the tail again.
				if (lockRef.current) {
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start);
				}
				if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
			}}
			onPointerDown={event => {
				if (!(event.target instanceof Element) || !event.target.closest(".tr-prompt-menu")) setPromptMenu(null);
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={showEarlier}>
					show {start.toLocaleString("en-US")} earlier
				</button>
			)}
			{visible.map(entry => (
				<EntryRow
					key={entry.id}
					entry={entry}
					results={results}
					active={activeTools}
					host={host}
					actionsEnabled={actionsEnabled}
					onPromptContextMenu={onPromptContextMenu}
					onPromptPointerDown={onPromptPointerDown}
					onPromptPointerMove={onPromptPointerMove}
					onPromptPointerEnd={onPromptPointerEnd}
					onPromptKeyboard={onPromptKeyboard}
				/>
			))}
			{stream !== null && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
			{promptMenu !== null && actionsEnabled && (
				<div
					className="tr-prompt-menu"
					role="menu"
					aria-label="Prompt actions"
					style={{ left: promptMenu.x, top: promptMenu.y }}
					onKeyDown={event => {
						if (event.key === "Escape") setPromptMenu(null);
					}}
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setPromptMenu(null);
							void props.onRewind?.(promptMenu.entryId);
						}}
					>
						Rewind to here
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							const name = window.prompt("Name this forked session");
							if (name !== null && name.trim() !== "") void props.onFork?.(promptMenu.entryId, name.trim());
							setPromptMenu(null);
						}}
					>
						Fork from here
					</button>
				</div>
			)}
		</div>
	);
}
