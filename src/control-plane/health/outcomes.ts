import type { RouteOutcomeClass } from "./types.js";

export const DEFAULT_COOLDOWN_SECONDS = Object.freeze({
  auth: 60,
  quota: 300,
  transient: 15,
});

export function classifyProviderFailure(code: string | undefined): RouteOutcomeClass {
  if (code === "authentication_error") return "auth";
  if (code === "rate_limit_error") return "quota";
  if (code === "api_error") return "transient";
  return "fatal";
}

export function cooldownUntilFor(
  outcome: RouteOutcomeClass,
  now: Date,
  seconds: Readonly<{ auth: number; quota: number; transient: number }> = DEFAULT_COOLDOWN_SECONDS,
): string | undefined {
  const duration =
    outcome === "auth" ? seconds.auth : outcome === "quota" ? seconds.quota : outcome === "transient" ? seconds.transient : 0;
  if (duration <= 0) return undefined;
  return new Date(now.getTime() + duration * 1000).toISOString();
}

export function nextQuotaClass(outcome: RouteOutcomeClass, current: string, consecutiveFailures = 0): string {
  if (outcome === "success") return "healthy";
  if (outcome === "quota") return "exhausted";
  if (outcome === "transient" && consecutiveFailures >= 3) {
    if (current === "healthy") return "warning";
    if (current === "warning") return "unknown";
  }
  return current;
}
