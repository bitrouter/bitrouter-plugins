/**
 * Feedback endpoint — accepts external signals about task outcomes
 * and writes them to an append-only JSONL file.
 *
 * Registered as POST /bitrouter/feedback via api.registerHttpRoute().
 * The route_task tool can read this file to adjust recommendations.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import type { FeedbackSignal, OpenClawPluginApi } from "./types.js";

/**
 * Register the POST /bitrouter/feedback HTTP route.
 */
export function registerFeedbackRoute(
  api: OpenClawPluginApi,
  stateDirRef: { value: string }
): void {
  api.registerHttpRoute({
    path: "/bitrouter/feedback",
    auth: "gateway",
    handler: async (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ): Promise<boolean | void> => {
      if (req.method !== "POST") return false;

      const feedbackPath = path.join(stateDirRef.value, "bitrouter", "feedback.jsonl");

      // Read body from stream.
      const rawBody = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk: Buffer | string) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return true;
      }

      const signal = body as Record<string, unknown>;

      // Validate required fields.
      if (!signal?.route || typeof signal.route !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Missing or invalid "route" field' }));
        return true;
      }
      if (!signal.outcome || (signal.outcome !== "success" && signal.outcome !== "failure")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"outcome" must be "success" or "failure"' }));
        return true;
      }

      const entry: FeedbackSignal = {
        route: signal.route,
        outcome: signal.outcome,
        taskType: typeof signal.taskType === "string" ? signal.taskType : undefined,
        timestamp: typeof signal.timestamp === "number" ? signal.timestamp : Date.now(),
      };

      // Ensure directory exists.
      fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });

      // Append to JSONL.
      fs.appendFileSync(feedbackPath, JSON.stringify(entry) + "\n", "utf-8");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    },
  });
}

/**
 * Read recent feedback entries from the JSONL file.
 * Returns the last N entries (default 100).
 */
export function readFeedback(
  dataDir: string,
  limit = 100
): FeedbackSignal[] {
  const feedbackPath = path.join(dataDir, "bitrouter", "feedback.jsonl");

  if (!fs.existsSync(feedbackPath)) return [];

  const lines = fs.readFileSync(feedbackPath, "utf-8").trim().split("\n");
  const recent = lines.slice(-limit);

  const entries: FeedbackSignal[] = [];
  for (const line of recent) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FeedbackSignal);
    } catch {
      // Skip malformed lines.
    }
  }

  return entries;
}
