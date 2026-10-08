import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { CommandRun } from "../../lib/client";
import type { CommandSuggestion } from "../../lib/commands";

export interface CommandSuggestionListProps {
	/** DOM id of the listbox; option ids are `${id}-${index}`. */
	id: string;
	suggestions: readonly CommandSuggestion[];
	active: number;
	onApply(suggestion: CommandSuggestion): void;
}

/**
 * Slash-command autocomplete listbox shown above the composer input. The
 * textarea keeps focus: it points at the active row through
 * `aria-activedescendant`, and rows apply on click without stealing focus.
 */
export function CommandSuggestionList({ id, suggestions, active, onApply }: CommandSuggestionListProps): ReactNode {
	return (
		<div id={id} className="sh-cmd-list" role="listbox" aria-label="Commands">
			{suggestions.map((suggestion, index) => (
				<div
					key={suggestion.key}
					id={`${id}-${index}`}
					role="option"
					aria-selected={index === active}
					className={`sh-cmd-option${index === active ? " sh-cmd-option-active" : ""}`}
					onMouseDown={e => e.preventDefault()}
					onClick={() => onApply(suggestion)}
				>
					<span className="sh-cmd-option-name">
						{suggestion.label}
						{suggestion.hint && <span className="sh-cmd-option-hint"> {suggestion.hint}</span>}
					</span>
					{suggestion.description && <span className="sh-cmd-option-description">{suggestion.description}</span>}
				</div>
			))}
		</div>
	);
}

const STATUS_LABEL: Record<CommandRun["status"], string> = {
	running: "running…",
	done: "done",
	error: "failed",
};

export interface CommandResultPanelProps {
	run: CommandRun;
	onDismiss(): void;
}

/** Result of the latest guest-run slash command: command line, status, and its output or error. */
export function CommandResultPanel({ run, onDismiss }: CommandResultPanelProps): ReactNode {
	return (
		<section className={`sh-cmd-result sh-cmd-result-${run.status}`} aria-live="polite" aria-label="Command result">
			<div className="sh-cmd-result-head">
				<code className="sh-cmd-result-text">{run.text}</code>
				<span className="sh-cmd-result-status">{STATUS_LABEL[run.status]}</span>
				{run.status !== "running" && (
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-cmd-result-dismiss"
						onClick={onDismiss}
						title="dismiss"
						aria-label="Dismiss command result"
					>
						<X size={14} />
					</button>
				)}
			</div>
			{run.output && <pre className="sh-cmd-result-output">{run.output}</pre>}
		</section>
	);
}
