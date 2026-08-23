import { createHash } from "node:crypto";
import { readPrivateTextIfPresent, writePrivateTextAtomically } from "../../storage/private-files.js";
import { controlPlanePaths } from "../../storage/paths.js";
import { DEFAULT_COOLDOWN_SECONDS } from "../../control-plane/health/outcomes.js";

export type ParsedAffinity = Readonly<{
  sessionEnabled: boolean;
  sessionTtlSeconds: number;
  quotaAware: boolean;
  cooldownSeconds: Readonly<{ auth: number; quota: number; transient: number }>;
}>;

export type AffinityBinding = Readonly<{
  sessionKeyHash: string;
  poolId: string;
  accountId: string;
  expiresAt: string;
}>;

export function hashSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex");
}

export function parseAffinity(value: unknown): ParsedAffinity {
  const root = isRecord(value) ? value : {};
  const session = isRecord(root["session"]) ? root["session"] : isRecord(root["sessionAffinity"]) ? root["sessionAffinity"] : {};
  const cooldown = isRecord(root["cooldownSeconds"]) ? root["cooldownSeconds"] : {};
  return {
    sessionEnabled: session["enabled"] === true,
    sessionTtlSeconds: positiveInteger(session["ttlSeconds"], 0),
    quotaAware: root["quotaAware"] === true,
    cooldownSeconds: {
      auth: positiveInteger(cooldown["auth"], DEFAULT_COOLDOWN_SECONDS.auth),
      quota: positiveInteger(cooldown["quota"], DEFAULT_COOLDOWN_SECONDS.quota),
      transient: positiveInteger(cooldown["transient"], DEFAULT_COOLDOWN_SECONDS.transient),
    },
  };
}

export class AffinityStore {
  public constructor(private readonly directory: string) {}
  private cache: { bindings: AffinityBinding[]; at: number } | undefined;

  public async load(now: Date): Promise<AffinityBinding[]> {
    const nowMs = now.getTime();
    if (this.cache !== undefined && nowMs - this.cache.at < 1000) {
      return this.cache.bindings.filter((item) => Date.parse(item.expiresAt) > nowMs);
    }
    const raw = await readPrivateTextIfPresent(controlPlanePaths(this.directory).selectorAffinity);
    if (raw === undefined) {
      this.cache = { bindings: [], at: nowMs };
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { sessions?: unknown };
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      const bindings = sessions.flatMap((item) => {
        const binding = asBinding(item);
        return binding !== undefined && Date.parse(binding.expiresAt) > nowMs ? [binding] : [];
      });
      this.cache = { bindings, at: nowMs };
      return bindings;
    } catch {
      this.cache = { bindings: [], at: nowMs };
      return [];
    }
  }

  public async save(bindings: readonly AffinityBinding[]): Promise<void> {
    this.cache = { bindings: [...bindings], at: Date.now() };
    await writePrivateTextAtomically(
      controlPlanePaths(this.directory).selectorAffinity,
      JSON.stringify({ sessions: bindings }),
    );
  }
  public async remember(
    current: readonly AffinityBinding[],
    binding: AffinityBinding,
  ): Promise<AffinityBinding[]> {
    const next = [...current.filter((item) => item.sessionKeyHash !== binding.sessionKeyHash || item.poolId !== binding.poolId), binding];
    await this.save(next);
    return next;
  }

  public async forget(
    current: readonly AffinityBinding[],
    sessionKeyHash: string,
  ): Promise<AffinityBinding[]> {
    const next = current.filter((item) => item.sessionKeyHash !== sessionKeyHash);
    await this.save(next);
    return next;
  }
}

function asBinding(value: unknown): AffinityBinding | undefined {
  if (!isRecord(value)) return undefined;
  const sessionKeyHash = value["sessionKeyHash"];
  const poolId = value["poolId"];
  const accountId = value["accountId"];
  const expiresAt = value["expiresAt"];
  if (
    typeof sessionKeyHash !== "string"
    || typeof poolId !== "string"
    || typeof accountId !== "string"
    || typeof expiresAt !== "string"
  ) {
    return undefined;
  }
  return { sessionKeyHash, poolId, accountId, expiresAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}
