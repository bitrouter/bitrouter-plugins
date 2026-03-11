/**
 * Feedback endpoint — accepts external signals about task outcomes
 * and writes them to an append-only JSONL file.
 *
 * Registered as POST /bitrouter/feedback via api.registerHttpRoute().
 * The route_task tool can read this file to adjust recommendations.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { FeedbackSignal, OpenClawPluginApi } from "./types.js";

/**
 * Register the POST /bitrouter/feedback HTTP route.
 */
export function registerFeedbackRoute(api: OpenClawPluginApi): void {
  const feedbackPath = path.join(api.getDataDir(), "bitrouter", "feedback.jsonl");

  api.registerHttpRoute({
    method: "POST",
    path: "/bitrouter/feedback",
    handler: async (req) => {
      let body: unknown;
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } catch {
        return { status: 400, body: { error: "Invalid JSON body" } };
      }

      const signal = body as Record<string, unknown>;

      // Validate required fields.
      if (!signal.route || typeof signal.route !== "string") {
        return { status: 400, body: { error: 'Missing or invalid "route" field' } };
      }
      if (!signal.outcome || (signal.outcome !== "success" && signal.outcome !== "failure")) {
        return {
          status: 400,
          body: { error: '"outcome" must be "success" or "failure"' },
        };
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

      return { status: 200, body: { ok: true } };
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
