/**
 * Provider registration — registers "bitrouter" as an LLM provider in
 * OpenClaw, pointing to the local BitRouter instance.
 *
 * Two auth methods are offered:
 *
 *   byok  — Bring Your Own Key: interactive wizard that collects an
 *            upstream provider (OpenRouter, OpenAI, Anthropic, or custom)
 *            and an API key. Persists mode + byok config via configPatch.
 *
 *   cloud — BitRouter Cloud stub (coming soon). Shows a "coming soon"
 *            message and exits without making changes.
 *
 * The wizard is triggered by:
 *   openclaw models auth login --provider bitrouter
 *   openclaw models auth login --provider bitrouter --method byok
 *   openclaw models auth login --provider bitrouter --method cloud
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";
import { byokWizard, cloudSetupHint } from "./setup.js";

// ── Provider registration ─────────────────────────────────────────────

/**
 * Register "bitrouter" as a provider in OpenClaw.
 *
 * Auth methods are always registered so the user can always run the wizard,
 * even to change their configuration after initial setup.
 */
export function registerBitrouterProvider(
  api: OpenClawPluginApi,
  _config: BitrouterPluginConfig,
  _state: BitrouterState
): void {
  api.registerProvider({
    id: "bitrouter",
    label: "BitRouter",
    auth: [
      {
        id: "byok",
        label: "BYOK — bring your own API key",
        hint: "Route through OpenRouter, OpenAI, Anthropic, or any compatible API",
        kind: "api_key",
        run: byokWizard,
      },
      {
        id: "cloud",
        label: "BitRouter Cloud (wallet setup)",
        hint: "Set up Swig wallet for x402 payments via interactive CLI",
        kind: "oauth",
        run: cloudSetupHint,
      },
    ],
  });
}
