import { writePrivateTextAtomically, readPrivateTextIfPresent, removePrivateFileIfPresent } from "../storage/private-files.js";
import { controlPlanePaths } from "../storage/paths.js";
import { ControlPlaneError, NotFoundError, ValidationError, VersionConflictError } from "../control-plane/errors.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { AccountRecord, ManagementActor } from "../control-plane/types.js";
import { providerContract, type CredentialProviderName } from "../providers/catalog.js";
import { CredentialUnreadyError, isCredentialError, OAuthFlowError } from "./errors.js";
import type { CredentialBroker } from "./broker.js";
import type { CredentialMetadata } from "./record.js";
import { assertProviderCredential, parseCredentialRef } from "./credential-ref.js";

export type AccountReadiness = "ready" | "unready" | "expired" | "paused" | "revoked";

export class CredentialService {
  private pendingLoginProviderId: string | undefined;
  private finishingLogin: Promise<AccountRecord> | undefined;

  public constructor(
    private readonly store: ControlPlaneStore,
    private readonly broker: CredentialBroker,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  public async previewImport(sourcePath: string, providerId?: string): Promise<unknown> {
    if (!providerId) throw new ValidationError("credential preview requires a provider id");
    return this.broker.previewImport(sourcePath, this.usesClineImport(providerId) ? "cline" : "codex");
  }

  public async importCodex(input: Readonly<{
    sourcePath: string;
    providerId: string;
    pseudonym: string;
    sourceFingerprint: string;
  }>, actor: ManagementActor): Promise<AccountRecord> {
    this.requireOauthProvider(input.providerId);
    const source = {
      sourcePath: input.sourcePath,
      pseudonym: input.pseudonym,
      sourceFingerprint: input.sourceFingerprint,
    };
    const metadata = this.usesClineImport(input.providerId)
      ? await this.broker.importCline(source)
      : await this.broker.importCodex(source);
    return this.attachOrRevoke(input.providerId, input.pseudonym, metadata, actor);
  }

  /** Stores an approved environment-variable reference, never its value. */
  public createDirectEnvironmentAccount(input: Readonly<{
    providerId: string;
    pseudonym: string;
    credentialRef: string;
  }>, actor: ManagementActor): AccountRecord {
    const provider = this.store.listProviders().find((item) => item.id === input.providerId);
    if (!provider || provider.integrationMode !== "direct") {
      throw new ValidationError("environment credential accounts require a direct provider");
    }
    const ref = this.parseEnvCredentialRef(input.credentialRef);
    try {
      assertProviderCredential(provider.name, ref);
    } catch {
      throw new ValidationError("credential reference is not approved for the selected provider");
    }
    const handle = `env:${ref.name}`;
    const created = this.store.createAccount({
      pseudonym: input.pseudonym,
      providerId: provider.id,
      credentialHandle: handle,
      state: "unready",
    }, actor);
    return this.store.bindCredential(created.id, created.version, {
      credentialHandle: handle,
      credentialGeneration: 1,
      state: "ready",
    }, actor);
  }

  public async startLogin(input: Readonly<{ providerId: string; pseudonym: string }>, actor: ManagementActor): Promise<Readonly<{
    authorizationUrl: string;
    state: string;
    redirectUri: string;
  }>> {
    const provider = this.requireOauthProvider(input.providerId);
    if (this.usesClineImport(input.providerId)) {
      throw new ValidationError("cline accounts are imported, not logged in");
    }
    const started = await this.broker.startLogin({
      ...input,
      provider: provider.credentialProvider,
    });
    this.pendingLoginProviderId = input.providerId;
    this.finishingLogin = this.finishOnce(actor);
    return started;
  }

  public finishLogin(actor: ManagementActor): Promise<AccountRecord> {
    return this.finishingLogin ?? this.finishOnce(actor);
  }

  public async cancelLogin(state: string): Promise<void> {
    this.pendingLoginProviderId = undefined;
    this.finishingLogin = undefined;
    await this.broker.cancelLogin(state);
  }

  private async finishOnce(actor: ManagementActor): Promise<AccountRecord> {
    const metadata = await this.broker.waitForLogin();
    const providerId = this.pendingLoginProviderId ?? this.missingProvider();
    try {
      return await this.attachOrRevoke(providerId, metadata.pseudonym, metadata, actor);
    } finally {
      this.pendingLoginProviderId = undefined;
    }
  }

  public async refresh(accountId: string, version: number, actor: ManagementActor): Promise<AccountRecord> {
    const account = this.account(accountId);
    try {
      const metadata = await this.broker.refresh(account.credentialHandle);
      return this.bindReady(account, version, metadata, actor);
    } catch (error) {
      if (error instanceof OAuthFlowError && error.code === "invalid-grant") {
        const current = this.account(accountId);
        const latest = await this.broker.metadata(current.credentialHandle);
        if (latest && latest.generation > current.credentialGeneration) {
          return this.bindReady(current, current.version, latest, actor);
        }
        return this.store.bindCredential(current.id, current.version, {
          credentialHandle: current.credentialHandle,
          credentialGeneration: current.credentialGeneration,
          state: "unready",
        }, actor);
      }
      throw error;
    }
  }

  public async revoke(accountId: string, version: number, actor: ManagementActor): Promise<AccountRecord> {
    const account = this.account(accountId);
    if (account.version !== version) throw new VersionConflictError("account");
    const revoked = this.store.bindCredential(account.id, version, {
      credentialHandle: account.credentialHandle,
      credentialGeneration: account.credentialGeneration,
      state: "revoked",
    }, actor);
    await this.broker.revoke(account.credentialHandle);
    if (await this.selectedAccountId() === account.id) await this.clearSelection();
    return revoked;
  }

  public async select(accountId: string, version: number, actor: ManagementActor): Promise<AccountRecord> {
    void actor;
    const account = this.store.getAccount(accountId);
    if (account.version !== version) throw new VersionConflictError("account");
    if (await this.readiness(account) !== "ready") throw new CredentialUnreadyError("account is not ready for manual selection");
    await writePrivateTextAtomically(controlPlanePaths(this.store.directory).manualSelection, JSON.stringify({ accountId: account.id }));
    return account;
  }

  public async selectedAccountId(): Promise<string | undefined> {
    const raw = await readPrivateTextIfPresent(controlPlanePaths(this.store.directory).manualSelection);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { accountId?: unknown };
      return typeof parsed.accountId === "string" ? parsed.accountId : undefined;
    } catch {
      return undefined;
    }
  }

  public async readiness(account: AccountRecord, environment: NodeJS.ProcessEnv = this.environment): Promise<AccountReadiness> {
    if (account.state === "paused") return "paused";
    if (account.state === "revoked") return "revoked";
    if (account.credentialHandle.startsWith("env:")) {
      const name = account.credentialHandle.slice(4);
      if (!environment[name]) return "unready";
      const provider = this.store.listProviders().find((item) => item.id === account.providerId);
      if (provider?.requiredTermsRevision && provider.requiredTermsRevision !== account.termsAcknowledgedRevision) {
        return "unready";
      }
      return account.credentialGeneration >= 1 && account.state === "ready" ? "ready" : "unready";
    }
    const metadata = await this.broker.metadata(account.credentialHandle);
    if (!metadata || metadata.generation < 1) return "unready";
    if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) return "expired";
    const provider = this.store.listProviders().find((item) => item.id === account.providerId);
    if (provider?.requiredTermsRevision && provider.requiredTermsRevision !== account.termsAcknowledgedRevision) {
      return "unready";
    }
    return account.state === "ready" ? "ready" : "unready";
  }

  public async resolveSelected(): Promise<AccountRecord | undefined> {
    const selected = await this.selectedAccountId();
    if (!selected) return undefined;
    const account = this.store.listAccounts().find((item) => item.id === selected);
    if (!account || await this.readiness(account) !== "ready") return undefined;
    return account;
  }

  private async attachOrRevoke(
    providerId: string,
    pseudonym: string,
    metadata: CredentialMetadata,
    actor: ManagementActor,
  ): Promise<AccountRecord> {
    try {
      return this.attachAccount(providerId, pseudonym, metadata, actor);
    } catch (error) {
      await this.broker.revoke(metadata.handle).catch(() => undefined);
      throw error;
    }
  }

  private parseEnvCredentialRef(value: string): Extract<ReturnType<typeof parseCredentialRef>, { kind: "env" }> {
    try {
      const ref = parseCredentialRef(value);
      if (ref.kind !== "env") throw new ValidationError("direct account credentials must reference an environment variable");
      return ref;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError("direct account credentials must reference an approved environment variable");
    }
  }

  private requireOauthProvider(providerId: string): { credentialProvider: CredentialProviderName } {
    const provider = this.store.listProviders().find((item) => item.id === providerId);
    if (!provider || provider.integrationMode !== "oauth") this.missingProvider();
    const credentialProvider = providerContract(provider.name)?.credentialProvider;
    if (!credentialProvider) this.missingProvider();
    return { credentialProvider };
  }

  private usesClineImport(providerId: string): boolean {
    return providerContract(this.providerName(providerId) ?? "")?.importMode === "opt-in-interoperability";
  }

  private bindReady(
    account: AccountRecord,
    version: number,
    metadata: CredentialMetadata,
    actor: ManagementActor,
  ): AccountRecord {
    return this.store.bindCredential(account.id, version, {
      credentialHandle: metadata.handle,
      credentialGeneration: metadata.generation,
      state: "ready",
    }, actor);
  }

  private attachAccount(
    providerId: string,
    pseudonym: string,
    metadata: CredentialMetadata,
    actor: ManagementActor,
  ): AccountRecord {
    this.assertCredentialMatchesProvider(providerId, metadata);
    const existing = this.store.listAccounts().find(
      (account) => account.providerId === providerId && account.pseudonym === pseudonym,
    );
    if (existing) {
      const previous = existing.credentialHandle;
      const bound = this.bindReady(existing, existing.version, metadata, actor);
      if (previous !== metadata.handle) void this.broker.revoke(previous).catch(() => undefined);
      return bound;
    }
    const created = this.store.createAccount({
      pseudonym,
      providerId,
      credentialHandle: metadata.handle,
      state: "unready",
    }, actor);
    return this.bindReady(created, created.version, metadata, actor);
  }

  private assertCredentialMatchesProvider(providerId: string, metadata: CredentialMetadata): void {
    const expected = providerContract(this.providerName(providerId) ?? "")?.credentialProvider;
    if (expected === undefined || metadata.provider !== expected) {
      throw new ValidationError("credential provider does not match account provider");
    }
  }

  private account(id: string): AccountRecord {
    const account = this.store.listAccounts().find((item) => item.id === id);
    if (!account) throw new NotFoundError("account");
    return account;
  }

  private providerName(providerId: string): string | undefined {
    return this.store.listProviders().find((item) => item.id === providerId)?.name;
  }

  private missingProvider(): never {
    throw new ValidationError("oauth provider was not found");
  }

  private async clearSelection(): Promise<void> {
    await removePrivateFileIfPresent(controlPlanePaths(this.store.directory).manualSelection);
  }
}

export function toPublicError(error: unknown): ControlPlaneError | undefined {
  if (isCredentialError(error)) return new ControlPlaneError(error.message, error.statusCode, error.code);
  return undefined;
}
