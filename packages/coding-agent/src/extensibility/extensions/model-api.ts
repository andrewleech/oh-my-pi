/**
 * Model query and role configuration facade exposed to extensions as `ctx.models`.
 *
 * Model matching and role eligibility stay in the core resolvers so extensions do
 * not need to mirror catalog or settings rules.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { getExtensionModelRoles, setExtensionModelRole, type ModelRoleSession } from "./model-role-api";
import type { ExtensionModelQuery, ExtensionModelRoleActions } from "./types";

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
	roleActions?: ExtensionModelRoleActions,
): ExtensionModelQuery {
	const roleSession: ModelRoleSession | undefined = roleActions
		? {
				...roleActions,
				get model() {
					return getModel();
				},
				get scopedModels() {
					return roleActions.getScopedModels();
				},
			}
		: undefined;
	return {
		list: () => modelRegistry.getAvailable(),
		current: () => getModel(),
		// resolveModelRoleValue expands a role alias (`@slow`) to its full configured
		// priority list and tries each pattern — the same path core selection uses — so a
		// fallback model lower in the list still resolves. Plain model strings pass through
		// as a single pattern.
		resolve: (spec: string): Model<Api> | undefined =>
			resolveModelRoleValue(spec, modelRegistry.getAvailable(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model,
		roles: async () => getExtensionModelRoles(modelRegistry, settings, roleSession),
		setRole: async (role, selector, scope) =>
			setExtensionModelRole(modelRegistry, settings, roleSession, role, selector, scope),
		family: (model: Model<Api>): string =>
			model.identity.class === "unknown" ? model.provider.toLowerCase() : model.identity.class,
	};
}
