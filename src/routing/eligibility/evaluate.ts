import type { ProviderCapabilities, CapabilityRequirement } from "../../core/capabilities.js";
import { missingCapabilities } from "../../core/capabilities.js";
import type { AccountRecord, ProviderRecord } from "../../control-plane/types.js";
import type { HealthRecord } from "../../control-plane/health/types.js";
import type { CandidateAssessment, CredentialSnapshot, EligibilityReason } from "./reasons.js";

export type EligibilityInput = Readonly<{
  account: AccountRecord;
  provider: ProviderRecord | undefined;
  pinOrder: number;
  now: Date;
  credential: CredentialSnapshot | undefined;
  required: readonly CapabilityRequirement[];
  capabilities: ProviderCapabilities;
  health: HealthRecord | undefined;
}>;

export function boundGeneration(account: AccountRecord, credential: CredentialSnapshot | undefined): number {
  if (credential && credential.generation > 0) return credential.generation;
  return account.credentialGeneration;
}

export function evaluateEligibility(input: EligibilityInput): CandidateAssessment {
  const reasons: EligibilityReason[] = [];
  const generation = boundGeneration(input.account, input.credential);
  if (input.provider === undefined || !input.provider.enabled) reasons.push("provider-disabled");
  if (input.account.state === "paused") reasons.push("paused");
  if (input.account.state === "revoked") reasons.push("revoked");
  if (input.account.state === "unready" || input.credential === undefined || !input.credential.present) {
    reasons.push("auth-unready");
  }
  if (generation < 1) reasons.push("generation-unbound");
  if (isExpired(input.credential, input.now)) reasons.push("expired");
  if (isCooling(input.account.cooldownUntil, input.health?.cooldownUntil, input.now)) reasons.push("cooling");
  if (input.account.quotaClass === "exhausted") reasons.push("quota-exhausted");
  if (missingCapabilities(input.capabilities, input.required).length > 0) reasons.push("capability-incompatible");
  const requiredTerms = input.provider?.requiredTermsRevision;
  if (requiredTerms !== undefined && requiredTerms !== input.account.termsAcknowledgedRevision) {
    reasons.push("terms-unaccepted");
  }
  return {
    accountId: input.account.id,
    accountPseudonym: input.account.pseudonym,
    credentialHandle: input.account.credentialHandle,
    credentialGeneration: generation,
    pinOrder: input.pinOrder,
    quotaClass: input.account.quotaClass,
    eligible: reasons.length === 0,
    reasons,
  };
}

function isExpired(credential: CredentialSnapshot | undefined, now: Date): boolean {
  if (credential?.expiresAt === undefined) return false;
  const expires = Date.parse(credential.expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

function isCooling(accountCooldown: string | undefined, healthCooldown: string | undefined, now: Date): boolean {
  return isFuture(accountCooldown, now) || isFuture(healthCooldown, now);
}

function isFuture(value: string | undefined, now: Date): boolean {
  if (value === undefined) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now.getTime();
}
