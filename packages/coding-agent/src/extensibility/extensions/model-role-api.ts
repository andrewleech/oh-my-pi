import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { parseModelString, formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	AUTO_THINKING,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	type ConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import { cfgDefaultThinkingLevel } from "../../session/settings";
import { cfgModelRoleStorage } from "../../config/model-settings";
import { formatModelRoleAlias, getKnownRoleIds, getRoleInfo, roleCandidatePool } from "../../config/model-roles";
import { withModelRoleMutation } from "../../config/model-presets";
import { resolveModelRoleValue } from "../../config/model-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExtensionModelRoleActions, ModelRoleInfo, ModelRolesConfiguration, RoleModel } from "./types";

export type ModelRoleApiErrorCode =
	| "unavailable"
	| "unknown_role"
	| "invalid_selector"
	| "invalid_scope"
	| "ineligible_model"
	| "unsupported_thinking_level";

export class ModelRoleApiError extends Error {
	readonly code: ModelRoleApiErrorCode;

	constructor(code: ModelRoleApiErrorCode, message: string) {
		super(message);
		this.name = "ModelRoleApiError";
		this.code = code;
	}
}

export interface ModelRoleSession extends Omit<ExtensionModelRoleActions, "getScopedModels"> {
	model: Model | undefined;
	scopedModels?: ReadonlyArray<{ model: Model }>;
}

export function getExtensionModelRoles(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	session?: ModelRoleSession,
): ModelRolesConfiguration {
	if (!settings) return { storage: "global", roles: [] };
	const storage = cfgModelRoleStorage.get(settings);
	const roles: ModelRoleInfo[] = getKnownRoleIds(settings).map(id => {
		const info = getRoleInfo(id, settings);
		const selector = settings.getModelRole(id) || null;
		const candidates = roleCandidatePool(id, settings, modelRegistry);
		const resolved = selector
			? resolveModelRoleValue(selector, candidates, { settings }).model
			: id === "default"
				? session?.model
				: resolveModelRoleValue(formatModelRoleAlias(id), candidates, { settings }).model;
		return {
			id,
			name: info.name,
			selector,
			provenance: settings.getModelRoleProvenance(id),
			globalSelector: settings.getGlobalModelRole(id) ?? null,
			projectSelector: settings.getProjectModelRole(id) ?? null,
			resolvedModel: resolved ? { provider: resolved.provider, id: resolved.id, name: resolved.name } : null,
			models: candidates.map(model => roleModel(model)),
		};
	});
	return { storage, roles };
}

function roleModel(model: Model<Api>): RoleModel {
	const thinkingLevels = model.reasoning ? ["off", AUTO_THINKING, ...getSupportedEfforts(model).map(String)] : [];
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		thinkingLevels: thinkingLevels.map(String),
	};
}

export async function setExtensionModelRole(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	session: ModelRoleSession | undefined,
	role: string,
	selector: string | null,
	scope?: "global" | "project",
): Promise<ModelRolesConfiguration> {
	if (!settings) throw new ModelRoleApiError("unavailable", "Model role settings are unavailable");
	if (!session) throw new ModelRoleApiError("unavailable", "Model role mutation is unavailable in this session");
	if (!getKnownRoleIds(settings).includes(role)) {
		throw new ModelRoleApiError("unknown_role", `Unknown model role: ${role}`);
	}
	if (scope !== undefined && scope !== "global" && scope !== "project") {
		throw new ModelRoleApiError("invalid_scope", `Invalid model role scope: ${String(scope)}`);
	}
	if (selector !== null && typeof selector !== "string") {
		throw new ModelRoleApiError("invalid_selector", "Model selector must be a string or null");
	}
	return withModelRoleMutation(role, async () => {
		const configuredStorage = cfgModelRoleStorage.get(settings);
		if (configuredStorage !== "project" && scope === "project") {
			throw new ModelRoleApiError("invalid_scope", "Project model role storage is not enabled");
		}
		const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
		if (selector === null) {
			await clearModelRole(settings, session, role, targetScope);
		} else {
			const candidates = roleCandidatePool(role, settings, modelRegistry);
			const parsed = parseModelString(selector, {
				allowMaxSuffix: true,
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) =>
					candidates.some(model => model.provider === provider && model.id === id),
			});
			if (
				!parsed ||
				formatModelSelectorValue(`${parsed.provider}/${parsed.id}`, parsed.thinkingLevel) !== selector
			) {
				throw new ModelRoleApiError("invalid_selector", `Invalid model selector: ${selector}`);
			}
			const model = candidates.find(
				candidate => candidate.provider === parsed.provider && candidate.id === parsed.id,
			);
			if (!model) {
				throw new ModelRoleApiError("ineligible_model", `Model is not eligible for role ${role}: ${selector}`);
			}
			if (parsed.thinkingLevel !== undefined) {
				const availableLevels = model.reasoning
					? ["off", AUTO_THINKING, ...getSupportedEfforts(model).map(String)]
					: [];
				if (!availableLevels.includes(String(parsed.thinkingLevel))) {
					throw new ModelRoleApiError(
						"unsupported_thinking_level",
						`Thinking level ${parsed.thinkingLevel} is not supported by ${model.provider}/${model.id}`,
					);
				}
			}
			const assigned = await assignModelRole(
				settings,
				session,
				role,
				model,
				`${model.provider}/${model.id}`,
				parsed.thinkingLevel,
				targetScope,
			);
			if (!assigned) {
				throw new ModelRoleApiError("unavailable", `Could not switch to ${model.provider}/${model.id}`);
			}
		}
		await settings.flush();
		return getExtensionModelRoles(modelRegistry, settings, session);
	});
}

export async function assignModelRole(
	settings: Settings,
	session: ModelRoleSession,
	role: string,
	model: Model,
	selector: string,
	thinkingLevel: ConfiguredThinkingLevel | undefined,
	targetScope: "global" | "project",
): Promise<boolean> {
	if (role !== "default") {
		const value = formatModelSelectorValue(selector, thinkingLevel);
		if (targetScope === "project") settings.setProjectModelRole(role, value);
		else settings.setModelRole(role, value);
		return true;
	}

	const isAuto = thinkingLevel === AUTO_THINKING;
	const concreteThinking = isAuto || thinkingLevel === undefined ? undefined : thinkingLevel;
	const provenance = settings.getModelRoleProvenance("default");
	const shadowedGlobal =
		cfgModelRoleStorage.get(settings) === "project" &&
		targetScope === "global" &&
		(provenance === "project" ||
			provenance === "overlay" ||
			(provenance === "runtime" && settings.isProjectModelRoleRuntimeOverrideActive("default")));
	const shadowedProject =
		cfgModelRoleStorage.get(settings) === "project" && targetScope === "project" && provenance === "overlay";
	const persistedSelector = formatModelSelectorValue(selector, concreteThinking);
	if (shadowedGlobal) {
		settings.setModelRole("default", persistedSelector);
		if (isAuto) cfgDefaultThinkingLevel.set(settings, AUTO_THINKING);
		return true;
	}
	if (shadowedProject) {
		settings.setProjectModelRole("default", persistedSelector);
		if (isAuto) cfgDefaultThinkingLevel.set(settings, AUTO_THINKING);
		return true;
	}

	const switched = await session.setModel(model, "default", {
		selector,
		thinkingLevel:
			isAuto || concreteThinking === undefined ? ThinkingLevel.Inherit : (concreteThinking as ThinkingLevel),
		persist: false,
	});
	if (!switched.switched) return false;
	if (targetScope === "project") settings.setProjectModelRole("default", persistedSelector);
	else settings.setModelRole("default", persistedSelector);
	if (isAuto) session.setThinkingLevel(AUTO_THINKING, true);
	else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) session.setThinkingLevel(concreteThinking);
	return true;
}

export async function clearModelRole(
	settings: Settings,
	session: ModelRoleSession,
	role: string,
	targetScope: "global" | "project",
): Promise<Model | undefined> {
	const previousEffectiveRoleValue = role === "default" ? settings.getModelRole("default") : undefined;
	if (targetScope === "project") settings.clearProjectModelRole(role);
	else settings.setModelRole(role, undefined);
	if (role !== "default") return undefined;

	const fallbackRoleValue = settings.getModelRole("default");
	const fallbackProvenance = settings.getModelRoleProvenance("default");
	if (!fallbackRoleValue || (fallbackProvenance !== "project" && fallbackProvenance !== "global")) return undefined;
	const scopedModels = session.scopedModels?.map(entry => entry.model) ?? [];
	const availableModels = scopedModels.length > 0 ? scopedModels : session.getAvailableModels();
	const resolved = resolveModelRoleValue(fallbackRoleValue, availableModels, { settings });
	const live = session.model;
	const liveDiffers =
		!live || !resolved.model || live.provider !== resolved.model.provider || live.id !== resolved.model.id;
	if (!resolved.model || (fallbackRoleValue === previousEffectiveRoleValue && !liveDiffers)) return undefined;

	const fallbackModel = resolved.model;
	const isAuto = resolved.thinkingLevel === AUTO_THINKING;
	let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
	let isAutoFromDefault = false;
	if (!resolved.explicitThinkingLevel && !concreteThinking) {
		const defaultLevel = parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings));
		if (defaultLevel === AUTO_THINKING) isAutoFromDefault = true;
		else if (defaultLevel) concreteThinking = defaultLevel;
	}
	const effectiveIsAuto = isAuto || isAutoFromDefault;
	const switched = await session.setModel(fallbackModel, "default", {
		persist: false,
		thinkingLevel: effectiveIsAuto ? ThinkingLevel.Inherit : (concreteThinking ?? ThinkingLevel.Inherit),
	});
	if (!switched.switched) return undefined;
	if (effectiveIsAuto) session.setThinkingLevel(AUTO_THINKING, true);
	else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) session.setThinkingLevel(concreteThinking);
	return fallbackModel;
}
