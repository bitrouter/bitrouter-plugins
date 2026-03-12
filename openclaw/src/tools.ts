/**
 * Agent tools — thin wrappers around BitRouter CLI commands.
 *
 * Each tool maps 1:1 to a CLI subcommand. The agent gets structured
 * access to the same operations available via `bitrouter <command>`.
 * A companion skill teaches when and how to use these effectively.
 */

import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { resolveBinaryPath } from "./binary.js";
import type {
  BitrouterState,
  OpenClawPluginApi,
  ToolResult,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Run a bitrouter CLI command and return stdout as a tool result. */
function runCli(
  binaryPath: string,
  homeDir: string,
  args: string[]
): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["--home-dir", homeDir, ...args],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(
            errorResult(
              `bitrouter ${args[0]} failed: ${err.message}${stderr ? `\n${stderr}` : ""}`
            )
          );
          return;
        }
        resolve(textResult(stdout.trim()));
      }
    );
  });
}

/**
 * Wrap a tool definition into the factory shape expected by the OpenClaw SDK.
 */
function makeToolFactory(
  def: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (
      id: string,
      params: Record<string, unknown>
    ) => Promise<ToolResult>;
  },
  opts?: { optional?: boolean }
) {
  return {
    factory: () => ({
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: def.parameters,
      execute: async (
        toolCallId: string,
        params: Record<string, unknown>
      ) => {
        const res = await def.execute(toolCallId, params);
        const text = res.content.map((c) => c.text).join("\n");
        return {
          content: [{ type: "text" as const, text: res.isError ? `Error: ${text}` : text }],
          details: undefined,
        };
      },
    }),
    opts,
  };
}

// ── Tool registration ────────────────────────────────────────────────

export function registerAgentTools(
  api: OpenClawPluginApi,
  _config: unknown,
  state: BitrouterState,
  stateDirRef: { value: string }
): void {
  const register = (
    def: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
    },
    opts?: { optional?: boolean }
  ) => {
    const { factory, opts: toolOpts } = makeToolFactory(def, opts);
    api.registerTool(factory as never, toolOpts);
  };

  /** Resolve the bitrouter binary or return an error result. */
  const getBinary = async (): Promise<string | ToolResult> => {
    try {
      return await resolveBinaryPath(stateDirRef.value);
    } catch (err) {
      return errorResult(`BitRouter binary not found: ${err}`);
    }
  };

  // ── bitrouter_status ─────────────────────────────────────────────

  register(
    {
      name: "bitrouter_status",
      description:
        "Show BitRouter daemon status, listen address, configured providers, and resolved paths.",
      parameters: Type.Object({}),
      execute: async () => {
        const bin = await getBinary();
        if (typeof bin !== "string") return bin;
        return runCli(bin, state.homeDir, ["status"]);
      },
    },
    { optional: true }
  );

  // ── bitrouter_keygen ─────────────────────────────────────────────

  register(
    {
      name: "bitrouter_keygen",
      description:
        "Generate a scoped JWT token for BitRouter API access.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: 'Token scope: "admin" or "api". Defaults to "api".',
          })
        ),
        exp: Type.Optional(
          Type.String({
            description:
              'Expiration duration (e.g. "5m", "1h", "30d", "never"). Defaults to "1h".',
          })
        ),
        models: Type.Optional(
          Type.String({
            description: "Comma-separated list of allowed model patterns.",
          })
        ),
        budget: Type.Optional(
          Type.Number({
            description: "Budget limit in micro USD.",
          })
        ),
        budget_scope: Type.Optional(
          Type.String({
            description: 'Budget scope: "session" or "account".',
          })
        ),
        budget_range: Type.Optional(
          Type.String({
            description:
              'Budget range (e.g. "rounds:10", "duration:3600s").',
          })
        ),
      }),
      execute: async (_id, params) => {
        const bin = await getBinary();
        if (typeof bin !== "string") return bin;

        const args = ["keygen"];
        if (params.scope) args.push("--scope", params.scope as string);
        if (params.exp) args.push("--exp", params.exp as string);
        if (params.models) args.push("--models", params.models as string);
        if (params.budget !== undefined)
          args.push("--budget", String(params.budget));
        if (params.budget_scope)
          args.push("--budget-scope", params.budget_scope as string);
        if (params.budget_range)
          args.push("--budget-range", params.budget_range as string);

        return runCli(bin, state.homeDir, args);
      },
    },
    { optional: true }
  );

  // ── bitrouter_account ────────────────────────────────────────────

  register(
    {
      name: "bitrouter_account",
      description:
        "Manage local Ed25519 account keypairs used to sign BitRouter JWTs.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Union(
            [
              Type.Literal("list"),
              Type.Literal("generate"),
              Type.Literal("set"),
            ],
            {
              description:
                'Action to perform. "list" (default): show all keypairs. ' +
                '"generate": create a new Ed25519 keypair. ' +
                '"set": set the active account.',
            }
          )
        ),
        id: Type.Optional(
          Type.String({
            description:
              'Account index or pubkey prefix. Required when action is "set".',
          })
        ),
      }),
      execute: async (_id, params) => {
        const bin = await getBinary();
        if (typeof bin !== "string") return bin;

        const action = (params.action as string) ?? "list";
        const args = ["account"];

        if (action === "generate") {
          args.push("--generate-key");
        } else if (action === "set") {
          if (!params.id) {
            return errorResult(
              'The "id" parameter is required when action is "set".'
            );
          }
          args.push("--set", params.id as string);
        } else {
          args.push("--list");
        }

        return runCli(bin, state.homeDir, args);
      },
    },
    { optional: true }
  );

  // ── bitrouter_keys ───────────────────────────────────────────────

  register(
    {
      name: "bitrouter_keys",
      description:
        "List, inspect, and remove locally stored JWTs for the active account.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Union(
            [
              Type.Literal("list"),
              Type.Literal("show"),
              Type.Literal("rm"),
            ],
            {
              description:
                'Action to perform. "list" (default): list saved tokens. ' +
                '"show": show decoded claims of a token. ' +
                '"rm": remove a saved token.',
            }
          )
        ),
        name: Type.Optional(
          Type.String({
            description:
              'Token name or index. Required for "show" and "rm" actions.',
          })
        ),
      }),
      execute: async (_id, params) => {
        const bin = await getBinary();
        if (typeof bin !== "string") return bin;

        const action = (params.action as string) ?? "list";
        const args = ["keys"];

        if (action === "show") {
          if (!params.name) {
            return errorResult(
              'The "name" parameter is required when action is "show".'
            );
          }
          args.push("--show", params.name as string);
        } else if (action === "rm") {
          if (!params.name) {
            return errorResult(
              'The "name" parameter is required when action is "rm".'
            );
          }
          args.push("--rm", params.name as string);
        } else {
          args.push("--list");
        }

        return runCli(bin, state.homeDir, args);
      },
    },
    { optional: true }
  );
}
