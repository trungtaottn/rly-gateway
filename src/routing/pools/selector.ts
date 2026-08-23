import type { ControlPlaneStore } from "../../control-plane/store.js";
import type { PoolRecord } from "../../control-plane/types.js";
import { NoEligibleAccountError, StaleRouteBindingError } from "../errors.js";
import type { EffectiveRoute } from "../effective-route.js";
import type { CandidateAssessment } from "../eligibility/reasons.js";
import { createDecisionTrace, toTraceCandidates } from "../eligibility/trace.js";
import { assessAccount, assessPool, bindRoute, requirePool, sourceRuleFor } from "./assess.js";
import { hashSessionKey, parseAffinity, type AffinityBinding, type AffinityStore, type ParsedAffinity } from "./affinity.js";
import { computeScore, getAdaptiveHealthMap, shouldUseAdaptive } from "./adaptive.js";
import {
  eligibleCandidates,
  orderByQuotaThenPin,
  selectFillFirst,
  selectManual,
  selectRoundRobin,
} from "./strategies.js";
import type { SelectInput, SelectResult } from "./types.js";

export type { SelectInput, SelectResult };

export class RouteSelector {
  private readonly cursors = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  public constructor(
    private readonly store: ControlPlaneStore,
    private readonly affinity: AffinityStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public resetEphemeralState(): void {
    this.cursors.clear();
  }

  public cursorFor(poolId: string): number {
    return this.cursors.get(poolId) ?? 0;
  }

  public select(input: SelectInput): Promise<SelectResult> {
    return this.serialize(input.poolId, () => this.selectLocked(input));
  }
  public revalidate(route: EffectiveRoute, input: Omit<SelectInput, "requestId" | "modelId" | "adapterId" | "role">): void {
    const now = this.clock();
    const pool = requirePool(input.policy, input.poolId);
    const assessment = assessAccount(this.store, route.accountId, pool, input, now);
    if (assessment === undefined || !assessment.eligible) {
      throw new StaleRouteBindingError("eligible state changed before invoke");
    }
    if (assessment.credentialGeneration !== route.credentialGeneration) {
      throw new StaleRouteBindingError("credential generation changed before invoke");
    }
  }

  private async selectLocked(input: SelectInput): Promise<SelectResult> {
    const now = this.clock();
    const pool = requirePool(input.policy, input.poolId);
    const affinity = parseAffinity(pool.affinity);
    const assessments = assessPool(this.store, pool, input, now);
    const exclude = new Set(input.excludeAccountIds ?? []);
    const bindings = await this.affinity.load(now);
    const sessionHash = input.sessionKey === undefined ? undefined : hashSessionKey(input.sessionKey);
    const sticky = await this.takeAffinity(
      assessments,
      bindings,
      pool,
      affinity,
      sessionHash,
      exclude,
    );
    const selected = sticky ?? this.applyStrategy(assessments, pool, affinity, input.pinnedAccountId, exclude);
    const decidedAt = now.toISOString();
    const sourceRule = sourceRuleFor(pool.strategy, sticky !== undefined);
    const trace = createDecisionTrace({
      requestId: input.requestId,
      policyRevision: input.policy.revision,
      policyHash: input.policy.hash,
      strategy: pool.strategy,
      sourceRule,
      candidates: toTraceCandidates(assessments),
      decidedAt,
      ...(selected === undefined ? {} : {
        selected: {
          accountPseudonym: selected.accountPseudonym,
          credentialGeneration: selected.credentialGeneration,
        },
      }),
    });
    if (selected === undefined) throw new NoEligibleAccountError(input.requestId);
    if (sessionHash !== undefined && affinity.sessionEnabled && affinity.sessionTtlSeconds > 0) {
      await this.affinity.remember(bindings, {
        sessionKeyHash: sessionHash,
        poolId: pool.id,
        accountId: selected.accountId,
        expiresAt: new Date(now.getTime() + affinity.sessionTtlSeconds * 1000).toISOString(),
      });
    }
    return {
      route: bindRoute(input, pool, selected, sourceRule, decidedAt),
      trace,
    };
  }

  private applyStrategy(
    assessments: readonly CandidateAssessment[],
    pool: PoolRecord,
    affinity: ParsedAffinity,
    pinnedAccountId: string | undefined,
    exclude: ReadonlySet<string>,
  ): CandidateAssessment | undefined {
    if (pool.strategy === "manual") return selectManual(assessments, pinnedAccountId, exclude);
    let eligible = eligibleCandidates(assessments, exclude);
    if (affinity.quotaAware) eligible = orderByQuotaThenPin(eligible);
    if (pool.strategy === "fill-first") return selectFillFirst(eligible);
    if (pool.strategy === "adaptive") {
      const healthMap = getAdaptiveHealthMap(this.store, eligible.map((candidate) => candidate.accountId));
      if (shouldUseAdaptive(eligible, healthMap)) {
        const sorted = [...eligible].sort((a, b) => computeScore(healthMap.get(a.accountId), a.quotaClass) - computeScore(healthMap.get(b.accountId), b.quotaClass));
        return sorted[0];
      }
      return selectFillFirst(eligible);
    }
    const picked = selectRoundRobin(eligible, this.cursors.get(pool.id) ?? 0);
    if (picked === undefined) return undefined;
    this.cursors.set(pool.id, picked.nextCursor);
    return picked.selected;
  }

  private async takeAffinity(
    assessments: readonly CandidateAssessment[],
    bindings: readonly AffinityBinding[],
    pool: PoolRecord,
    affinity: ParsedAffinity,
    sessionHash: string | undefined,
    exclude: ReadonlySet<string>,
  ): Promise<CandidateAssessment | undefined> {
    if (sessionHash === undefined || !affinity.sessionEnabled || affinity.sessionTtlSeconds <= 0 || pool.strategy === "manual") {
      return undefined;
    }
    const binding = bindings.find((item) => item.sessionKeyHash === sessionHash && item.poolId === pool.id);
    if (binding === undefined) return undefined;
    const matched = assessments.find((item) => item.accountId === binding.accountId);
    if (matched?.eligible === true && !exclude.has(matched.accountId)) return matched;
    await this.affinity.forget(bindings, sessionHash);
    return undefined;
  }

  private serialize<T>(poolId: string, work: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(poolId) ?? Promise.resolve();
    const run = tail.then(work, work);
    this.tails.set(poolId, run.then(() => undefined, () => undefined));
    return run;
  }
}
