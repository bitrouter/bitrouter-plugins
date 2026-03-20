/**
 * Onboarding state reader — loads and inspects `onboarding.json`
 * written by the Rust CLI's `bitrouter init` command.
 *
 * This module is read-only: it never writes to `onboarding.json`.
 * The Rust binary owns that file's lifecycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { OnboardingState } from "./types.js";

/**
 * Load onboarding state from `<homeDir>/onboarding.json`.
 * Returns null if the file doesn't exist or is malformed.
 */
export function loadOnboardingState(homeDir: string): OnboardingState | null {
  const filePath = path.join(homeDir, "onboarding.json");

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    // Minimal validation: must have a status field and agent_wallets array.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.status !== "string" ||
      !Array.isArray(parsed.agent_wallets)
    ) {
      return null;
    }

    return parsed as OnboardingState;
  } catch {
    return null;
  }
}

/**
 * Check if onboarding has been completed (cloud or BYOK).
 */
export function isOnboardingComplete(state: OnboardingState): boolean {
  return state.status === "completed_cloud" || state.status === "completed_byok";
}

/**
 * Check if onboarding is needed (not started or deferred).
 */
export function needsOnboarding(state: OnboardingState): boolean {
  return state.status === "not_started" || state.status === "deferred";
}
