import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import type { GatewayConfig } from "../config/schema.js";
import { loadConfig } from "../config/load-config.js";
import { managementOrigin } from "../management/origin.js";
import { createIdentityProof } from "../runtime/gateway-server.js";
import { RUNTIME_VERSION } from "../runtime/gateway-attestation.js";
import { inspectRuntimeGateway, runtimeDirectory } from "../runtime/gateway-lifecycle.js";
import { RuntimeStore } from "../runtime/runtime-store.js";
import { readClaudeOverlayStatus, readClaudeViewStatuses } from "../runtime/claude-overlay.js";
import {
  bootstrapScriptPath,
  bootstrapServiceDefinition,
  readDeploymentMetadata,
  resolveActiveDeployment,
} from "../runtime/bootstrap.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import { currentBuildIdentity } from "../runtime/build-identity.js";
import { runtimeProtocolCompatible } from "../runtime/update/policy.js";
import { UpdateStateStore } from "../runtime/update/store.js";
import { createServiceManager } from "../service-manager/index.js";
import { detectDefinition, reconcileDefinition } from "../service-manager/reconcile.js";
import { serviceDetail } from "../service-manager/types.js";
import { readInstallation } from "../storage/installation.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";
import { detectClaudeTarget, detectCodexTarget } from "../targets/detect.js";
import { probeClientVersion } from "../targets/versions.js";
import { RLY_LIVE_CANARY_ENV } from "../canary/run.js";
import { CLAUDE_CODE_CONTRACT, CLAUDE_CODE_FIXTURE_BASELINE } from "../canary/client-fixtures.js";
import { EVIDENCE_SCHEMA_VERSION, LEGACY_V1_POLICY } from "../canary/claim.js";
import { ClaimEvidenceStore } from "../canary/artifact.js";
import { EffectiveCompatibilityRegistry } from "../compatibility/registry.js";
import { ReviewDecisionStore, QuarantineStore } from "../compatibility/stores.js";
import { runtimeCompatibilityPolicy } from "../compatibility/policy.js";
import { INSTALLED_CLIENT_RUNNER_VERSION, LIVE_ACCESS_PATH_RUNNER_VERSION } from "../canary/runner-types.js";
import { describeModelDecision } from "../routing/model-decision/describe.js";
import { PRECEDENCE_ORDER, MODEL_DECISION_SCHEMA_VERSION } from "../routing/model-decision/types.js";

const EMPTY_PROFILES = { total: 0, missingPool: 0 };

function isPlaceholderModel(model: string): boolean {
  return model.startsWith("replace-with-");
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function requireConfig(path: string, missing: unknown): Promise<GatewayConfig | undefined> {
  if (!(await canRead(path))) {
    console.log(JSON.stringify(missing));
    return undefined;
  }
  return loadConfig(path);
}

async function existingRuntimeStore(config: GatewayConfig): Promise<RuntimeStore | undefined> {
  const directory = runtimeDirectory(config.gateway.port);
  if (!(await canRead(directory))) return undefined;
  return new RuntimeStore(directory);
}

async function requireToken(
  config: GatewayConfig,
  read: (store: RuntimeStore) => Promise<string | undefined>,
  missing: unknown,
): Promise<string | undefined> {
  const store = await existingRuntimeStore(config);
  if (!store) {
    console.log(JSON.stringify(missing));
    return undefined;
  }
  const token = await read(store);
  if (token) return token;
  console.log(JSON.stringify(missing));
  return undefined;
}

async function readJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; payload: unknown }> {
  const response = await fetch(url, { headers });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid-response" }));
  return { ok: response.ok, payload };
}

async function profileInventory(config: GatewayConfig): Promise<{ total: number; missingPool: number }> {
  const extras = await secretFreeInventory(config);
  const profiles = extras["profiles"];
  if (typeof profiles === "number") return { total: profiles, missingPool: 0 };
  return EMPTY_PROFILES;
}

/**
 * Allowlisted update metadata (#73/#93): durable update state plus the
 * serving runtime's attested identity (state/schema version, active launch
 * sessions, draining, live update snapshot) and CLI↔runtime compatibility.
 * Includes the durable activation-transaction phase and lock-owner status.
 * Versions, counts, and identifiers only — never credentials, prompts,
 * responses, or account identity.
 */
async function updateSummary(config: GatewayConfig): Promise<Record<string, unknown>> {
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const store = new UpdateStateStore(controlPlaneDirectory);
  let record;
  try {
    record = await store.read();
  } catch {
    record = undefined;
  }
  const identity = await attestedIdentityOrUndefined(config);
  const residentVersion = identity?.runtimeVersion;
  const residentBuild = identity?.build;
  const cliBuild = await currentBuildIdentity();
  const transactionPhase = identity?.update?.phase ?? record?.transaction?.phase;
  const lock = await store.lockStatus().catch(() => undefined);
  return {
    state: identity?.update?.state ?? record?.state ?? "idle",
    ...(identity?.update?.pendingVersion === undefined
      ? record?.pendingVersion === undefined ? {} : { pendingVersion: record.pendingVersion }
      : { pendingVersion: identity.update.pendingVersion }),
    ...(identity?.update?.previousVersion === undefined
      ? record?.previousVersion === undefined ? {} : { previousVersion: record.previousVersion }
      : { previousVersion: identity.update.previousVersion }),
    ...(transactionPhase === undefined ? {} : { phase: transactionPhase }),
    ...(identity === undefined ? {} : {
      stateVersion: identity.stateVersion,
      activeSessions: identity.activeSessions ?? 0,
      draining: identity.draining ?? false,
    }),
    compatibility: {
      cli: RUNTIME_VERSION,
      ...(residentVersion === undefined ? {} : { resident: residentVersion }),
      compatible: runtimeProtocolCompatible(RUNTIME_VERSION, residentVersion ?? RUNTIME_VERSION),
    },
    // #94: exact build identity — CLI and serving runtime share the same
    // versioned fields (/identity, diagnostics, manifest, probation compare
    // these). Secret-free build metadata only.
    buildIdentity: {
      cli: {
        semanticVersion: cliBuild.semanticVersion,
        commitRevision: cliBuild.commitRevision,
        buildId: cliBuild.buildId,
        releaseChannel: cliBuild.releaseChannel,
        controlProtocolVersion: cliBuild.controlProtocolVersion,
        dataProtocolVersion: cliBuild.dataProtocolVersion,
        stateSchemaVersion: cliBuild.stateSchemaVersion,
      },
      ...(residentBuild === undefined ? {} : { serving: residentBuild }),
    },
    ...(lock === undefined ? {} : { lock: lock.held ? { held: true, ...(lock.ownerPid === undefined ? {} : { ownerPid: lock.ownerPid }), ...(lock.stale === undefined ? {} : { stale: lock.stale }) } : { held: false } }),
    ...(record?.lastActivationResult === undefined ? {} : { lastActivationResult: record.lastActivationResult }),
    ...(record?.lastRollbackResult === undefined ? {} : { lastRollbackResult: record.lastRollbackResult }),
    ...(record?.failureReason === undefined ? {} : { failureReason: record.failureReason }),
    ...(record?.state === "recovery-required" ? { recovery: "manual" } : {}),
  };
}

/** Reads the attested runtime identity for secret-free version/session metadata. */
async function attestedIdentityOrUndefined(config: GatewayConfig): Promise<{
  runtimeVersion?: string;
  stateVersion?: number;
  activeSessions?: number;
  draining?: boolean;
  build?: BuildIdentity;
  update?: { state: string; pendingVersion?: string; previousVersion?: string; phase?: string };
} | undefined> {
  const store = new RuntimeStore(runtimeDirectory(config.gateway.port));
  const secret = await store.readInstanceSecret();
  if (secret === undefined) return undefined;
  const challenge = cryptoRandomChallenge();
  try {
    const response = await fetch(`http://${config.gateway.host}:${String(config.gateway.port)}/identity?challenge=${challenge}`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as {
      instanceId?: string;
      configFingerprint?: string;
      runtimeVersion?: string;
      stateVersion?: number;
      activeSessions?: number;
      draining?: boolean;
      build?: BuildIdentity;
      update?: { state: string; pendingVersion?: string; previousVersion?: string; phase?: string };
      proof?: string;
    };
    if (payload.proof === undefined || payload.instanceId === undefined || payload.configFingerprint === undefined) return undefined;
    const expected = createIdentityProof(secret, challenge, payload.instanceId, payload.configFingerprint);
    if (payload.proof !== expected) return undefined;
    return {
      ...(payload.runtimeVersion === undefined ? {} : { runtimeVersion: payload.runtimeVersion }),
      ...(payload.stateVersion === undefined ? {} : { stateVersion: payload.stateVersion }),
      ...(payload.activeSessions === undefined ? {} : { activeSessions: payload.activeSessions }),
      ...(payload.draining === undefined ? {} : { draining: payload.draining }),
      ...(payload.build === undefined ? {} : { build: payload.build }),
      ...(payload.update === undefined ? {} : { update: payload.update }),
    };
  } catch {
    return undefined;
  }
}

/**
 * #94 bootstrap/build-identity diagnostics: stable bootstrap path + install
 * state, the committed active deployment identity (#92), the EXPECTED build
 * identity (from the active deployment metadata) vs the SERVING build
 * identity (attested `/identity`), and their match status — including the
 * same-semantic-version-different-artifact signal. Secret-free identifiers
 * and paths only.
 */
async function bootstrapDiagnostics(
  config: GatewayConfig,
  controlPlaneDirectory: string,
): Promise<Record<string, unknown>> {
  const bootstrapPath = bootstrapScriptPath(controlPlaneDirectory);
  const installed = await canRead(bootstrapPath);
  const active = await resolveActiveDeployment(controlPlaneDirectory).catch(() => undefined);
  let expected: Readonly<{
    semanticVersion: string;
    artifactId: string;
    buildId?: string;
    commitRevision?: string;
    releaseChannel?: string;
  }> | undefined;
  if (active !== undefined) {
    const metadata = await readDeploymentMetadata(active.deploymentDirectory).catch(() => undefined);
    expected = {
      semanticVersion: active.version,
      artifactId: active.artifactId,
      ...(metadata?.buildId === undefined ? {} : { buildId: metadata.buildId }),
      ...(metadata?.commitRevision === undefined ? {} : { commitRevision: metadata.commitRevision }),
      ...(metadata?.releaseChannel === undefined ? {} : { releaseChannel: metadata.releaseChannel }),
    };
  }
  const serving = (await attestedIdentityOrUndefined(config))?.build;
  const match = expected !== undefined && serving !== undefined
    ? serving.artifactId === expected.artifactId && serving.semanticVersion === expected.semanticVersion
    : undefined;
  const differentArtifact = expected !== undefined && serving !== undefined
    && expected.semanticVersion === serving.semanticVersion
    && expected.artifactId !== serving.artifactId;
  return {
    path: bootstrapPath,
    installed,
    active: active === undefined
      ? { status: "no-committed-deployment" }
      : { artifactId: active.artifactId, version: active.version },
    ...(expected === undefined ? {} : { expected }),
    ...(serving === undefined ? {} : { serving }),
    ...(match === undefined ? {} : { match }),
    ...(differentArtifact ? { differentArtifact: true } : {}),
  };
}

function cryptoRandomChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export async function runDoctor(path: string, dependencies: { createServiceManager?: typeof createServiceManager } = {}): Promise<number> {
  if (!(await canRead(path))) {
    console.log(JSON.stringify({ ok: false, config: "missing", path }));
    return 1;
  }
  try {
    const config = await loadConfig(path);
    const placeholderRoutes = Object.entries(config.routes)
      .filter(([, route]) => route !== undefined && isPlaceholderModel(route.model))
      .map(([role]) => role);
    const target = detectClaudeTarget(process.env);
    const codex = detectCodexTarget(process.env);
    // Exact installed client versions (#24): binary presence is `found`, never
    // `compatible`; an unknown/newly installed version reports `unknown` and is
    // never silently treated as the tested baseline.
    const claudeProbe = target.found ? await probeClientVersion(target.executable) : undefined;
    const codexProbe = codex.found ? await probeClientVersion(codex.executable) : undefined;
    const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
    const claudeViews = await readClaudeViewStatuses(controlPlaneDirectory);
    // #94: stable bootstrap + exact build identity diagnostics; doctor may
    // also detect and idempotently repair a stale/missing service definition
    // (never provider/account configuration).
    const bootstrap = await bootstrapDiagnostics(config, controlPlaneDirectory);
    const installation = await readInstallation(controlPlaneDirectory);
    let serviceDefinition: Record<string, unknown> | undefined;
    if (installation !== undefined && (installation.platform === "darwin" || installation.platform === "linux")) {
      const manager = (dependencies.createServiceManager ?? createServiceManager)({ home: homedir() });
      const expected = bootstrapServiceDefinition(controlPlaneDirectory, installation.configPath);
      const reconciled = await reconcileDefinition(manager, expected).catch(() => undefined);
      if (reconciled !== undefined) {
        serviceDefinition = {
          status: reconciled.status,
          ...(reconciled.revision === undefined ? {} : { revision: reconciled.revision }),
          ...(reconciled.migrated === undefined ? {} : { migrated: reconciled.migrated }),
        };
      }
    }
    // #124: Effective Compatibility Registry diagnostics — counts + pinned
    // policy only, never credentials/account identity/prompts/responses.
    const compatibility = new EffectiveCompatibilityRegistry({
      claims: new ClaimEvidenceStore(controlPlaneDirectory),
      reviews: new ReviewDecisionStore(controlPlaneDirectory),
      quarantines: new QuarantineStore(controlPlaneDirectory),
      policy: runtimeCompatibilityPolicy({
        supportedClientBaseline: CLAUDE_CODE_FIXTURE_BASELINE,
        pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        rlyBuildVersion: RUNTIME_VERSION,
      }),
    });
    console.log(JSON.stringify({
      ok: true,
      syntaxValid: true,
      operationalReady: placeholderRoutes.length === 0,
      schemaVersion: config.schemaVersion,
      host: config.gateway.host,
      port: config.gateway.port,
      managementPort: config.gateway.managementPort,
      routes: Object.keys(config.routes).length,
      placeholderRoutes,
      claudeTarget: {
        found: target.found,
        executable: target.executable,
        ...(claudeProbe?.version === undefined ? {} : { version: claudeProbe.version }),
        versionSource: target.found ? (claudeProbe?.source ?? "unknown") : "unknown",
      },
      codexTarget: {
        found: codex.found,
        executable: codex.executable,
        ...(codexProbe?.version === undefined ? {} : { version: codexProbe.version }),
        versionSource: codex.found ? (codexProbe?.source ?? "unknown") : "unknown",
      },
      effectiveCompatibility: await compatibility.summary(),
      // #127: the EffectiveModelDecision control plane — the FINAL model-control
      // output before account selection. Doctor reports the control-plane
      // contract statically; per-request explanations live on route traces.
      modelDecision: {
        schemaVersion: MODEL_DECISION_SCHEMA_VERSION,
        precedenceOrder: PRECEDENCE_ORDER,
        finalAuthority: "ecr",
      },
      canary: {
        testedBaseline: CLAUDE_CODE_FIXTURE_BASELINE,
        liveGateEnv: RLY_LIVE_CANARY_ENV,
        evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
        legacyPolicy: LEGACY_V1_POLICY,
        // #123: Layer B/C runner identities (observed-only evidence producers).
        runners: {
          layerB: { kind: "installed-client", version: INSTALLED_CLIENT_RUNNER_VERSION, requires: "installed claude/codex binary" },
          layerC: { kind: "live-access-path", version: LIVE_ACCESS_PATH_RUNNER_VERSION, requires: `opt-in ${RLY_LIVE_CANARY_ENV}=1 and an env credential` },
        },
      },
      update: await updateSummary(config),
      bootstrap,
      ...(serviceDefinition === undefined ? {} : { serviceDefinition }),
      profiles: await profileInventory(config),
      claudeViews,
    }));
    return 0;
  } catch {
    console.log(JSON.stringify({
      ok: false,
      config: "invalid",
      error: "Configuration validation failed; inspect the file locally",
    }));
    return 1;
  }
}

export async function runStatus(path: string, dependencies: { createServiceManager?: typeof createServiceManager } = {}): Promise<number> {
  const config = await requireConfig(path, { configured: false, running: false });
  if (!config) return 1;
  const state = await inspectRuntimeGateway(config);
  const running = state.state === "attested-compatible";
  const extras = running ? await secretFreeInventory(config) : {};
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const installation = await readInstallation(controlPlaneDirectory);
  const claudeOverlay = await readClaudeOverlayStatus(controlPlaneDirectory);
  const claudeViews = await readClaudeViewStatuses(controlPlaneDirectory);
  // #94: bootstrap/build-identity + service-definition reconciliation state
  // (detect only — status never mutates; doctor/init repair).
  const bootstrap = await bootstrapDiagnostics(config, controlPlaneDirectory);
  let definition: Record<string, unknown> | undefined;
  if (installation !== undefined && (installation.platform === "darwin" || installation.platform === "linux")) {
    const manager = (dependencies.createServiceManager ?? createServiceManager)({ home: homedir() });
    const expected = bootstrapServiceDefinition(controlPlaneDirectory, installation.configPath);
    const detected = await detectDefinition(manager, expected).catch(() => undefined);
    if (detected !== undefined) {
      definition = {
        status: detected.status,
        ...(detected.revision === undefined ? {} : { revision: detected.revision }),
        ...(detected.migrated === undefined ? {} : { migrated: detected.migrated }),
      };
    }
  }
  // Report service registration/load state separately from runtime readiness
  // on platforms with a per-user service manager (macOS LaunchAgent, Linux
  // systemd --user) and only when an installation record exists (never runs
  // launchctl/systemctl against a fresh home).
  const detail = installation !== undefined && (installation.platform === "darwin" || installation.platform === "linux")
    ? await serviceDetail((dependencies.createServiceManager ?? createServiceManager)({ home: homedir() }))
    : undefined;
  console.log(JSON.stringify({
    configured: true,
    running,
    state: state.state,
    ...(state.state === "attested-compatible"
      ? { runtimeVersion: state.runtimeVersion, resident: state.resident, instanceId: state.instanceId }
      : {}),
    service: installation === undefined
      ? { registered: false }
      : {
          registered: true,
          platform: installation.platform,
          serviceName: installation.serviceName,
          ...(detail === undefined
            ? {}
            : {
                label: detail.label,
                loadState: detail.loaded
                  ? detail.running
                    ? "running"
                    : detail.activeState === "failed" ? "failed" : "stopped"
                  : "not-loaded",
                ...(detail.pid === undefined ? {} : { pid: detail.pid }),
                ...(detail.enabled === undefined ? {} : { enabled: detail.enabled }),
              }),
        },
    bootstrap,
    ...(definition === undefined ? {} : { serviceDefinition: definition }),
    host: config.gateway.host,
    port: config.gateway.port,
    managementPort: config.gateway.managementPort,
    ...(claudeOverlay === undefined ? {} : { claudeOverlay }),
    claudeViews,
    update: await updateSummary(config),
    ...extras,
  }));
  return running ? 0 : 1;
}

export async function runQuota(path: string): Promise<number> {
  return managementGet(path, "/v1/accounts", (body) => {
    const items = asItems(body).map((item) => ({
      pseudonym: item["pseudonym"],
      quotaClass: item["quotaClass"],
    }));
    console.log(JSON.stringify({ accounts: items }));
  });
}

export async function runRouteTrace(path: string): Promise<number> {
  const config = await requireConfig(path, { ok: false, error: "config missing" });
  if (!config) return 1;
  const token = await requireToken(config, (store) => store.readInstanceSecret(), { ok: false, error: "gateway is not running" });
  if (!token) return 1;
  const { ok, payload } = await readJson(`http://${config.gateway.host}:${String(config.gateway.port)}/v1/route-traces`, {
    authorization: `Bearer ${token}`,
  });
  console.log(JSON.stringify({ traces: projectRouteTraces(payload) }));
  return ok ? 0 : 1;
}

async function secretFreeInventory(config: GatewayConfig): Promise<Record<string, unknown>> {
  try {
    const store = await existingRuntimeStore(config);
    const token = store === undefined ? undefined : await store.readManagementSecret();
    if (!token) return {};
    const origin = managementOrigin(config.gateway.host, config.gateway.managementPort);
    const { ok, payload } = await readJson(`${origin}/v1/policy`, {
      authorization: `Bearer ${token}`,
      origin,
    });
    if (!ok) return {};
    const policy = payload as {
      revision?: number;
      profiles?: unknown[];
      pools?: unknown[];
      accounts?: { state?: string }[];
    };
    const accounts = policy.accounts ?? [];
    return {
      policyRevision: policy.revision ?? 0,
      profiles: policy.profiles?.length ?? 0,
      pools: policy.pools?.length ?? 0,
      accounts: {
        total: accounts.length,
        ready: accounts.filter((item) => item.state === "ready").length,
        paused: accounts.filter((item) => item.state === "paused").length,
      },
    };
  } catch {
    return {};
  }
}

async function managementGet(
  path: string,
  route: string,
  write: (body: unknown) => void,
): Promise<number> {
  const config = await requireConfig(path, { ok: false, error: "config missing" });
  if (!config) return 1;
  const token = await requireToken(config, (store) => store.readManagementSecret(), { ok: false, error: "management is not running" });
  if (!token) return 1;
  const origin = managementOrigin(config.gateway.host, config.gateway.managementPort);
  const { ok, payload } = await readJson(`${origin}${route}`, {
    authorization: `Bearer ${token}`,
    origin,
  });
  if (!ok) {
    console.log(JSON.stringify(payload));
    return 1;
  }
  write(payload);
  return 0;
}

function asItems(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

function projectRouteTraces(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const traces = (value as { traces?: unknown }).traces;
  if (!Array.isArray(traces)) return [];
  return traces.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const selected = record["selected"];
    const selectedRecord = selected !== null && typeof selected === "object" ? selected as Record<string, unknown> : undefined;
    const decision = record["effectiveModelDecision"];
    const modelSelection = record["modelSelection"];
    const selectionRecord = modelSelection !== null && typeof modelSelection === "object"
      ? modelSelection as Record<string, unknown>
      : undefined;
    return [{
      profileName: record["profileName"],
      sourceRule: record["sourceRule"],
      selectedPseudonym: selectedRecord?.["accountPseudonym"],
      ...(selectionRecord === undefined
        ? {}
        : {
            modelSelection: {
              source: selectionRecord["source"],
              selectedLogicalId: selectionRecord["selectedLogicalId"],
              reason: selectionRecord["reason"],
            },
          }),
      // #127: secret-free model-control explanation (selector, precedence,
      // target, compatibility, reasoning, pool, revisions, blocked
      // alternatives). Never prompts/credentials/account identity.
      ...(decision === null || typeof decision !== "object"
        ? {}
        : { effectiveModelDecision: describeModelDecision(decision as Parameters<typeof describeModelDecision>[0]) }),
    }];
  });
}
