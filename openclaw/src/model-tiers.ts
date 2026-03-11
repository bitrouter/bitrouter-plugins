/**
 * Static model tier map — maps known model IDs to capability tiers.
 *
 * Used by the route_task tool to recommend appropriate models based
 * on task type. Intentionally simple and static — a starting heuristic,
 * not a classifier.
 */

export type ModelTier = "high" | "mid" | "low";

export const MODEL_TIERS: Record<string, ModelTier> = {
  // Anthropic
  "claude-opus-4-6": "high",
  "claude-sonnet-4-6": "mid",
  "claude-haiku-4-5-20251001": "low",

  // OpenAI
  "gpt-4o": "high",
  "gpt-4o-mini": "low",
  "gpt-4-turbo": "high",
  "o1": "high",
  "o1-mini": "mid",
  "o3": "high",
  "o3-mini": "mid",
  "o4-mini": "mid",

  // Google
  "gemini-2.5-pro": "high",
  "gemini-2.5-flash": "mid",
  "gemini-2.0-flash": "low",
};

/**
 * Infer tier from a model ID using heuristics if not in the static map.
 */
export function getModelTier(modelId: string): ModelTier {
  if (MODEL_TIERS[modelId]) return MODEL_TIERS[modelId];

  const lower = modelId.toLowerCase();
  if ((lower.includes("opus") || lower.includes("pro") || lower.includes("4o")) && !lower.includes("mini")) return "high";
  if (lower.includes("haiku") || lower.includes("mini") || lower.includes("flash")) return "low";
  if (lower.includes("sonnet")) return "mid";

  return "mid"; // default
}
