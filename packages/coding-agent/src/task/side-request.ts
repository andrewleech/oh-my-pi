import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { InteractiveModeContext } from "../modes/types";
import sideRequestContextPrompt from "../prompts/system/side-request-context.md" with { type: "text" };
import sideRequestTaskPrompt from "../prompts/system/side-request-task.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, subagentTaskDepth } from "../registry/agent-registry";
import * as sdk from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { ArtifactManagerApi } from "../session/artifacts";
import type { SessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import type { ApprovalMode } from "../tools/approval";
import { cfgToolsApprovalMode } from "../tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import { attachIrcWakeTurnMonitor, createSubagentSettings, followMCPTools, type MCPToolFollower } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { cfgTaskAgentIdleTtlMs, cfgTaskEnableLsp } from "./settings";

const SIDE_REQUEST_ID = "SideRequest";
const SIDE_REQUEST_LABEL_LENGTH = 80;

/** Live side request subagents one host runs at once. */
export const MAX_SIDE_REQUEST_CHILDREN = 8;
/** How long a child may take to start its first request. */
export const SIDE_REQUEST_START_TIMEOUT_MS = 120_000;

export interface SideRequestResult {
	agentId: string;
}

export interface SideRequestOptions {
	/** Defaults to {@link SIDE_REQUEST_START_TIMEOUT_MS}. */
	startTimeoutMs?: number;
	/** Defaults to {@link MAX_SIDE_REQUEST_CHILDREN}. */
	maxChildren?: number;
}

/**
 * A failure whose message is safe and actionable for the requester. Any other error out of
 * {@link startSideRequest} is internal: callers must not show its message.
 */
export class SideRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SideRequestError";
	}
}

interface ChildTally {
	/** Requests past the limit check that have not finished starting. */
	pending: number;
	ids: Set<string>;
}

const tallies = new WeakMap<InteractiveModeContext, ChildTally>();

/** Children a host runs now: starting ones and those whose session is still live. */
function liveChildren(tally: ChildTally): number {
	const registry = AgentRegistry.global();
	let live = 0;
	for (const id of tally.ids) {
		const ref = registry.get(id);
		// A parked child keeps its id: a message revives it, and it counts again.
		if (!ref) tally.ids.delete(id);
		else if (ref.session) live++;
	}
	return tally.pending + live;
}

/** Tool fields a model sees; the child advertises the parent's values for them. */
const DEFINITION_FIELDS = [
	"description",
	"parameters",
	"strict",
	"deferLoading",
	"customFormat",
	"customWireName",
	"native",
	"examples",
] as const;

type ToolDefinition = Pick<AgentTool, "name" | (typeof DEFINITION_FIELDS)[number]>;

/** What the child starts from; every field is read from the parent before the first await. */
interface SideRequestSnapshot {
	task: string;
	images: ImageContent[] | undefined;
	model: NonNullable<AgentSession["model"]>;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
	systemPrompt: string[];
	toolNames: string[];
	mountedToolNames: string[];
	toolDefinitions: ToolDefinition[];
	headlessAsk: boolean;
	/** Persisted parent entry the child's history ends at; `null` for an empty history. */
	leafId: string | null;
	parentFile: string;
	parentSessionId: string;
	parentAgentId: string;
	promptCacheKey: string | undefined;
	taskPromptCacheKey: string | undefined;
	cwd: string;
	artifactsDir: string | null;
	localSessionId: string;
	preparedExtensions: AgentSession["preparedExtensions"];
	extensionPaths: AgentSession["extensionPaths"];
	extensionRoots: AgentSession["effectiveExtensionRoots"];
	mnemopiState: MnemopiSessionState | undefined;
	costGate: AgentSession["costGate"];
	modelRegistry: AgentSession["modelRegistry"];
	asyncJobManager: AgentSession["asyncJobManager"];
	agentOutputManager: AgentOutputManager | undefined;
	artifactManager: ArtifactManagerApi;
	approvalMode: ApprovalMode;
	taskDepth: number;
}

/**
 * Entry the child's history ends at: the end of `branch`, unless its last assistant message
 * made tool calls that have no result yet. That batch is still running in the parent, so the
 * child starts before it and holds no call without a result.
 */
function sideRequestLeafId(branch: readonly SessionEntry[]): string | null {
	const tail = branch.at(-1)?.id ?? null;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const calls = entry.message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []));
		if (calls.length === 0) return tail;
		const answered = new Set<string>();
		for (const later of branch.slice(index + 1)) {
			if (later.type === "message" && later.message.role === "toolResult") answered.add(later.message.toolCallId);
		}
		return calls.every(id => answered.has(id)) ? tail : entry.parentId;
	}
	return tail;
}

function toolDefinition(tool: AgentTool): ToolDefinition {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: tool.strict,
		deferLoading: tool.deferLoading,
		customFormat: tool.customFormat,
		customWireName: tool.customWireName,
		native: tool.native,
		examples: tool.examples,
	};
}

/** Read everything the child inherits. Synchronous: the parent keeps running while the child is set up. */
function captureSnapshot(
	ctx: InteractiveModeContext,
	request: { text: string; images?: ImageContent[] },
): SideRequestSnapshot {
	const task = request.text.trim();
	if (!task) throw new SideRequestError("Side request is empty");
	const parent = ctx.session;
	const parentManager = ctx.sessionManager;
	const model = parent.model;
	if (!model) throw new SideRequestError("Side request needs an active model");
	const parentFile = parentManager.getSessionFile();
	if (!parentFile) throw new SideRequestError("Side requests need a persisted session");
	const header = parentManager.getHeader();
	const taskPromptCacheKey = header?.taskPromptCacheKey;
	return {
		task,
		images: request.images?.length ? request.images.map(image => ({ ...image })) : undefined,
		model,
		thinkingLevel: parent.configuredThinkingLevel(),
		systemPrompt: [...parent.systemPrompt],
		toolNames: parent.getEnabledToolNames(),
		mountedToolNames: parent.getMountedToolCommandNames(),
		toolDefinitions: parent.agent.state.tools.map(toolDefinition),
		headlessAsk: parent.getActiveToolNames().includes("ask"),
		leafId: sideRequestLeafId(parentManager.getBranchView()),
		parentFile,
		parentSessionId: parent.sessionId,
		parentAgentId: parent.getAgentId() ?? MAIN_AGENT_ID,
		// Explicit keys stay pinned; an automatic one stays model-gated in the child.
		promptCacheKey: parent.agent.promptCacheKey ?? (taskPromptCacheKey === undefined ? parent.sessionId : undefined),
		taskPromptCacheKey,
		cwd: parentManager.getCwd(),
		artifactsDir: parentManager.getArtifactsDir(),
		localSessionId: parentManager.getSessionId(),
		preparedExtensions: parent.preparedExtensions,
		extensionPaths: parent.extensionPaths,
		extensionRoots: parent.effectiveExtensionRoots,
		mnemopiState: parent.getMnemopiSessionState?.(),
		costGate: parent.costGate,
		modelRegistry: parent.modelRegistry,
		asyncJobManager: parent.asyncJobManager,
		agentOutputManager: parent.agentOutputManager,
		artifactManager: parentManager.getArtifactManager(),
		approvalMode: cfgToolsApprovalMode.get(ctx.settings),
		taskDepth: subagentTaskDepth(AgentRegistry.global(), parent.getAgentId() ?? MAIN_AGENT_ID),
	};
}

/**
 * Make the child's own tools advertise the parent's definitions. The tool objects stay the
 * child's, so every call runs in the child's session; a parent tool the child lacks fails the request.
 */
function bindToolDefinitions(session: AgentSession, definitions: readonly ToolDefinition[]): void {
	const tools = new Map(session.agent.state.tools.map(tool => [tool.name, tool]));
	for (const definition of definitions) {
		const tool = tools.get(definition.name);
		if (!tool) throw new SideRequestError(`Side request cannot bind tool "${definition.name}" in the new session`);
		try {
			for (const field of DEFINITION_FIELDS) {
				Object.defineProperty(tool, field, {
					value: definition[field],
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		} catch (error) {
			logger.warn("Side request tool binding failed", { tool: definition.name, error: String(error) });
			throw new SideRequestError(`Side request cannot bind tool "${definition.name}" in the new session`);
		}
	}
}

const outputManagers = new WeakMap<SessionManager, AgentOutputManager>();

async function allocateAgentId(
	ids: AgentOutputManager | undefined,
	parentManager: SessionManager,
	settings: Settings,
	sessionDir: string,
): Promise<string> {
	if (!ids) {
		ids = outputManagers.get(parentManager);
		if (!ids) {
			ids = new AgentOutputManager(() => sessionDir, { settings });
			outputManagers.set(parentManager, ids);
		}
	}
	await ids.reserve(
		AgentRegistry.global()
			.list()
			.map(ref => ref.id),
	);
	return ids.allocate(SIDE_REQUEST_ID);
}

/** The session file, its artifacts directory and the lock files its storage leaves beside it. */
async function removeSessionFiles(sessionFile: string): Promise<void> {
	const dir = path.dirname(sessionFile);
	const name = path.basename(sessionFile);
	const locks = (await fs.readdir(dir).catch(() => [])).filter(entry => entry.startsWith(`.${name}.`));
	await Promise.allSettled([
		fs.rm(sessionFile, { force: true }),
		fs.rm(sessionFile.slice(0, -".jsonl".length), { recursive: true, force: true }),
		...locks.map(lock => fs.rm(path.join(dir, lock), { force: true })),
	]);
}

/**
 * Start an independent interactive subagent from the parent's current conversation.
 *
 * The snapshot (model, system prompt, tool set, persisted conversation) is read before the
 * first await. The child has its own session file, registry entry, tools and provider session,
 * and takes later messages through the normal agent lifecycle. It shares the parent's working
 * directory. Nothing is sent to the parent: its turn, queue, transcript and status are untouched.
 *
 * Resolves once the child is registered and its first request is dispatched, not when it
 * finishes. Anything created is removed again when setup fails.
 */
export async function startSideRequest(
	ctx: InteractiveModeContext,
	request: { text: string; images?: ImageContent[] },
	options: SideRequestOptions = {},
): Promise<SideRequestResult> {
	const snapshot = captureSnapshot(ctx, request);
	const maxChildren = options.maxChildren ?? MAX_SIDE_REQUEST_CHILDREN;
	let tally = tallies.get(ctx);
	if (!tally) {
		tally = { pending: 0, ids: new Set() };
		tallies.set(ctx, tally);
	}
	if (liveChildren(tally) >= maxChildren) {
		throw new SideRequestError(`Too many side request subagents are running (limit ${maxChildren})`);
	}
	// Counted from here to the end of the start, with no await between the check and the claim.
	tally.pending++;
	let started: string | undefined;
	try {
		started = await start(ctx, snapshot, options.startTimeoutMs ?? SIDE_REQUEST_START_TIMEOUT_MS);
		tally.ids.add(started);
		return { agentId: started };
	} finally {
		tally.pending--;
	}
}

async function start(
	ctx: InteractiveModeContext,
	snapshot: SideRequestSnapshot,
	startTimeoutMs: number,
): Promise<string> {
	const parentManager = ctx.sessionManager;
	const sessionDir = snapshot.parentFile.slice(0, -".jsonl".length);
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const label = oneLineLabel(snapshot.task, SIDE_REQUEST_LABEL_LENGTH);
	const displayName = `Side request: ${label}`;

	let sessionFile: string | undefined;
	let manager: SessionManager | undefined;
	let follower: MCPToolFollower | undefined;
	let clone: AgentSession | undefined;
	let id: string | undefined;
	let adopted = false;
	try {
		await parentManager.ensureOnDisk();
		await parentManager.flush();
		id = await allocateAgentId(snapshot.agentOutputManager, parentManager, ctx.settings, sessionDir);
		sessionFile = path.join(sessionDir, `${id}.jsonl`);
		manager = await SessionManager.forkFrom(snapshot.parentFile, snapshot.cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile,
			resetInheritedCost: true,
			leafId: snapshot.leafId,
		});
		// The child spills and resolves artifacts where the parent does, live and after a revival.
		manager.adoptArtifactManager(snapshot.artifactManager);
		manager.appendMessage({
			role: "developer",
			content: prompt.render(sideRequestContextPrompt, {}),
			attribution: "agent",
			timestamp: Date.now(),
		});
		follower = ctx.mcpManager ? followMCPTools(ctx.mcpManager, { scope: manager.getSessionId() }) : undefined;
		const created = await sdk.createAgentSession({
			cwd: snapshot.cwd,
			costGate: snapshot.costGate,
			sessionManager: manager,
			model: snapshot.model,
			thinkingLevel: snapshot.thinkingLevel,
			systemPrompt: snapshot.systemPrompt,
			toolNames: snapshot.toolNames,
			mountedToolNames: snapshot.mountedToolNames,
			advertiseHeadlessAsk: snapshot.headlessAsk,
			providerSessionId: `${snapshot.parentSessionId}:side:${Snowflake.next()}`,
			providerPromptCacheKey: snapshot.promptCacheKey,
			taskPromptCacheKey: snapshot.taskPromptCacheKey,
			modelRegistry: snapshot.modelRegistry,
			authStorage: snapshot.modelRegistry.authStorage,
			// No UI answers a prompt in the child: a tool the parent's mode gates fails instead of running.
			settings: createSubagentSettings(ctx.settings, { "tools.approvalMode": snapshot.approvalMode }),
			hasUI: false,
			enableMCP: false,
			mcpTools: follower?.proxyTools(),
			mcpToolScope: follower?.scope,
			enableLsp: cfgTaskEnableLsp.get(ctx.settings) !== false,
			agentId: id,
			agentDisplayName: displayName,
			parentTaskPrefix: id,
			parentAgentId: snapshot.parentAgentId,
			taskDepth: snapshot.taskDepth,
			asyncJobManager: snapshot.asyncJobManager,
			subagentEventBus: ctx.subagentEventBus,
			disableExtensionDiscovery: true,
			preloadedPreparedExtensions: snapshot.preparedExtensions?.length ? snapshot.preparedExtensions : undefined,
			preloadedExtensionPaths: snapshot.extensionPaths?.length ? [...snapshot.extensionPaths] : undefined,
			extensionRoots: () => snapshot.extensionRoots,
			localProtocolOptions: {
				getArtifactsDir: () => snapshot.artifactsDir,
				getSessionId: () => snapshot.localSessionId,
			},
			parentMnemopiSessionState: snapshot.mnemopiState,
		});
		clone = created.session;
		await clone.setActiveToolPresentation(snapshot.toolNames, snapshot.mountedToolNames);
		bindToolDefinitions(clone, snapshot.toolDefinitions);
		follower?.bind(clone);
		// The parent's todo list is the parent's: its reminders would pull the child onto the parent's work.
		clone.setTodoPhases([]);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		manager.appendSessionInit({
			systemPrompt: snapshot.systemPrompt,
			task: snapshot.task,
			tools: clone.getEnabledToolNames(),
			mountedTools: clone.getMountedToolCommandNames(),
			resolvedModel: formatModelStringWithRouting(snapshot.model),
			spawns: "*",
			approvalMode: snapshot.approvalMode,
			reportToOwner: false,
		});
		const ref = registry.get(id);
		if (!ref || ref.session !== clone) throw new Error(`Side request agent ${id} was not registered`);
		registry.syncSessionStatus(id, clone);
		// Lifecycle and progress frames for the child's turns, without a result for the parent.
		attachIrcWakeTurnMonitor(clone, {
			id,
			agent: {
				name: displayName,
				description: label,
				systemPrompt: snapshot.systemPrompt.join("\n\n"),
				source: "user",
			},
			description: displayName,
			eventBus: ctx.eventBus,
			subagentEventBus: ctx.subagentEventBus,
			sessionFile,
			artifactsDir: sessionDir,
			reportToOwner: false,
		});
		lifecycle.adopt(
			id,
			{
				idleTtlMs: Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(ctx.settings)) || 0),
				onRelease: async () => follower?.dispose(),
			},
			ref,
		);
		adopted = true;
		await dispatchFirstRequest(clone, snapshot, id, startTimeoutMs);
		return id;
	} catch (error) {
		await discard({ id, adopted, clone, follower, manager, sessionFile });
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Send the side task as the child's first prompt and wait for its run to start. The message states
 * that the history above is the parent's, then carries the task as typed: no slash command,
 * extension command or template runs for it.
 */
async function dispatchFirstRequest(
	clone: AgentSession,
	snapshot: SideRequestSnapshot,
	id: string,
	timeoutMs: number,
): Promise<void> {
	const dispatched = Promise.withResolvers<void>();
	let started = false;
	const unsubscribe = clone.subscribe(event => {
		if (event.type !== "agent_start") return;
		started = true;
		dispatched.resolve();
	});
	const timer = setTimeout(() => {
		dispatched.reject(new SideRequestError("Side request did not start in time"));
	}, timeoutMs);
	clone
		.prompt(prompt.render(sideRequestTaskPrompt, { task: snapshot.task }), {
			attribution: "user",
			images: snapshot.images,
			expandPromptTemplates: false,
			runCommands: false,
		})
		.then(
			() => {
				if (!started) dispatched.reject(new SideRequestError("Side request did not start"));
			},
			error => {
				if (started) logger.warn("Side request failed", { id, error: String(error) });
				else dispatched.reject(error);
			},
		);
	try {
		await dispatched.promise;
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}

async function discard(created: {
	id: string | undefined;
	adopted: boolean;
	clone: AgentSession | undefined;
	follower: MCPToolFollower | undefined;
	manager: SessionManager | undefined;
	sessionFile: string | undefined;
}): Promise<void> {
	const { id, clone, follower, manager, sessionFile } = created;
	try {
		if (created.adopted && id) {
			// Ends the live session, unregisters the agent and runs the adoption's release hook.
			await AgentLifecycleManager.global().release(id);
		} else if (clone) {
			await clone.dispose();
		} else {
			await manager?.close();
		}
	} catch (error) {
		logger.warn("Side request cleanup failed", { id, error: String(error) });
	} finally {
		follower?.dispose();
		if (sessionFile) await removeSessionFiles(sessionFile);
	}
}
