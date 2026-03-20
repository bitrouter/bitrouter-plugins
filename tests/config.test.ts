import { describe, it, expect } from "vitest";
import * as YAML from "yaml";
import { generateConfig } from "../src/config.js";
import type { BitrouterPluginConfig } from "../src/types.js";

describe("generateConfig", () => {
  it("generates minimal YAML with defaults only", () => {
    const { yaml, envVars } = generateConfig({});

    // Should parse as valid YAML.
    const parsed = YAML.parse(yaml);
    expect(parsed.server.listen).toBe("127.0.0.1:8787");
    expect(parsed.providers).toBeUndefined();
    expect(parsed.models).toBeUndefined();
    expect(Object.keys(envVars)).toHaveLength(0);
  });

  it("generates YAML with custom port and host", () => {
    const { yaml } = generateConfig({ port: 9000, host: "0.0.0.0" });
    const parsed = YAML.parse(yaml);
    expect(parsed.server.listen).toBe("0.0.0.0:9000");
  });

  it("passes through env var references in api_key", () => {
    const config: BitrouterPluginConfig = {
      providers: {
        openai: { apiKey: "${OPENAI_API_KEY}" },
      },
    };

    const { yaml, envVars } = generateConfig(config);
    const parsed = YAML.parse(yaml);

    // Env var reference should be in the YAML, not in envVars.
    expect(parsed.providers.openai.api_key).toBe("${OPENAI_API_KEY}");
    expect(Object.keys(envVars)).toHaveLength(0);
  });

  it("separates literal API keys into envVars", () => {
    const config: BitrouterPluginConfig = {
      providers: {
        openai: { apiKey: "sk-live-abc123" },
      },
    };

    const { yaml, envVars } = generateConfig(config);
    const parsed = YAML.parse(yaml);

    // YAML should reference the env var, not contain the literal key.
    expect(parsed.providers.openai.api_key).toBe("${OPENAI_API_KEY}");
    // The literal key should be in envVars for .env file generation.
    expect(envVars["OPENAI_API_KEY"]).toBe("sk-live-abc123");
  });

  it("uses envPrefix for env var name when provided", () => {
    const config: BitrouterPluginConfig = {
      providers: {
        "my-company": {
          apiKey: "sk-custom",
          envPrefix: "MYCO",
        },
      },
    };

    const { yaml, envVars } = generateConfig(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.providers["my-company"].api_key).toBe("${MYCO_API_KEY}");
    expect(parsed.providers["my-company"].env_prefix).toBe("MYCO");
    expect(envVars["MYCO_API_KEY"]).toBe("sk-custom");
  });

  it("maps provider fields to snake_case", () => {
    const config: BitrouterPluginConfig = {
      providers: {
        custom: {
          derives: "openai",
          apiBase: "https://api.custom.com/v1",
          envPrefix: "CUSTOM",
        },
      },
    };

    const { yaml } = generateConfig(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.providers.custom.derives).toBe("openai");
    expect(parsed.providers.custom.api_base).toBe("https://api.custom.com/v1");
    expect(parsed.providers.custom.env_prefix).toBe("CUSTOM");
  });

  it("generates model routing config with snake_case fields", () => {
    const config: BitrouterPluginConfig = {
      models: {
        fast: {
          strategy: "load_balance",
          endpoints: [
            { provider: "openai", modelId: "gpt-4o-mini" },
            { provider: "anthropic", modelId: "claude-3.5-haiku" },
          ],
        },
      },
    };

    const { yaml } = generateConfig(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.models.fast.strategy).toBe("load_balance");
    expect(parsed.models.fast.endpoints).toHaveLength(2);
    expect(parsed.models.fast.endpoints[0].provider).toBe("openai");
    expect(parsed.models.fast.endpoints[0].model_id).toBe("gpt-4o-mini");
    expect(parsed.models.fast.endpoints[1].provider).toBe("anthropic");
    expect(parsed.models.fast.endpoints[1].model_id).toBe("claude-3.5-haiku");
  });

  it("includes per-endpoint overrides", () => {
    const config: BitrouterPluginConfig = {
      models: {
        custom: {
          endpoints: [
            {
              provider: "openai",
              modelId: "gpt-4o",
              apiKey: "sk-override",
              apiBase: "https://custom.api/v1",
            },
          ],
        },
      },
    };

    const { yaml } = generateConfig(config);
    const parsed = YAML.parse(yaml);

    expect(parsed.models.custom.endpoints[0].api_key).toBe("sk-override");
    expect(parsed.models.custom.endpoints[0].api_base).toBe(
      "https://custom.api/v1"
    );
  });

  it("includes solana_rpc_url in YAML when set", () => {
    const { yaml } = generateConfig({ solanaRpcUrl: "https://api.mainnet-beta.solana.com" });
    const parsed = YAML.parse(yaml);
    expect(parsed.solana_rpc_url).toBe("https://api.mainnet-beta.solana.com");
  });

  it("omits solana_rpc_url from YAML when not set", () => {
    const { yaml } = generateConfig({});
    const parsed = YAML.parse(yaml);
    expect(parsed.solana_rpc_url).toBeUndefined();
  });

  it("round-trips through YAML parse without data loss", () => {
    const config: BitrouterPluginConfig = {
      port: 9090,
      host: "0.0.0.0",
      providers: {
        openai: { apiKey: "${OPENAI_API_KEY}" },
        anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
      },
      models: {
        smart: {
          strategy: "priority",
          endpoints: [
            { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
            { provider: "openai", modelId: "gpt-4o" },
          ],
        },
      },
    };

    const { yaml } = generateConfig(config);
    // Should parse without errors.
    const parsed = YAML.parse(yaml);
    // Re-serialize and re-parse to verify stability.
    const reserialized = YAML.stringify(parsed);
    const reparsed = YAML.parse(reserialized);
    expect(reparsed.server.listen).toBe("0.0.0.0:9090");
    expect(reparsed.providers.openai.api_key).toBe("${OPENAI_API_KEY}");
    expect(reparsed.models.smart.endpoints).toHaveLength(2);
  });
});
