/**
 * HTTP routes — registers `/bitrouter/*` endpoints via api.registerHttpRoute()
 * that proxy to BitRouter's native HTTP API.
 *
 * These routes enable external monitoring and tooling (e.g. Prometheus
 * scraping, browser dashboards, CI scripts) to access BitRouter's state
 * through OpenClaw's HTTP server.
 *
 * All routes use `auth: "plugin"` and proxy directly to BitRouter,
 * injecting the appropriate auth token. Responses are always-fresh
 * (no caching layer — BitRouter itself is the source of truth).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BitrouterState, OpenClawPluginApi } from "./types.js";

// ── Proxy helper ─────────────────────────────────────────────────────

/**
 * Proxy a GET request to BitRouter's HTTP API.
 *
 * Forwards the request to `state.baseUrl + targetPath`, injecting the
 * API or admin token as needed. Streams the response back to the client.
 */
async function proxyToBitrouter(
  state: BitrouterState,
  targetPath: string,
  res: ServerResponse,
  options: { useAdmin?: boolean; method?: string; body?: string } = {},
): Promise<boolean> {
  if (!state.healthy) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "BitRouter is not healthy" }));
    return true;
  }

  try {
    const token = options.useAdmin ? state.adminToken : state.apiToken;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const fetchOpts: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
    };

    const upstream = await fetch(`${state.baseUrl}${targetPath}`, fetchOpts);
    clearTimeout(timeout);

    // Forward status and content-type.
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    res.writeHead(upstream.status, { "Content-Type": contentType });

    // Stream body.
    const body = await upstream.text();
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy error: ${err}` }));
  }

  return true;
}

/**
 * Read the full request body from an IncomingMessage.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── Route registration ───────────────────────────────────────────────

/**
 * Register HTTP routes that proxy to BitRouter's native endpoints.
 *
 * Routes:
 *   GET /bitrouter/status  → /health
 *   GET /bitrouter/metrics → /v1/metrics
 *   GET /bitrouter/routes  → /v1/routes
 *   GET /bitrouter/models  → /v1/models
 */
export function registerHttpRoutes(
  api: OpenClawPluginApi,
  state: BitrouterState
): void {
  // GET /bitrouter/status — daemon health check
  api.registerHttpRoute({
    path: "/bitrouter/status",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/health", res),
  });

  // GET /bitrouter/metrics — request counts, latency, spend
  api.registerHttpRoute({
    path: "/bitrouter/metrics",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/v1/metrics", res),
  });

  // GET /bitrouter/routes — active routing table
  api.registerHttpRoute({
    path: "/bitrouter/routes",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/v1/routes", res),
  });

  // GET /bitrouter/models — model catalog with capabilities
  api.registerHttpRoute({
    path: "/bitrouter/models",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/v1/models", res),
  });

  // GET /bitrouter/agents — upstream A2A agents
  api.registerHttpRoute({
    path: "/bitrouter/agents",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/v1/agents", res),
  });

  // GET /bitrouter/tools — unified MCP tools + skills
  api.registerHttpRoute({
    path: "/bitrouter/tools",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/v1/tools", res),
  });

  // GET /bitrouter/skills — registered skills
  api.registerHttpRoute({
    path: "/bitrouter/skills",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (_req: IncomingMessage, res: ServerResponse) =>
      proxyToBitrouter(state, "/v1/skills", res),
  });

  // POST /bitrouter/mcp — JSON-RPC proxy to MCP gateway
  api.registerHttpRoute({
    path: "/bitrouter/mcp",
    auth: "plugin" as const,
    match: "exact" as const,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      return proxyToBitrouter(state, "/mcp", res, { method: "POST", body });
    },
  });
}
