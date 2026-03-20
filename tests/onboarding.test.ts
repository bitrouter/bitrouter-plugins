import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadOnboardingState, isOnboardingComplete, needsOnboarding } from "../src/onboarding.js";
import type { OnboardingState } from "../src/types.js";

const TEST_HOME = "/tmp/bitrouter-onboarding-test";
const ONBOARDING_PATH = path.join(TEST_HOME, "onboarding.json");

beforeEach(() => {
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true });
  } catch {
    // ignore
  }
});

describe("loadOnboardingState", () => {
  it("returns null when file does not exist", () => {
    const result = loadOnboardingState("/tmp/nonexistent-dir");
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    fs.writeFileSync(ONBOARDING_PATH, "not json", "utf-8");
    const result = loadOnboardingState(TEST_HOME);
    expect(result).toBeNull();
  });

  it("returns null when status field is missing", () => {
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ agent_wallets: [] }), "utf-8");
    const result = loadOnboardingState(TEST_HOME);
    expect(result).toBeNull();
  });

  it("returns null when agent_wallets is missing", () => {
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify({ status: "completed_cloud" }), "utf-8");
    const result = loadOnboardingState(TEST_HOME);
    expect(result).toBeNull();
  });

  it("loads valid onboarding state", () => {
    const state: OnboardingState = {
      status: "completed_cloud",
      wallet_address: "ABC123",
      swig_id: "swig-1",
      rpc_url: "https://api.mainnet-beta.solana.com",
      agent_wallets: [
        {
          label: "agent-1",
          address: "DEF456",
          role_id: 1,
          permissions: { per_tx_cap: 1000 },
          created_at: "2026-03-17T00:00:00Z",
        },
      ],
    };
    fs.writeFileSync(ONBOARDING_PATH, JSON.stringify(state), "utf-8");

    const result = loadOnboardingState(TEST_HOME);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed_cloud");
    expect(result!.wallet_address).toBe("ABC123");
    expect(result!.agent_wallets).toHaveLength(1);
    expect(result!.agent_wallets[0].label).toBe("agent-1");
  });
});

describe("isOnboardingComplete", () => {
  it("returns true for completed_cloud", () => {
    expect(isOnboardingComplete({ status: "completed_cloud", agent_wallets: [] })).toBe(true);
  });

  it("returns true for completed_byok", () => {
    expect(isOnboardingComplete({ status: "completed_byok", agent_wallets: [] })).toBe(true);
  });

  it("returns false for not_started", () => {
    expect(isOnboardingComplete({ status: "not_started", agent_wallets: [] })).toBe(false);
  });

  it("returns false for deferred", () => {
    expect(isOnboardingComplete({ status: "deferred", agent_wallets: [] })).toBe(false);
  });

  it("returns false for failed_recoverable", () => {
    expect(isOnboardingComplete({ status: "failed_recoverable", agent_wallets: [] })).toBe(false);
  });
});

describe("needsOnboarding", () => {
  it("returns true for not_started", () => {
    expect(needsOnboarding({ status: "not_started", agent_wallets: [] })).toBe(true);
  });

  it("returns true for deferred", () => {
    expect(needsOnboarding({ status: "deferred", agent_wallets: [] })).toBe(true);
  });

  it("returns false for completed_cloud", () => {
    expect(needsOnboarding({ status: "completed_cloud", agent_wallets: [] })).toBe(false);
  });

  it("returns false for completed_byok", () => {
    expect(needsOnboarding({ status: "completed_byok", agent_wallets: [] })).toBe(false);
  });
});
