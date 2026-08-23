import type { ProviderCapabilityEvidence } from "../registry/model-registry.js";

export type IntegrationMode = "direct" | "oauth" | "bridge";
export type AccountState = "ready" | "paused" | "unready" | "revoked";
export type PoolStrategy = "manual" | "round-robin" | "fill-first" | "adaptive";
export type HarnessName = "claude" | "codex";
export type ManagementActor = "cli" | "browser" | "system";
export type AuditResult = "ok" | "rejected";

export type Clock = () => Date;

export type ProviderRecord = Readonly<{
  id: string;
  name: string;
  integrationMode: IntegrationMode;
  endpointPolicy: string | undefined;
  capabilityEvidence: ProviderCapabilityEvidence | undefined;
  requiredTermsRevision: string | undefined;
  provenanceRef: string | undefined;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type AccountRecord = Readonly<{
  id: string;
  pseudonym: string;
  providerId: string;
  credentialHandle: string;
  credentialGeneration: number;
  state: AccountState;
  pauseReason: string | undefined;
  quotaClass: string;
  cooldownUntil: string | undefined;
  termsRevision: string | undefined;
  termsAcknowledgedRevision: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type MembershipRecord = Readonly<{
  poolId: string;
  accountId: string;
  pinOrder: number | undefined;
}>;

export type PoolRecord = Readonly<{
  id: string;
  name: string;
  providerId: string;
  strategy: PoolStrategy;
  affinity: unknown;
  retryBudget: number;
  memberships: readonly MembershipRecord[];
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type ProfileRecord = Readonly<{
  id: string;
  name: string;
  harness: HarnessName;
  providerId: string | undefined;
  poolId: string | undefined;
  modelRoles: Readonly<Record<string, string>>;
  capabilityPolicy: unknown;
  launchPolicy: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type PolicyRevision = Readonly<{
  revision: number;
  hash: string;
  createdAt: string;
  snapshot: Readonly<{
    providers: readonly ProviderRecord[];
    accounts: readonly AccountRecord[];
    pools: readonly PoolRecord[];
    profiles: readonly ProfileRecord[];
  }>;
}>;

export type AuditEvent = Readonly<{
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | undefined;
  actor: ManagementActor;
  result: AuditResult;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type CreateProviderInput = Readonly<{
  name: string;
  integrationMode: IntegrationMode;
  endpointPolicy?: string | undefined;
  capabilityEvidence?: ProviderCapabilityEvidence | undefined;
  requiredTermsRevision?: string | undefined;
  provenanceRef?: string | undefined;
}>;

export type UpdateProviderInput = Readonly<{
  name?: string | undefined;
  integrationMode?: IntegrationMode | undefined;
  endpointPolicy?: string | undefined;
  capabilityEvidence?: ProviderCapabilityEvidence | undefined;
  requiredTermsRevision?: string | undefined;
  provenanceRef?: string | undefined;
  enabled?: boolean | undefined;
}>;

export type CreateAccountInput = Readonly<{
  pseudonym: string;
  providerId: string;
  credentialHandle: string;
  state?: AccountState | undefined;
  quotaClass?: string | undefined;
}>;

export type UpdateAccountInput = Readonly<{
  state?: AccountState | undefined;
  pauseReason?: string | undefined;
  quotaClass?: string | undefined;
}>;

export type BindCredentialInput = Readonly<{
  credentialHandle: string;
  credentialGeneration: number;
  state: AccountState;
}>;

export type CreatePoolInput = Readonly<{
  name: string;
  providerId: string;
  strategy: PoolStrategy;
  affinity?: unknown;
  retryBudget?: number | undefined;
  accountIds?: readonly string[] | undefined;
}>;

export type UpdatePoolInput = Readonly<{
  name?: string | undefined;
  strategy?: PoolStrategy | undefined;
  affinity?: unknown;
  retryBudget?: number | undefined;
  accountIds?: readonly string[] | undefined;
}>;

export type CreateProfileInput = Readonly<{
  name: string;
  harness: HarnessName;
  providerId?: string | undefined;
  poolId?: string | undefined;
  modelRoles: Readonly<Record<string, string>>;
  capabilityPolicy?: unknown;
  launchPolicy?: unknown;
}>;

export type UpdateProfileInput = Readonly<{
  name?: string | undefined;
  harness?: HarnessName | undefined;
  providerId?: string | undefined;
  poolId?: string | undefined;
  modelRoles?: Readonly<Record<string, string>> | undefined;
  capabilityPolicy?: unknown;
  launchPolicy?: unknown;
}>;
