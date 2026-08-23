import { randomUUID } from "node:crypto";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import { classifyProviderFailure, cooldownUntilFor, nextQuotaClass } from "../../control-plane/health/outcomes.js";
import type { RouteOutcomeClass } from "../../control-plane/health/types.js";
import type { ControlPlaneStore } from "../../control-plane/store.js";
import type { CommitmentState } from "../../providers/commitment.js";
import { commitmentOf } from "../../providers/provider-error.js";
import { ProviderAdapterError } from "../../providers/provider-adapter.js";
import { appendEntrySync } from "../../ledger/sqlite.js";
import { estimateCost } from "../../ledger/price-registry.js";
import { recordKeyUsage } from "../../management/keys.js";
import { updateAdaptiveHealth } from "./adaptive.js";
import { parseAffinity } from "./affinity.js";
import type { EffectiveRoute } from "../effective-route.js";
import { markOutputStarted } from "../effective-route.js";
import { NoEligibleAccountError, RouteSealedError } from "../errors.js";
import type { DecisionTrace } from "../eligibility/trace.js";
import { canRotate, isAbortError, isOutputOrToolEvent } from "./retry.js";
import type { RouteSelector, SelectInput } from "./selector.js";

export type PoolInvoke = (
  route: EffectiveRoute,
  signal: AbortSignal,
) => AsyncIterable<CanonicalEvent> | Iterable<CanonicalEvent>;

export type PoolExecution = Readonly<{
  route: EffectiveRoute;
  traces: readonly DecisionTrace[];
  events: readonly CanonicalEvent[];
}>;

export type PoolRequestInput = Readonly<{
  selector: RouteSelector;
  store: ControlPlaneStore;
  request: CanonicalRequest;
  select: Omit<SelectInput, "requestId" | "excludeAccountIds">;
  invoke: PoolInvoke;
  signal: AbortSignal;
  onTrace?: (trace: DecisionTrace) => void;
}>;

export async function executePoolRequest(input: PoolRequestInput): Promise<PoolExecution> {
  const events: CanonicalEvent[] = [];
  const traces: DecisionTrace[] = [];
  let route: EffectiveRoute | undefined;
  for await (const event of streamPoolRequest({
    ...input,
    onTrace: (trace) => {
      traces.push(trace);
      input.onTrace?.(trace);
    },
    onRoute: (selected) => {
      route = selected;
    },
  })) {
    events.push(event);
  }
  if (!route) throw new NoEligibleAccountError(input.request.id);
  return { route, traces, events };
}

/** Yields events only after rotation is no longer possible, so helpers never see a discarded attempt. */
export async function* streamPoolRequest(input: PoolRequestInput & {
  onRoute?: (route: EffectiveRoute) => void;
}): AsyncIterable<CanonicalEvent> {
  const pool = input.select.policy.snapshot.pools.find((item) => item.id === input.select.poolId);
  const retryBudget = pool?.retryBudget ?? 0;
  const affinity = parseAffinity(pool?.affinity);
  const tried: string[] = [];
  let lastError: Error | undefined;
  const ledgerEventId = randomUUID();
  let pendingInputTokens: number | undefined;
  let pendingOutputTokens: number | undefined;

  attempt: for (let rotationsUsed = 0; rotationsUsed < retryBudget + 1; rotationsUsed += 1) {
    let selected;
    try {
      selected = await input.selector.select({
        ...input.select,
        requestId: input.request.id,
        excludeAccountIds: tried,
      });
    } catch (error) {
      if (error instanceof NoEligibleAccountError && lastError !== undefined) throw lastError;
      throw error;
    }
    input.onTrace?.(selected.trace);
    input.selector.revalidate(selected.route, input.select);
    const buffered: CanonicalEvent[] = [];
    let route = selected.route;
    let live = false;
    // #121: provider-owned commitment evidence for THIS attempt. Starts
    // `not-sent`; advances on provider acknowledgement (response-started),
    // client output, and tool boundaries. Rotation consumes it.
    let commitment: CommitmentState = "not-sent";
    // #J6 core terminal-event invariant: a successful pool attempt requires a
    // provider terminal event (`response-completed`). An iterator that ends
    // naturally without one is a truncated upstream stream — never success.
    // Every shipped adapter emits the terminal event on completion; the core
    // now enforces the invariant itself so a future/regressed adapter can
    // never silently record success on a cut-off response.
    let terminal = false;
    const attemptStart = Date.now();
    const flush = function* (): Generator<CanonicalEvent> {
      input.onRoute?.(route);
      yield* buffered;
    };
    try {
      for await (const event of input.invoke(route, input.signal)) {
        if (event.type === "response-started" && commitment === "not-sent") commitment = "provider-accepted";
        if (event.type === "content-started" && event.contentType === "tool-call") commitment = "tool-boundary";
        if (event.type === "text-delta" || event.type === "reasoning-delta") commitment = "client-output-started";
        if (!route.outputStarted && isOutputOrToolEvent(event)) route = markOutputStarted(route);
        if (live) {
          yield event;
        } else {
          buffered.push(event);
          if (route.outputStarted) {
            live = true;
            yield* flush();
            buffered.length = 0;
          }
        }
        if (event.type === "usage-updated") {
          if (event.inputTokens !== undefined) pendingInputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) pendingOutputTokens = event.outputTokens;
          continue;
        }
        if (event.type === "response-completed") terminal = true;
        if (event.type !== "response-failed") continue;
        const outcome = classifyProviderFailure(event.code);
        recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
        try { updateAdaptiveHealth(input.store, route.accountId, Date.now() - attemptStart, false); } catch { void 0; }
        // when no acceptance preceded it; after provider acceptance the
        // attempt is committed and must never rotate.
        const failedCommitment: CommitmentState = commitment === "provider-accepted" || commitment === "client-output-started" || commitment === "tool-boundary" ? "provider-accepted" : "not-sent";
        lastError = new RouteFailure(outcome, event.code, event.message, failedCommitment);
        if (canRotate({ outputStarted: route.outputStarted, rotationsUsed, retryBudget, outcome, commitment: failedCommitment })) {
          tried.push(route.accountId);
          continue attempt;
        }
        throw route.outputStarted ? new RouteSealedError() : lastError;
      }
      // #J6: natural exhaustion without a terminal event is a truncated
      // stream. Mirror the `response-failed` handling: record a non-success
      // outcome, rotate only when nothing was accepted/output, and fail closed
      // once output has started (the client already saw partial content).
      if (!terminal) {
        const outcome: RouteOutcomeClass = "transient";
        const truncatedCommitment: CommitmentState = commitment === "provider-accepted" || commitment === "client-output-started" || commitment === "tool-boundary" ? "provider-accepted" : "not-sent";
        recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
        try { updateAdaptiveHealth(input.store, route.accountId, Date.now() - attemptStart, false); } catch { void 0; }
        lastError = new RouteFailure(outcome, "incomplete-stream", "Provider stream ended without a terminal response", truncatedCommitment);
        if (canRotate({ outputStarted: route.outputStarted, rotationsUsed, retryBudget, outcome, commitment: truncatedCommitment })) {
          tried.push(route.accountId);
          continue attempt;
        }
        throw route.outputStarted ? new RouteSealedError() : lastError;
      }
      recordOutcome(input.store, route, "success", affinity.cooldownSeconds);
      try { updateAdaptiveHealth(input.store, route.accountId, Date.now() - attemptStart, true); } catch { void 0; }
      try {
        const hasUsage = pendingInputTokens !== undefined || pendingOutputTokens !== undefined;
        if (hasUsage) {
          const policy = input.store.currentPolicy();
          const providerName = policy?.snapshot.providers.find((item) => item.id === route.providerId)?.name ?? route.providerId;
          const inputTokens = pendingInputTokens ?? 0;
          const outputTokens = pendingOutputTokens ?? 0;
          const cost = estimateCost({ model: route.modelId, inputTokens, outputTokens });
          if (inputTokens > 0 || outputTokens > 0 || cost > 0) {
            appendEntrySync(input.store.directory, {
              eventId: ledgerEventId,
              provider: providerName,
              model: route.modelId,
              inputTokens,
              outputTokens,
            });
          }
        }
        const govKeyId = (input.request as unknown as Record<string, unknown>).__governanceKeyId as string | undefined;
        if (typeof govKeyId === "string" && govKeyId.length > 0) {
          const cost = estimateCost({ model: route.modelId, inputTokens: pendingInputTokens ?? 0, outputTokens: pendingOutputTokens ?? 0 });
          if (cost > 0) recordKeyUsage(input.store, govKeyId, cost);
        }
      } catch { void 0; }
      yield* flush();
      return;
    } catch (error) {
      if (error instanceof RouteSealedError || error instanceof RouteFailure) {
        yield* flush();
        throw error;
      }
      if (isAbortError(error)) throw error;
      const outcome = classifyThrown(error);
      recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
      try { updateAdaptiveHealth(input.store, route.accountId, Date.now() - attemptStart, false, new Date(), error); } catch { void 0; }
      // anything without explicit `not-sent` evidence is conservatively
      // `unknown` (no replay).
      const thrownCommitment = commitmentOf(error);
      lastError = error instanceof Error ? error : new Error("provider invoke failed");
      if (!canRotate({ outputStarted: route.outputStarted, rotationsUsed, retryBudget, outcome, commitment: thrownCommitment })) {
        yield* flush();
        throw lastError;
      }
      tried.push(route.accountId);
    }
  }
  throw lastError ?? new NoEligibleAccountError(input.request.id);
}

export class RouteFailure extends ProviderAdapterError {
  override name = "RouteFailure";
  public constructor(
    readonly outcome: RouteOutcomeClass,
    code: string,
    message = "Provider request failed",
    commitment: CommitmentState = "not-sent",
  ) {
    super(code, message, undefined, commitment);
  }
}

function recordOutcome(
  store: ControlPlaneStore,
  route: EffectiveRoute,
  outcome: RouteOutcomeClass,
  cooldownSeconds: Readonly<{ auth: number; quota: number; transient: number }>,
): void {
  const cooldown = outcome === "success" ? null : cooldownUntilFor(outcome, store.currentTime(), cooldownSeconds);
  const current = store.getAccount(route.accountId);
  const consecutiveFailures = store.getHealth(route.accountId)?.consecutiveFailures ?? 0;
  const nextFailures = outcome === "success" ? 0 : consecutiveFailures + 1;
  store.recordRouteOutcome(route.accountId, {
    outcome,
    quotaClass: nextQuotaClass(outcome, current.quotaClass, nextFailures),
    cooldownUntil: cooldown ?? null,
  });
}

function classifyThrown(error: unknown): RouteOutcomeClass {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return classifyProviderFailure(code);
}
