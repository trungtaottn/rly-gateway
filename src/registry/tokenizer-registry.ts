import { conservativeTokenCount } from "../core/token-counting.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { ModelEvidence } from "./model-registry.js";

/** Static encoding map for known models. Unknown models fallback to conservative. */
export const TOKENIZER: Record<string, string> = {
  "openai/gpt-4o": "o200k_base",
  "openai/gpt-4": "cl100k_base",
  "openai/gpt-4-turbo": "cl100k_base",
  "openrouter/nvidia-nemotron-nano-9b-v2": "cl100k_base",
  "openrouter/deepseek-v4-flash": "cl100k_base",
};

export function getEncoding(model: string): string | undefined {
  return TOKENIZER[model];
}

export function isSupported(model: string): boolean {
  return model in TOKENIZER;
}

/** Lite count: uses TOKENIZER map when present but falls back to conservative estimate. Offline, no tiktoken-wasm. */
export function countTokens(request: CanonicalRequest, model: string): number | undefined {
  if (!isSupported(model)) return undefined;
  // Lite: still conservative; real tiktoken would be exact. Keep quality as conservative-estimate.
  return conservativeTokenCount(request).inputTokens;
}

export type LimitsGateResult = Readonly<{ exceeded: boolean; count: number; limit?: number }>;

export function preflightContextWindow(request: CanonicalRequest, evidence: ModelEvidence | undefined, model: string): LimitsGateResult {
  const limit = evidence?.limits.contextWindow;
  if (limit === undefined) return { exceeded: false, count: 0 };
  const count = countTokens(request, model) ?? conservativeTokenCount(request).inputTokens;
  // Reserve 100 tokens for overhead, fail fast like role-unmapped pre-selection
  return { exceeded: count > limit - 100, count, limit };
}
