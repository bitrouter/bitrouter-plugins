/**
 * Agent tools — runtime route configuration and status tools that agents
 * can call during a session.
 *
 * All tools are registered as optional (agents can use them but they're
 * not required for basic plugin operation).
 */

import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { toEnvVarKey } from "./config.js";
import { resolveBinaryPath } from "./binary.js";
import { readFeedback } from "./feedback.js";
import { getModelTier, type ModelTier } from "./model-tiers.js";
import type {
  BitrouterPluginConfig,
  BitrouterState,
  DynamicRoute,
  OpenClawPluginApi,
  RouteMetrics,
  ToolResult,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResult(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * Wrap a ToolResult-returning execute function into a factory-compatible tool.
 * The real SDK expects AgentToolResult { content, details } — we translate.
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
  config: BitrouterPluginConfig,
  state: BitrouterState,
  stateDirRef: { value: string }
): void {
  // Helper to register a tool using the factory pattern.
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

  // ── bitrouter_status ─────────────────────────────────────────────

  register(
    {
      name: "bitrouter_status",
      description:
        "Get BitRouter health status, provider count, route counts, and base URL.",
      parameters: Type.Object({}),
      execute: async () => {
        const providerNames = new Set<string>();
        if (config.providers) {
          for (const name of Object.keys(config.providers)) {
            providerNames.add(name);
          }
        }
        for (const r of state.knownRoutes) {
          providerNames.add(r.provider);
        }

        const result: Record<string, unknown> = {
          healthy: state.healthy,
          baseUrl: state.baseUrl,
          processRunning: state.process !== null,
          providerCount: providerNames.size,
          staticRouteCount: state.knownRoutes.length,
          dynamicRouteCount: state.dynamicRoutes.size,
          metricsAvailable: state.metrics !== null,
        };

        // Include aggregate metrics if available.
        if (state.metrics) {
          let totalRequests = 0;
          let totalErrors = 0;
          for (const rm of Object.values(state.metrics.routes)) {
            totalRequests += rm.total_requests;
            totalErrors += rm.total_errors;
          }
          result.totalRequests = totalRequests;
          result.totalErrors = totalErrors;
          result.overallErrorRate =
            totalRequests > 0 ? totalErrors / totalRequests : 0;
        }

        return jsonResult(result);
      },
    },
    { optional: true }
  );

  // ── bitrouter_list_providers ─────────────────────────────────────

  register(
    {
      name: "bitrouter_list_providers",
      description:
        "List known providers from config and discovered routes, with API key availability.",
      parameters: Type.Object({}),
      execute: async () => {
        const providers: Record<
          string,
          { source: string; hasApiKey: boolean }
        > = {};

        // From config
        if (config.providers) {
          for (const [name, entry] of Object.entries(config.providers)) {
            const envKey = entry.envPrefix
              ? `${entry.envPrefix}_API_KEY`
              : toEnvVarKey(name);
            providers[name] = {
              source: "config",
              hasApiKey:
                !!entry.apiKey || !!process.env[envKey],
            };
          }
        }

        // From discovered routes (dedup)
        for (const r of state.knownRoutes) {
          if (!providers[r.provider]) {
            providers[r.provider] = {
              source: "discovered",
              hasApiKey: !!process.env[toEnvVarKey(r.provider)],
            };
          }
        }

        return jsonResult(providers);
      },
    },
    { optional: true }
  );

  // ── bitrouter_list_routes ────────────────────────────────────────

  register(
    {
      name: "bitrouter_list_routes",
      description:
        "List all routes (static from BitRouter config + dynamic agent-created) with source labels.",
      parameters: Type.Object({}),
      execute: async () => {
        const routes: Array<Record<string, unknown>> = [];

        // Static routes from BitRouter
        for (const r of state.knownRoutes) {
          const entry: Record<string, unknown> = {
            model: r.model,
            provider: r.provider,
            protocol: r.protocol,
            source: "static",
          };

          // Attach metrics summary if available.
          const rm = state.metrics?.routes[r.model];
          if (rm) {
            entry.metrics = {
              requests: rm.total_requests,
              errors: rm.total_errors,
              errorRate: rm.error_rate,
              latencyP50: rm.latency_p50_ms,
              latencyP99: rm.latency_p99_ms,
            };
          }

          routes.push(entry);
        }

        // Dynamic routes from agent tools
        for (const [, dr] of state.dynamicRoutes) {
          const entry: Record<string, unknown> = {
            model: dr.model,
            strategy: dr.strategy,
            endpoints: dr.endpoints.map((e) => ({
              provider: e.provider,
              modelId: e.modelId,
            })),
            source: "dynamic",
            createdAt: dr.createdAt,
          };

          const rm = state.metrics?.routes[dr.model];
          if (rm) {
            entry.metrics = {
              requests: rm.total_requests,
              errors: rm.total_errors,
              errorRate: rm.error_rate,
              latencyP50: rm.latency_p50_ms,
              latencyP99: rm.latency_p99_ms,
            };
          }

          routes.push(entry);
        }

        return jsonResult(routes);
      },
    },
    { optional: true }
  );

  // ── bitrouter_create_route ───────────────────────────────────────

  register(
    {
      name: "bitrouter_create_route",
      description:
        "Create or update a dynamic route for a model name. " +
        "Uses upsert semantics — calling with the same model name overwrites the previous route. " +
        "Dynamic routes take priority over static routes.",
      parameters: Type.Object({
        model: Type.String({ description: "Virtual model name to route." }),
        strategy: Type.Optional(
          Type.Union([Type.Literal("priority"), Type.Literal("load_balance")], {
            description:
              'Routing strategy: "priority" (always first endpoint) or "load_balance" (round-robin). Defaults to "priority".',
          })
        ),
        endpoints: Type.Array(
          Type.Object({
            provider: Type.String({ description: "Provider name (e.g. openai, anthropic)." }),
            modelId: Type.String({ description: "Upstream model ID (e.g. gpt-4o)." }),
          }),
          { minItems: 1, description: "List of upstream endpoints." }
        ),
      }),
      execute: async (_id, params) => {
        const model = params.model as string;
        const strategy = (params.strategy as "priority" | "load_balance") ?? "priority";
        const endpoints = params.endpoints as Array<{
          provider: string;
          modelId: string;
        }>;

        const warnings: string[] = [];

        // Warn if shadowing a static route
        const shadowsStatic = state.knownRoutes.some(
          (r) => r.model === model
        );
        if (shadowsStatic) {
          warnings.push(
            `Warning: model "${model}" shadows a static route. The dynamic route will take priority.`
          );
        }

        // Warn if provider is unknown (but allow it — direct routing may work)
        const knownProviders = new Set<string>();
        if (config.providers) {
          for (const name of Object.keys(config.providers)) {
            knownProviders.add(name);
          }
        }
        for (const r of state.knownRoutes) {
          knownProviders.add(r.provider);
        }
        for (const ep of endpoints) {
          if (!knownProviders.has(ep.provider)) {
            warnings.push(
              `Warning: provider "${ep.provider}" is not in the known provider list. Direct routing may still work.`
            );
          }
        }

        const route: DynamicRoute = {
          model,
          strategy,
          endpoints: endpoints.map((e) => ({
            provider: e.provider,
            modelId: e.modelId,
          })),
          rrCounter: 0,
          createdAt: new Date().toISOString(),
        };

        state.dynamicRoutes.set(model, route);

        const result: Record<string, unknown> = {
          ok: true,
          model,
          strategy,
          endpointCount: endpoints.length,
        };
        if (warnings.length > 0) {
          result.warnings = warnings;
        }

        return jsonResult(result);
      },
    },
    { optional: true }
  );

  // ── bitrouter_delete_route ───────────────────────────────────────

  register(
    {
      name: "bitrouter_delete_route",
      description:
        "Delete a dynamic route by model name. Cannot delete static routes.",
      parameters: Type.Object({
        model: Type.String({ description: "Model name of the dynamic route to delete." }),
      }),
      execute: async (_id, params) => {
        const model = params.model as string;

        // Check if it's a static route
        const isStatic = state.knownRoutes.some((r) => r.model === model);
        if (isStatic && !state.dynamicRoutes.has(model)) {
          return errorResult(
            `Cannot delete static route "${model}". Static routes are managed by BitRouter config.`
          );
        }

        if (!state.dynamicRoutes.has(model)) {
          return errorResult(
            `No dynamic route found for model "${model}".`
          );
        }

        state.dynamicRoutes.delete(model);
        return jsonResult({ ok: true, model, deleted: true });
      },
    },
    { optional: true }
  );

  // ── bitrouter_route_metrics ─────────────────────────────────────

  register(
    {
      name: "bitrouter_route_metrics",
      description:
        "Get detailed performance metrics for a specific route, including per-endpoint breakdown.",
      parameters: Type.Object({
        model: Type.String({ description: "Model/route name to get metrics for." }),
      }),
      execute: async (_id, params) => {
        const model = params.model as string;

        if (!state.metrics) {
          return errorResult(
            "Metrics not available. BitRouter may not support the /v1/metrics endpoint yet."
          );
        }

        const rm = state.metrics.routes[model];
        if (!rm) {
          return errorResult(
            `No metrics found for model "${model}". Available: ${Object.keys(state.metrics.routes).join(", ") || "(none)"}`
          );
        }

        return jsonResult(rm);
      },
    },
    { optional: true }
  );

  // ── bitrouter_route_task ──────────────────────────────────────────

  register(
    {
      name: "bitrouter_route_task",
      description:
        "Get a model recommendation for a specific task type based on available routes, metrics, and feedback.",
      parameters: Type.Object({
        taskType: Type.Union(
          [
            Type.Literal("reasoning"),
            Type.Literal("coding"),
            Type.Literal("creative"),
            Type.Literal("retrieval"),
            Type.Literal("summarization"),
          ],
          { description: "The type of task to recommend a model for." }
        ),
        latencyPriority: Type.Optional(
          Type.Union(
            [Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")],
            { description: 'Latency priority. "high" prefers lowest latency. Default "normal".' }
          )
        ),
        budgetHint: Type.Optional(
          Type.Union(
            [Type.Literal("cheap"), Type.Literal("moderate"), Type.Literal("expensive")],
            { description: 'Budget hint. "cheap" prefers lower-tier models. Default "moderate".' }
          )
        ),
      }),
      execute: async (_id, params) => {
        const taskType = params.taskType as string;
        const latencyPriority = (params.latencyPriority as string) ?? "normal";
        const budgetHint = (params.budgetHint as string) ?? "moderate";

        // Collect all available routes.
        type Candidate = {
          model: string;
          provider: string;
          modelId: string;
          source: "static" | "dynamic";
          tier: ModelTier;
          metrics?: RouteMetrics;
        };

        const candidates: Candidate[] = [];

        for (const r of state.knownRoutes) {
          candidates.push({
            model: r.model,
            provider: r.provider,
            modelId: r.model, // static routes use model name
            source: "static",
            tier: getModelTier(r.model),
            metrics: state.metrics?.routes[r.model],
          });
        }

        for (const [, dr] of state.dynamicRoutes) {
          const ep = dr.endpoints[0];
          if (ep) {
            candidates.push({
              model: dr.model,
              provider: ep.provider,
              modelId: ep.modelId,
              source: "dynamic",
              tier: getModelTier(ep.modelId),
              metrics: state.metrics?.routes[dr.model],
            });
          }
        }

        if (candidates.length === 0) {
          return errorResult("No routes available. Configure routes in BitRouter first.");
        }

        // Determine preferred tier based on task type + budget.
        const taskTierMap: Record<string, ModelTier> = {
          reasoning: "high",
          coding: "high",
          creative: "high",
          retrieval: "low",
          summarization: "low",
        };

        let preferredTier = taskTierMap[taskType] ?? "mid";

        // Budget adjusts the tier preference.
        if (budgetHint === "cheap") {
          if (preferredTier === "high") preferredTier = "mid";
          else preferredTier = "low";
        } else if (budgetHint === "expensive") {
          preferredTier = "high";
        }

        // Score candidates.
        const scored = candidates.map((c) => {
          let score = 0;

          // Tier match bonus.
          if (c.tier === preferredTier) score += 10;
          else if (
            (preferredTier === "high" && c.tier === "mid") ||
            (preferredTier === "low" && c.tier === "mid") ||
            (preferredTier === "mid" && c.tier !== "mid")
          ) {
            score += 5;
          }

          // Metrics-based scoring.
          if (c.metrics && c.metrics.total_requests >= 5) {
            // Lower error rate is better.
            score += (1 - c.metrics.error_rate) * 5;

            // Latency scoring.
            if (latencyPriority === "high") {
              // Strongly prefer low latency.
              score += Math.max(0, 5 - c.metrics.latency_p50_ms / 200);
            } else if (latencyPriority === "low") {
              // Don't penalize high latency (user doesn't care).
              score += 2;
            } else {
              score += Math.max(0, 3 - c.metrics.latency_p50_ms / 500);
            }
          }

          return { candidate: c, score };
        });

        // Check feedback for task-specific failures.
        const feedback = readFeedback(stateDirRef.value, 50);
        const failCounts: Record<string, number> = {};
        for (const f of feedback) {
          if (f.taskType === taskType && f.outcome === "failure") {
            failCounts[f.route] = (failCounts[f.route] ?? 0) + 1;
          }
        }
        for (const s of scored) {
          const fails = failCounts[s.candidate.model] ?? 0;
          if (fails > 0) {
            s.score -= fails * 2; // Penalize routes that fail for this task type.
          }
        }

        // Sort by score descending.
        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];
        const alternatives = scored
          .slice(1, 4)
          .map((s) => s.candidate.model);

        // Build rationale.
        const parts: string[] = [];
        parts.push(`${best.candidate.tier}-tier model`);
        if (best.candidate.metrics) {
          parts.push(`${best.candidate.metrics.latency_p50_ms}ms p50`);
        }
        parts.push(`for ${taskType}`);
        const rationale = parts.join(", ");

        return jsonResult({
          model: best.candidate.model,
          rationale,
          alternatives,
          score: best.score,
        });
      },
    },
    { optional: true }
  );

  // ── bitrouter_create_token ───────────────────────────────────────

  register(
    {
      name: "bitrouter_create_token",
      description:
        "Generate a scoped JWT token via the BitRouter CLI for API access.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: 'Token scope. Defaults to "api".',
          })
        ),
        exp: Type.Optional(
          Type.String({
            description: 'Expiration duration (e.g. "1h", "30m", "7d"). Defaults to "1h".',
          })
        ),
        models: Type.Optional(
          Type.Array(Type.String(), {
            description: "Restrict token to specific model names.",
          })
        ),
        budget: Type.Optional(
          Type.Number({
            description: "Budget limit in micro USD.",
          })
        ),
        budgetScope: Type.Optional(
          Type.String({
            description: "Budget scope identifier.",
          })
        ),
        budgetRange: Type.Optional(
          Type.String({
            description: 'Budget time range (e.g. "1h", "1d").',
          })
        ),
      }),
      execute: async (_id, params) => {
        const scope = (params.scope as string) ?? "api";
        const exp = (params.exp as string) ?? "1h";
        const models = params.models as string[] | undefined;
        const budget = params.budget as number | undefined;
        const budgetScope = params.budgetScope as string | undefined;
        const budgetRange = params.budgetRange as string | undefined;

        let binaryPath: string;
        try {
          binaryPath = await resolveBinaryPath(stateDirRef.value);
        } catch (err) {
          return errorResult(`Failed to resolve BitRouter binary: ${err}`);
        }

        const args = [
          "--home-dir",
          state.homeDir,
          "keygen",
          "--scope",
          scope,
          "--exp",
          exp,
        ];

        if (models && models.length > 0) {
          args.push("--models", models.join(","));
        }
        if (budget !== undefined) {
          args.push("--budget", String(budget));
        }
        if (budgetScope) {
          args.push("--budget-scope", budgetScope);
        }
        if (budgetRange) {
          args.push("--budget-range", budgetRange);
        }

        return new Promise<ToolResult>((resolve) => {
          execFile(
            binaryPath,
            args,
            { timeout: 10_000 },
            (err, stdout, stderr) => {
              if (err) {
                resolve(
                  errorResult(
                    `bitrouter keygen failed: ${err.message}${stderr ? `\n${stderr}` : ""}`
                  )
                );
                return;
              }
              resolve(textResult(stdout.trim()));
            }
          );
        });
      },
    },
    { optional: true }
  );
}
