import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgModelRoleStorage } from "../../src/config/model-settings";
import { ModelRoleApiError } from "../../src/extensibility/extensions/model-role-api";
import { createExtensionModelQuery } from "../../src/extensibility/extensions/model-api";

function model(id: string, name: string, provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const claude = model("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
const claudePrev = model("claude-opus-4-7", "Claude Opus 4.7", "anthropic");
const gpt = model("gpt-5.4", "GPT-5.4", "openai");

const available = [claude, gpt] as Model<Api>[];

/** Minimal registry stub: only the methods the facade and core resolver touch. */
function registry(): ModelRegistry {
	return {
		getAvailable: () => available,
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(claude);
		active = gpt;
		expect(q.current()).toBe(gpt);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = Settings.isolated({ modelRoles: { slow: "anthropic/claude-opus-4-8" } });
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.resolve("@slow")).toBe(claude);
	});

	test("roles() reports persisted role provenance and role-eligible models", async () => {
		using tempDir = TempDir.createSync("@omp-model-role-metadata-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		settings.setModelRole("slow", "anthropic/claude-opus-4-8");
		await settings.flush();

		const roles = await createExtensionModelQuery(registry(), settings, () => claude).roles();
		const slow = roles.roles.find(role => role.id === "slow");
		expect(roles.storage).toBe("global");
		expect(slow).toMatchObject({
			selector: "anthropic/claude-opus-4-8",
			provenance: "global",
			globalSelector: "anthropic/claude-opus-4-8",
		});
		expect(slow?.models.map(candidate => `${candidate.provider}/${candidate.id}`)).toContain(
			"anthropic/claude-opus-4-8",
		);
	});

	test("setRole persists a non-default role without switching the active model", async () => {
		using tempDir = TempDir.createSync("@omp-model-role-nondefault-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		const active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), settings, () => active, {
			setModel: async () => ({ switched: false }),
			setThinkingLevel: () => {},
			getAvailableModels: () => available,
			getScopedModels: () => [],
		});

		const result = await q.setRole("smol", "openai/gpt-5.4");

		expect(settings.getModelRole("smol")).toBe("openai/gpt-5.4");
		expect(active).toBe(claude);
		expect(result.roles.find(role => role.id === "smol")?.selector).toBe("openai/gpt-5.4");
		const persisted = YAML.parse(await Bun.file(tempDir.join("agent/config.yml")).text()) as {
			modelRoles?: Record<string, string>;
		};
		expect(persisted.modelRoles?.smol).toBe("openai/gpt-5.4");
	});

	test("setRole changes the active default model and resets to its persisted fallback", async () => {
		using tempDir = TempDir.createSync("@omp-model-role-default-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		settings.setModelRole("default", "anthropic/claude-opus-4-8");
		await settings.flush();
		cfgModelRoleStorage.set(settings, "project");
		await settings.flush();
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), settings, () => active, {
			setModel: async model => {
				active = model;
				return { switched: true };
			},
			setThinkingLevel: () => {},
			getAvailableModels: () => available,
			getScopedModels: () => [],
		});

		await q.setRole("default", "openai/gpt-5.4");
		expect(active).toBe(gpt);
		expect(settings.getProjectModelRole("default")).toBe("openai/gpt-5.4");
		expect(settings.getGlobalModelRole("default")).toBe("anthropic/claude-opus-4-8");
		const persisted = YAML.parse(await Bun.file(tempDir.join("project/.omp/config.yml")).text()) as {
			modelRoles?: Record<string, string>;
		};
		expect(persisted.modelRoles?.default).toBe("openai/gpt-5.4");

		const reset = await q.setRole("default", null);
		expect(active).toBe(claude);
		expect(settings.getProjectModelRole("default")).toBeUndefined();
		expect(reset.roles.find(role => role.id === "default")?.selector).toBe("anthropic/claude-opus-4-8");
		const reloaded = await Settings.loadIsolated({ cwd, agentDir });
		expect(reloaded.getModelRole("default")).toBe("anthropic/claude-opus-4-8");
		expect(reloaded.getProjectModelRole("default")).toBeUndefined();
	});

	test("setRole rejects invalid assignments without changing persisted roles", async () => {
		using tempDir = TempDir.createSync("@omp-model-role-invalid-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		settings.setModelRole("smol", "anthropic/claude-opus-4-8");
		await settings.flush();
		const q = createExtensionModelQuery(registry(), settings, () => claude, {
			setModel: async () => ({ switched: false }),
			setThinkingLevel: () => {},
			getAvailableModels: () => available,
			getScopedModels: () => [],
		});

		await expect(q.setRole("unknown", "openai/gpt-5.4")).rejects.toBeInstanceOf(ModelRoleApiError);
		await expect(q.setRole("unknown", "openai/gpt-5.4")).rejects.toMatchObject({
			code: "unknown_role",
		});
		await expect(q.setRole("smol", "not-a-selector")).rejects.toMatchObject({
			code: "invalid_selector",
		});
		await expect(q.setRole("speech", "openai/gpt-5.4")).rejects.toMatchObject({
			code: "ineligible_model",
		});
		await expect(q.setRole("smol", "openai/gpt-5.4:high")).rejects.toMatchObject({
			code: "unsupported_thinking_level",
		});
		await expect(q.setRole("smol", "openai/gpt-5.4", "project")).rejects.toMatchObject({
			code: "invalid_scope",
		});

		expect(settings.getModelRole("smol")).toBe("anthropic/claude-opus-4-8");
		const persisted = YAML.parse(await Bun.file(tempDir.join("agent/config.yml")).text()) as {
			modelRoles?: Record<string, string>;
		};
		expect(persisted.modelRoles?.smol).toBe("anthropic/claude-opus-4-8");
	});

	test("concurrent default assignments leave the live and persisted model on the last request", async () => {
		using tempDir = TempDir.createSync("@omp-model-role-concurrent-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let active: Model<Api> = claude;
		const q = createExtensionModelQuery(registry(), settings, () => active, {
			setModel: async next => {
				if (next === gpt) {
					entered.resolve();
					await release.promise;
				}
				active = next;
				return { switched: true };
			},
			setThinkingLevel: () => {},
			getAvailableModels: () => available,
			getScopedModels: () => [],
		});
		const first = q.setRole("default", "openai/gpt-5.4");
		await entered.promise;
		const second = q.setRole("default", "anthropic/claude-opus-4-8");
		try {
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			release.resolve();
		}
		await Promise.all([first, second]);
		expect(active).toBe(claude);
		const reloaded = await Settings.loadIsolated({ cwd, agentDir });
		expect(reloaded.getGlobalModelRole("default")).toBe("anthropic/claude-opus-4-8");
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});
});
