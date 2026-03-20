/**
 * Explicit model switching — `openclaw bitrouter switch-all` and
 * `openclaw bitrouter restore-models`.
 *
 * Rewrites agent model configs in openclaw.json to route through BitRouter
 * (prefixing with "bitrouter/") and backs up the originals so they can be
 * restored later.
 */

import type {
  AgentModelConfig,
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";

export type SwitchResult = { changes: string[]; error?: string };

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Remap a single model config value to route through BitRouter.
 *
 * Reuses the `/` → `:` direct-routing pattern from routing.ts:
 *   "openai/gpt-4o" → "bitrouter/openai:gpt-4o"
 *   "gpt-4o"        → "bitrouter/gpt-4o"
 *   Already prefixed → no-op
 */
export function remapModelToBitrouter(model: AgentModelConfig): AgentModelConfig {
  if (typeof model === "string") {
    if (model.startsWith("bitrouter/")) return model;
    const remapped = model.includes("/") ? model.replace("/", ":") : model;
    return `bitrouter/${remapped}`;
  }

  // Object form: remap primary and fallbacks
  const result: { primary?: string; fallbacks?: string[] } = {};
  if (model.primary !== undefined) {
    const p = remapModelToBitrouter(model.primary);
    result.primary = typeof p === "string" ? p : model.primary;
  }
  if (model.fallbacks) {
    result.fallbacks = model.fallbacks.map((f) => {
      const r = remapModelToBitrouter(f);
      return typeof r === "string" ? r : f;
    });
  }
  return result;
}

/**
 * Check whether agent models are already switched to BitRouter.
 */
export function isAlreadySwitched(
  agents: { defaults?: { model?: AgentModelConfig } } | undefined,
  pluginConfig: BitrouterPluginConfig
): boolean {
  if (pluginConfig.originalModels) return true;
  if (!agents?.defaults?.model) return false;
  const m = agents.defaults.model;
  if (typeof m === "string") return m.startsWith("bitrouter/");
  if (m.primary) return m.primary.startsWith("bitrouter/");
  return false;
}

// ── Agent config shape (cast from api.config) ────────────────────────

type AgentEntry = { id: string; model?: AgentModelConfig };
type AgentsConfig = {
  defaults?: { model?: AgentModelConfig };
  list?: AgentEntry[];
};

function getAgentsConfig(api: OpenClawPluginApi): AgentsConfig | undefined {
  return (api.config as { agents?: AgentsConfig }).agents;
}

// ── switchAll ────────────────────────────────────────────────────────

export async function switchAll(
  api: OpenClawPluginApi,
  pluginConfig: BitrouterPluginConfig,
  state: BitrouterState
): Promise<SwitchResult> {
  const changes: string[] = [];

  const agents = getAgentsConfig(api);
  if (!agents) {
    return { changes, error: "No agent model configs found in openclaw.json." };
  }

  if (isAlreadySwitched(agents, pluginConfig)) {
    return {
      changes,
      error: "Models are already switched to BitRouter. Use `openclaw bitrouter restore-models` first.",
    };
  }

  if (!state.healthy) {
    changes.push("Warning: BitRouter daemon is not healthy — switching anyway.");
  }

  // Snapshot originals
  const originalModels: BitrouterPluginConfig["originalModels"] = {
    switchedAt: new Date().toISOString(),
  };

  // Rewrite defaults.model
  if (agents.defaults?.model) {
    originalModels.defaultModel = agents.defaults.model;
    const remapped = remapModelToBitrouter(agents.defaults.model);
    agents.defaults.model = remapped;
    changes.push(
      `  defaults.model: ${formatModel(originalModels.defaultModel)} → ${formatModel(remapped)}`
    );
  }

  // Rewrite each agent's model (only those that have one set)
  if (agents.list?.length) {
    originalModels.agentModels = {};
    for (const agent of agents.list) {
      if (agent.model === undefined) continue;
      originalModels.agentModels[agent.id] = agent.model;
      const remapped = remapModelToBitrouter(agent.model);
      agent.model = remapped;
      changes.push(
        `  ${agent.id}.model: ${formatModel(originalModels.agentModels[agent.id])} → ${formatModel(remapped)}`
      );
    }
  }

  // Persist originalModels backup
  pluginConfig.originalModels = originalModels;

  try {
    await (api.runtime as { config: { writeConfigFile: (c: unknown) => Promise<void> } })
      .config.writeConfigFile(api.config);
  } catch (err) {
    return { changes, error: `Failed to write config: ${err}` };
  }

  return { changes };
}

// ── restoreModels ────────────────────────────────────────────────────

export async function restoreModels(
  api: OpenClawPluginApi,
  pluginConfig: BitrouterPluginConfig
): Promise<SwitchResult> {
  const changes: string[] = [];

  const backup = pluginConfig.originalModels;
  if (!backup) {
    return {
      changes,
      error: "No original model backup found. Nothing to restore.",
    };
  }

  const agents = getAgentsConfig(api);
  if (!agents) {
    return { changes, error: "No agent model configs found in openclaw.json." };
  }

  // Restore defaults.model
  if (backup.defaultModel !== undefined && agents.defaults) {
    const current = agents.defaults.model;
    agents.defaults.model = backup.defaultModel;
    changes.push(
      `  defaults.model: ${formatModel(current)} → ${formatModel(backup.defaultModel)}`
    );
  }

  // Restore each agent's model
  if (backup.agentModels && agents.list) {
    for (const agent of agents.list) {
      const original = backup.agentModels[agent.id];
      if (original === undefined) continue;
      const current = agent.model;
      agent.model = original;
      changes.push(
        `  ${agent.id}.model: ${formatModel(current)} → ${formatModel(original)}`
      );
    }
  }

  // Clear backup
  delete pluginConfig.originalModels;

  try {
    await (api.runtime as { config: { writeConfigFile: (c: unknown) => Promise<void> } })
      .config.writeConfigFile(api.config);
  } catch (err) {
    return { changes, error: `Failed to write config: ${err}` };
  }

  return { changes };
}

// ── Formatting ───────────────────────────────────────────────────────

function formatModel(m: AgentModelConfig | undefined): string {
  if (m === undefined) return "(unset)";
  if (typeof m === "string") return m;
  return m.primary ?? JSON.stringify(m);
}
