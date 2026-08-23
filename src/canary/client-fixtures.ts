import type { ClientKind } from "./types.js";

/**
 * Pinned client contract registry (#24 / BL-043).
 *
 * The canary is fixture-first: the wire behaviors RLY relies on are pinned
 * here as redacted, synthetic contracts. When Claude Code or Codex changes one
 * of these contracts, the canary fails with a specific fixture/contract reason
 * instead of presenting the old version as verified.
 *
 * Baselines:
 * - `claude-code-2.1.229` is the pinned fixture baseline (protocol shapes and
 *   overlay composition). The observed local client (`CLAUDE_CODE_OBSERVED_VERSION`,
 *   currently 2.1.233) is recorded separately; observed ≠ supported baseline
 *   because the installed canary did not send an effort signal.
 * - `codex-cli-0.147.0-alpha.6.5` is the observed provisional Codex target. It
 *   is NOT a tested baseline; only the OpenAI Responses boundary RLY ships
 *   (`rly run codex`) is pinned.
 */

export type AttributionHeaderContract = Readonly<{
  session: string;
  agent: string;
  parentAgent: string;
  /** Case-insensitive on the wire; parsed from headers only, never bodies. */
  parsedLowercase: boolean;
}>;

export type ModelDiscoveryContract = Readonly<{
  /** Child-env opt-in flag RLY sets for RLY-launched Claude (#72). */
  enableEnvironmentVariable: string;
  /** Supported discovery request shape on the gateway listener. */
  request: Readonly<{ method: "GET"; path: string }>;
  /** The supported client only adds ids beginning with `claude`/`anthropic`. */
  idPrefixFilter: readonly string[];
  /** Discovery results are cached between startups by the client. */
  cacheAcrossStartups: boolean;
  /** RLY projection namespace is Claude-compatible under the filter. */
  rlyProjectionPrefix: string;
}>;

export type AliasContract = Readonly<{
  /** Portable tier aliases the supported baseline understands. */
  tiers: readonly ("haiku" | "sonnet" | "opus" | "fable")[];
  /** `fable` resolves as the strongest tier for the current context, not a global id. */
  fableSemantics: string;
  /** Exact physical ids are never reinterpreted as tiers. */
  exactIdsNotTiers: boolean;
}>;

export type EffortContract = Readonly<{
  /** Additive request field carrying Claude Code subagent/session effort. */
  requestField: string;
  effortLevels: readonly string[];
  /** The field is optional; absence never invents a source effort. */
  optional: boolean;
}>;

export type AdditiveFieldContract = Readonly<{
  /** Unknown additive fields are preserved/ignored, never assumed. */
  policy: "preserve-and-ignore";
  examples: readonly string[];
}>;

export type FramingContract = Readonly<{
  streamingEventOrder: readonly string[];
  /** Client abort is propagated to the upstream signal. */
  cancellationPropagates: boolean;
  /** Print mode adds `--no-session-persistence` to avoid session writes. */
  sessionIsolatedFlag: string;
}>;

export type ClientContract = Readonly<{
  schema: "rly-gateway/client-contract/1";
  kind: "redacted-synthetic-fixture";
  baseline: string;
  client: ClientKind;
  fixtureRevision: string;
  attribution: AttributionHeaderContract;
  modelDiscovery: ModelDiscoveryContract;
  aliases: AliasContract;
  effort: EffortContract;
  additiveFields: AdditiveFieldContract;
  framing: FramingContract;
}>;

export const CLAUDE_CODE_FIXTURE_BASELINE = "claude-code-2.1.229";
export const CODEX_CLI_OBSERVED_VERSION = "0.147.0-alpha.6.5";
/**
 * Observed installed Claude Code version. Observed ≠ supported baseline:
 * `CLAUDE_CODE_CONTRACT.baseline` stays `claude-code-2.1.229` because the
 * installed canary did not send an effort signal.
 */
export const CLAUDE_CODE_OBSERVED_VERSION = "2.1.233";

/** Pinned supported Claude Code baseline contract. */
export const CLAUDE_CODE_CONTRACT: ClientContract = Object.freeze({
  schema: "rly-gateway/client-contract/1",
  kind: "redacted-synthetic-fixture",
  baseline: CLAUDE_CODE_FIXTURE_BASELINE,
  client: "claude-code",
  fixtureRevision: "claude-code-2.1.229-contract-v1",
  attribution: Object.freeze({
    session: "X-Claude-Code-Session-Id",
    agent: "X-Claude-Code-Agent-Id",
    parentAgent: "X-Claude-Code-Parent-Agent-Id",
    parsedLowercase: true,
  }),
  modelDiscovery: Object.freeze({
    enableEnvironmentVariable: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
    request: Object.freeze({ method: "GET", path: "/v1/models" }),
    idPrefixFilter: Object.freeze(["claude", "anthropic"]),
    cacheAcrossStartups: true,
    rlyProjectionPrefix: "claude-rly-",
  }),
  aliases: Object.freeze({
    tiers: Object.freeze(["haiku" as const, "sonnet" as const, "opus" as const, "fable" as const]),
    fableSemantics: "contextual-strongest-tier",
    exactIdsNotTiers: true,
  }),
  effort: Object.freeze({
    requestField: "effort",
    effortLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    optional: true,
  }),
  additiveFields: Object.freeze({
    policy: "preserve-and-ignore",
    examples: Object.freeze(["beta-fields", "metadata", "unknown-additive"]),
  }),
  framing: Object.freeze({
    streamingEventOrder: Object.freeze([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]),
    cancellationPropagates: true,
    sessionIsolatedFlag: "--no-session-persistence",
  }),
});

/**
 * Observed Codex CLI contract (provisional, NOT a tested baseline). Only the
 * OpenAI Responses boundary RLY ships for `rly run codex` is pinned here.
 */
export const CODEX_CLI_CONTRACT: ClientContract = Object.freeze({
  schema: "rly-gateway/client-contract/1",
  kind: "redacted-synthetic-fixture",
  baseline: "codex-cli-observed",
  client: "codex-cli",
  fixtureRevision: "codex-cli-observed-contract-v1",
  attribution: Object.freeze({
    session: "X-Claude-Code-Session-Id",
    agent: "X-Claude-Code-Agent-Id",
    parentAgent: "X-Claude-Code-Parent-Agent-Id",
    parsedLowercase: true,
  }),
  modelDiscovery: Object.freeze({
    enableEnvironmentVariable: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
    request: Object.freeze({ method: "GET", path: "/v1/models" }),
    idPrefixFilter: Object.freeze([]),
    cacheAcrossStartups: false,
    rlyProjectionPrefix: "claude-rly-",
  }),
  aliases: Object.freeze({
    tiers: Object.freeze([]),
    fableSemantics: "unsupported",
    exactIdsNotTiers: true,
  }),
  effort: Object.freeze({
    requestField: "reasoning.effort",
    effortLevels: Object.freeze(["low", "medium", "high"]),
    optional: true,
  }),
  additiveFields: Object.freeze({
    policy: "preserve-and-ignore",
    examples: Object.freeze(["instructions", "include", "tools", "metadata"]),
  }),
  framing: Object.freeze({
    streamingEventOrder: Object.freeze([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]),
    cancellationPropagates: true,
    sessionIsolatedFlag: "--no-session-persistence",
  }),
});

export const CLIENT_CONTRACTS: Readonly<Record<ClientKind, ClientContract>> = Object.freeze({
  "claude-code": CLAUDE_CODE_CONTRACT,
  "codex-cli": CODEX_CLI_CONTRACT,
});
