/**
 * Harness for side request integration tests: a real `AgentSession` (scripted mock provider, persisted
 * session manager, real tools) shared through a real `CollabHost` over the in-memory relay. Nothing about the
 * side request path is replaced: `startSideRequest`, the agent registry and lifecycle, the session files and the
 * wire all run for real. Only the model provider is scripted.
 */
import { vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost, type CollabHostOptions } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./in-memory-relay";
import { waitFor } from "./throttled-host";

/** The parent starts on this model; tests switch it to {@link SWITCHED_MODEL} to prove the child copies the live one. */
export const START_MODEL = getBundledModel("openai", "gpt-4o-mini");
export const SWITCHED_MODEL = getBundledModel("openai", "gpt-4o");

/** One scripted provider response, or a function that decides when to answer (to hold a turn open). */
export type Scripted = MockResponse | (() => MockResponse | Promise<MockResponse>);

export interface ProviderRequest {
	modelId: string;
	sessionId: string | undefined;
	context: Context;
}

/** Message text without the dated `<system-reminder>` a session's first user message carries. */
function text(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const raw =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	return raw.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>/, "");
}

/** Role and text of a conversation: the shape two views of one history must agree on. */
export function transcript(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => `${message.role}: ${text(message)}`);
}

export interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	welcome(): Extract<CollabFrame, { t: "welcome" }>;
	results(): Extract<CollabFrame, { t: "side-request-result" }>[];
	errors(): string[];
	/** The newest `agents` list the host sent (the welcome's until a broadcast arrives). */
	agents(): Extract<CollabFrame, { t: "welcome" }>["agents"];
	/** Send a `side-request` frame and wait for the host's targeted answer. */
	sideRequest(
		text: string,
		images?: Extract<CollabFrame, { t: "side-request" }>["images"],
	): Promise<Extract<CollabFrame, { t: "side-request-result" }>>;
	chat(agentId: string, text: string): void;
	/** Whole JSONL transcript the host serves for `agentId`. */
	fetchTranscript(agentId: string): Promise<string>;
	/** Resolves once a reply that follows every earlier reply to this guest has arrived. */
	barrier(): Promise<void>;
}

export interface SideRequestHarness {
	dir: TempDir;
	session: AgentSession;
	ctx: InteractiveModeContext;
	host: CollabHost;
	script: { parent: Scripted[]; side: Scripted[] };
	/** Every provider request, parent and children, in order. */
	requests: ProviderRequest[];
	parentRequests(): ProviderRequest[];
	sideRequests(): ProviderRequest[];
	/** Live session of a registered agent. */
	live(id: string): AgentSession;
	/** Ids of agents in the registry other than the main one. */
	childIds(): string[];
	join(link: string, name: string, writeTokenOverride?: string): Promise<TestGuest>;
	[Symbol.asyncDispose](): Promise<void>;
}

export async function startSideRequestHost(
	options: { persisted?: boolean; customTools?: sdk.CustomTool[]; host?: CollabHostOptions } = {},
): Promise<SideRequestHarness> {
	installInMemoryRelay();
	const dir = TempDir.createSync("@omp-side-request-collab-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("openai", "test-key");
	const script = { parent: [] as Scripted[], side: [] as Scripted[] };
	const requests: ProviderRequest[] = [];
	const parent: { sessionId?: string } = {};
	const isParent = (sessionId: string | undefined) => sessionId === parent.sessionId;
	const mock = createMockModel({
		handler: (_context: Context, requestOptions?: SimpleStreamOptions) => {
			const queue = isParent(requestOptions?.sessionId) ? script.parent : script.side;
			const next = queue.shift();
			return typeof next === "function" ? next() : (next ?? { content: ["ok"] });
		},
	});
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(requested: Model, context, requestOptions) => {
				requests.push({ modelId: requested.id, sessionId: requestOptions?.sessionId, context });
				return mock.stream(requested, context, requestOptions);
			},
			slow,
		),
	);
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"task.agentIdleTtlMs": 0,
	});
	const { session } = await sdk.createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage: auth,
		model: START_MODEL,
		settings,
		sessionManager:
			options.persisted === false
				? SessionManager.inMemory(dir.path())
				: SessionManager.create(dir.path(), dir.join("sessions")),
		systemPrompt: ["Parent prompt"],
		toolNames: ["read", "write", "bash", ...(options.customTools?.map(tool => tool.name) ?? [])],
		customTools: options.customTools,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	});
	parent.sessionId = session.sessionId;
	const bus = new EventBus();
	const ctx = {
		session,
		sessionManager: session.sessionManager,
		settings,
		eventBus: bus,
		subagentEventBus: bus,
		updatePendingMessagesDisplay: () => {},
		showStatus: () => {},
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const host = new CollabHost(ctx, options.host);
	await host.start("ws://localhost:8787");

	const sockets: CollabSocket[] = [];
	let barrierId = 1_000_000;
	let sideReqId = 0;
	async function join(link: string, name: string, writeTokenOverride?: string): Promise<TestGuest> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken =
			writeTokenOverride ?? (parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		sockets.push(socket);
		const frames: CollabFrame[] = [];
		socket.onFrame = frame => frames.push(frame);
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
		socket.connect();
		await waitFor(() => frames.some(frame => frame.t === "welcome"), `${name} was never welcomed`);
		const results = () => frames.filter(frame => frame.t === "side-request-result");
		const guest: TestGuest = {
			socket,
			frames,
			welcome() {
				const found = frames.find(frame => frame.t === "welcome");
				if (found?.t !== "welcome") throw new Error("guest was never welcomed");
				return found;
			},
			results,
			errors: () => frames.flatMap(frame => (frame.t === "error" ? [frame.message] : [])),
			agents() {
				const latest = frames.findLast(frame => frame.t === "agents" || frame.t === "welcome");
				return latest?.t === "agents" || latest?.t === "welcome" ? latest.agents : [];
			},
			async sideRequest(body, images) {
				const reqId = ++sideReqId;
				socket.send({ t: "side-request", reqId, text: body, ...(images ? { images } : {}) });
				await waitFor(() => results().some(frame => frame.reqId === reqId), `no result for side request ${reqId}`);
				return results().find(frame => frame.reqId === reqId)!;
			},
			chat(agentId, body) {
				socket.send({ t: "agent-cmd", cmd: "chat", agentId, text: body });
			},
			async fetchTranscript(agentId) {
				const reqId = ++barrierId;
				socket.send({ t: "fetch-transcript", reqId, agentId, fromByte: 0 });
				await waitFor(
					() => frames.some(frame => frame.t === "transcript" && frame.reqId === reqId),
					"transcript reply never arrived",
				);
				const reply = frames.find(frame => frame.t === "transcript" && frame.reqId === reqId);
				if (reply?.t !== "transcript") throw new Error("unreachable");
				if (reply.error) throw new Error(reply.error);
				return reply.text;
			},
			async barrier() {
				const reqId = ++barrierId;
				socket.send({ t: "fetch-transcript", reqId, agentId: "barrier", fromByte: 0 });
				await waitFor(
					() => frames.some(frame => frame.t === "transcript" && frame.reqId === reqId),
					"barrier reply never arrived",
				);
			},
		};
		return guest;
	}

	return {
		dir,
		session,
		ctx,
		host,
		script,
		requests,
		parentRequests: () => requests.filter(request => isParent(request.sessionId)),
		sideRequests: () => requests.filter(request => !isParent(request.sessionId)),
		live(id) {
			const found = AgentRegistry.global().get(id)?.session;
			if (!found) throw new Error(`Agent ${id} has no live session`);
			return found as AgentSession;
		},
		childIds: () =>
			AgentRegistry.global()
				.list()
				.map(ref => ref.id)
				.filter(id => id !== MAIN_AGENT_ID),
		join,
		async [Symbol.asyncDispose]() {
			for (const socket of sockets) socket.close();
			await host.stop("test done");
			for (const ref of AgentRegistry.global().list()) {
				if (ref.id !== MAIN_AGENT_ID) await ref.session?.dispose();
			}
			await session.dispose();
			auth.close();
			dir[Symbol.dispose]();
			vi.restoreAllMocks();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			uninstallInMemoryRelay();
		},
	};
}
