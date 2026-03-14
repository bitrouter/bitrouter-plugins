/**
 * Agent tools — HTTP-based wrappers around BitRouter's API endpoints
 * plus CLI wrappers for local crypto operations.
 *
 * v0.7: status/account tools use HTTP endpoints instead of CLI.
 * New admin route management tools (add/remove/list routes).
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
 * Fetch JSON from a BitRouter HTTP endpoint.
 *
 * @param state - Plugin runtime state (provides baseUrl and tokens).
 * @param urlPath - URL path (e.g. "/health", "/v1/routes").
 * @param method - HTTP method (defaults to "GET").
 * @param body - Optional JSON body for POST/PUT/PATCH.
 * @param useAdmin - Use admin token instead of API token.
 */
async function fetchJson(
  state: BitrouterState,
  urlPath: string,
  method: string = "GET",
  body?: unknown,
  useAdmin: boolean = false
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const token = useAdmin ? state.adminToken : state.apiToken;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(`${state.baseUrl}${urlPath}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `${res.status} ${res.statusText}${text ? `: ${text}` : ""}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return { ok: true, data: await res.json() };
    }
    return { ok: true, data: await res.text() };
  } catch (err) {
    return { ok: false, error: `${err}` };
  }
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
        "Show BitRouter daemon status including health, routes, and metrics via HTTP API.",
      parameters: Type.Object({}),
      execute: async () => {
        const sections: string[] = [];

        // Health
        const health = await fetchJson(state, "/health");
        if (health.ok) {
          sections.push(`Health: ${JSON.stringify(health.data)}`);
        } else {
          sections.push(`Health: unreachable (${health.error})`);
        }

        // Routes
        const routes = await fetchJson(state, "/v1/routes");
        if (routes.ok) {
          const data = routes.data as { routes?: unknown[] };
          sections.push(`Routes (${data.routes?.length ?? 0}):\n${JSON.stringify(data.routes, null, 2)}`);
        } else {
          sections.push(`Routes: unavailable (${routes.error})`);
        }

        // Metrics
        const metrics = await fetchJson(state, "/v1/metrics");
        if (metrics.ok) {
          sections.push(`Metrics:\n${JSON.stringify(metrics.data, null, 2)}`);
        } else {
          sections.push(`Metrics: unavailable (${metrics.error})`);
        }

        return textResult(sections.join("\n\n"));
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
        "Manage BitRouter accounts. 'list' queries the server; 'set' manages local keypairs.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Union(
            [
              Type.Literal("list"),
              Type.Literal("set"),
            ],
            {
              description:
                'Action to perform. "list" (default): list accounts from server. ' +
                '"set": set the active local account keypair.',
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
        const action = (params.action as string) ?? "list";

        if (action === "list") {
          const result = await fetchJson(state, "/accounts", "GET", undefined, true);
          if (!result.ok) {
            return errorResult(`Failed to list accounts: ${result.error}`);
          }
          return textResult(JSON.stringify(result.data, null, 2));
        }

        if (action === "set") {
          if (!params.id) {
            return errorResult(
              'The "id" parameter is required when action is "set".'
            );
          }
          const bin = await getBinary();
          if (typeof bin !== "string") return bin;
          return runCli(bin, state.homeDir, ["account", "--set", params.id as string]);
        }

        return errorResult(`Unknown action: ${action}`);
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

  // ── bitrouter_add_route ──────────────────────────────────────────

  register(
    {
      name: "bitrouter_add_route",
      description:
        "Add a dynamic route to BitRouter via the admin API.",
      parameters: Type.Object({
        model: Type.String({
          description: "Virtual model name for the route (e.g. 'fast', 'gpt-4o').",
        }),
        strategy: Type.Optional(
          Type.Union(
            [Type.Literal("priority"), Type.Literal("load_balance")],
            { description: 'Routing strategy. Defaults to "priority".' }
          )
        ),
        endpoints: Type.Array(
          Type.Object({
            provider: Type.String({ description: "Provider name." }),
            model_id: Type.String({ description: "Upstream model ID." }),
          }),
          { description: "List of provider endpoints for this route." }
        ),
      }),
      execute: async (_id, params) => {
        const body: Record<string, unknown> = {
          model: params.model,
          endpoints: params.endpoints,
        };
        if (params.strategy) body.strategy = params.strategy;
        const result = await fetchJson(state, "/admin/routes", "POST", body, true);
        if (!result.ok) {
          return errorResult(`Failed to add route: ${result.error}`);
        }
        return textResult(`Route "${params.model}" added successfully.`);
      },
    },
    { optional: true }
  );

  // ── bitrouter_remove_route ───────────────────────────────────────

  register(
    {
      name: "bitrouter_remove_route",
      description:
        "Remove a dynamic route from BitRouter via the admin API.",
      parameters: Type.Object({
        model: Type.String({
          description: "Virtual model name to remove.",
        }),
      }),
      execute: async (_id, params) => {
        const model = encodeURIComponent(params.model as string);
        const result = await fetchJson(state, `/admin/routes/${model}`, "DELETE", undefined, true);
        if (!result.ok) {
          return errorResult(`Failed to remove route: ${result.error}`);
        }
        return textResult(`Route "${params.model}" removed successfully.`);
      },
    },
    { optional: true }
  );

  // ── bitrouter_list_routes ────────────────────────────────────────

  register(
    {
      name: "bitrouter_list_routes",
      description:
        "List all routes (config + dynamic) from BitRouter via the admin API.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = await fetchJson(state, "/admin/routes", "GET", undefined, true);
        if (!result.ok) {
          return errorResult(`Failed to list routes: ${result.error}`);
        }
        return textResult(JSON.stringify(result.data, null, 2));
      },
    },
    { optional: true }
  );
}
