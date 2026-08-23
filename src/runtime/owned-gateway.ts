import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../control-plane/store.js";
import { ClaimEvidenceStore } from "../canary/artifact.js";
import { CLAUDE_CODE_CONTRACT } from "../canary/client-fixtures.js";
import { EffectiveCompatibilityRegistry } from "../compatibility/registry.js";
import { ReviewDecisionStore, QuarantineStore } from "../compatibility/stores.js";
import { runtimeCompatibilityPolicy } from "../compatibility/policy.js";
import { CredentialBroker } from "../credentials/broker.js";
import { CredentialService } from "../credentials/service.js";
import { createManagementServer, listenManagement } from "../management/server.js";
import { LaunchSessionRegistry } from "../profiles/sessions.js";
import { RouteTraceRing } from "../profiles/traces.js";
import { createCodexOauthRouteResolver } from "../providers/oauth/codex/route.js";
import { managementOrigin } from "../management/origin.js";
import { SessionStore } from "../management/session-store.js";
import { AffinityStore } from "../routing/pools/affinity.js";
import { RouteSelector } from "../routing/pools/selector.js";
import { defaultControlPlaneDirectory, resolveDefaultControlPlaneDirectory } from "../storage/paths.js";
import { applyRetentionPolicy } from "../storage/retention.js";
import { createGatewayServer, listenGateway } from "./gateway-server.js";
import { HEARTBEAT_MS, RUNTIME_VERSION } from "./gateway-attestation.js";
import { buildIdentityDigest, currentBuildIdentity } from "./build-identity.js";
import { UpdateStateStore } from "./update/store.js";
import type { AcquireGatewayOptions, GatewayLeaseHandle } from "./gateway-lifecycle.js";
import { LeaseManager } from "./lease-manager.js";
import type { ProcessIdentity } from "./ownership-record.js";
import type { RuntimeStore } from "./runtime-store.js";
import { SCHEMA_V4_VERSION } from "../storage/schema-v4.js";

const LEASE_TTL_MS = 15_000;
const IDLE_GRACE_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export type GatewayCloseTarget = Readonly<{
  close: () => Promise<unknown>;
  server: Readonly<{ closeAllConnections?: () => void }>;
}>;

/** Bounds server drain and force-closes only connections owned by this server. */
export async function closeGatewayBounded(
  target: GatewayCloseTarget,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<{ forced: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const forced = await Promise.race([
    target.close().then(() => false, () => true),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (forced) target.server.closeAllConnections?.();
  return { forced };
}

export async function startOwnedGateway(input: Readonly<{
  options: AcquireGatewayOptions;
  processIdentity: ProcessIdentity;
  store: RuntimeStore;
  baseUrl: string;
  managementBaseUrl: string;
  configFingerprint: string;
  leaseId: string;
}>): Promise<GatewayLeaseHandle> {
  const { options, processIdentity, store, baseUrl, managementBaseUrl, configFingerprint, leaseId } = input;
  const resident = options.resident === true;
  // #94: the serving build identity (semantic version, commit, build ID,
  // channel, protocol/state versions, serving artifact digest) is computed
  // once and shared by `/identity`, the ownership record fingerprint, and
  // the resident handle so all surfaces agree on the exact same identity.
  const buildIdentity = options.buildIdentity ?? await currentBuildIdentity(options.environment ?? process.env);
  const secretValue = randomBytes(32).toString("base64url");
  const managementSecretValue = randomBytes(32).toString("base64url");
  const instanceId = randomUUID();
  const sessions = new SessionStore();
  const traces = new RouteTraceRing();
  const appHolder: { app?: FastifyInstance; management?: FastifyInstance; controlPlane?: ControlPlaneStore; broker?: CredentialBroker } = {};
  const sessionHolder: { registry?: LaunchSessionRegistry } = {};
  /**
   * Revokes launch sessions and shuts the owned runtime down boundedly.
   * Resident mode calls this without a stillIdle guard on explicit stop; the
   * idle path re-checks stillIdle around the lock exactly as before.
   */
  const performShutdown = async (input: { stillIdle?: () => boolean }): Promise<void> => {
    if (input.stillIdle !== undefined && !input.stillIdle()) return;
    const cleanupLock = await store.acquireStartupLock(processIdentity, () => false);
    try {
      if (input.stillIdle !== undefined && !input.stillIdle()) return;
      sessions.revokeAll();
      await (appHolder.management ? closeGatewayBounded(appHolder.management) : Promise.resolve({ forced: false }));
      await (appHolder.app ? closeGatewayBounded(appHolder.app) : Promise.resolve({ forced: false }));
      await appHolder.broker?.close();
      appHolder.controlPlane?.close();
      await store.removeInstanceArtifacts(instanceId);
      leases.dispose();
    } finally {
      await cleanupLock.release();
    }
  };
  let stoppedResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { stoppedResolve = resolve; });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= performShutdown({}).finally(() => { stoppedResolve(); });
    return shutdownPromise;
  };
  const leases = new LeaseManager({
    ttlMs: LEASE_TTL_MS,
    idleGraceMs: IDLE_GRACE_MS,
    onExpire: (expiredLeaseId) => sessionHolder.registry?.dropLease(expiredLeaseId),
    onIdle: (stillIdle) => performShutdown({ stillIdle }),
  });
  const launchSessions = new LaunchSessionRegistry((id) => leases.has(id));
  sessionHolder.registry = launchSessions;
  await leases.add(leaseId);
  let leaseMutation: Promise<void> = Promise.resolve();
  const serializeLeaseMutation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = leaseMutation.then(work, work);
    leaseMutation = result.then(() => undefined, () => undefined);
    return result;
  };
  const registry = {
    add: (id: string): Promise<void> => serializeLeaseMutation(async () => {
      await leases.add(id);
      try {
        await store.addLease(id, processIdentity, () => false);
      } catch (error) {
        await leases.release(id);
        throw error;
      }
    }),
    renew: (id: string): Promise<void> => leases.renew(id),
    release: (id: string): Promise<void> => serializeLeaseMutation(async () => {
      launchSessions.dropLease(id);
      await store.removeLease(id, processIdentity, () => false);
      await leases.release(id);
    }),
    has: (id: string): boolean => leases.has(id),
  };
  let controlPlane: ControlPlaneStore | undefined;
  let defaultRoot: Awaited<ReturnType<typeof resolveDefaultControlPlaneDirectory>> | undefined;
  let broker: CredentialBroker | undefined;
  let app: FastifyInstance | undefined;
  let management: FastifyInstance | undefined;
  try {
    const configuredControlPlaneDirectory = options.controlPlaneDirectory ?? options.config.controlPlane.dataDirectory;
    defaultRoot = configuredControlPlaneDirectory === undefined
      ? await resolveDefaultControlPlaneDirectory()
      : undefined;
    const controlPlaneDirectory = configuredControlPlaneDirectory ?? defaultRoot?.directory ?? defaultControlPlaneDirectory();
    controlPlane = await ControlPlaneStore.open(controlPlaneDirectory);
    await defaultRoot?.commit();
    await applyRetentionPolicy(controlPlaneDirectory);
    broker = await CredentialBroker.open(controlPlaneDirectory);
    const credentials = new CredentialService(controlPlane, broker);
    const selector = new RouteSelector(controlPlane, new AffinityStore(controlPlaneDirectory));
    appHolder.controlPlane = controlPlane;
    appHolder.broker = broker;
    const { host, port, managementPort } = options.config.gateway;
    // #73: the serving runtime reports durable update state through the
    // attested handshake so an updated CLI can apply the launch policy. A
    // malformed update-state file fails the metadata read closed (omitted),
    // never the whole identity.
    const updateStore = new UpdateStateStore(controlPlaneDirectory);
    // #124: the Effective Compatibility Registry is the SOLE runtime
    // compatibility authority. Built from the control-plane stores + the
    // pinned client contract + the material RLY build; legacy static registry
    // states remain seed/reference data only.
    const compatibility = new EffectiveCompatibilityRegistry({
      claims: new ClaimEvidenceStore(controlPlaneDirectory),
      reviews: new ReviewDecisionStore(controlPlaneDirectory),
      quarantines: new QuarantineStore(controlPlaneDirectory),
      policy: runtimeCompatibilityPolicy({
        supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
        pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        rlyBuildVersion: RUNTIME_VERSION,
      }),
    });
    const gatewayOptions = {
      host,
      port,
      authToken: secretValue,
      instanceId,
      configFingerprint,
      config: options.config,
      leases: registry,
      resolveOauthRoute: createCodexOauthRouteResolver(credentials, broker, configFingerprint),
      controlPlane,
      broker,
      selector,
      launchSessions,
      traces,
      shutdown,
      stateVersion: SCHEMA_V4_VERSION,
      buildIdentity,
      updateState: () => updateStore.read().catch(() => undefined),
      compatibility,
      ...(resident ? { resident: true } : {}),
    };
    const managementOptions = {
      host,
      port: managementPort,
      origin: managementOrigin(host, managementPort),
      managementToken: managementSecretValue,
      instanceId,
      configFingerprint,
      store: controlPlane,
      sessions,
      credentials,
      traces,
    };
    app = (options.createServer ?? createGatewayServer)(gatewayOptions);
    management = (options.createManagementServer ?? createManagementServer)(managementOptions);
    appHolder.app = app;
    appHolder.management = management;
    await listenGateway(app, gatewayOptions);
    await listenManagement(management, managementOptions);
    await store.writeInstanceSecret(secretValue);
    await store.writeManagementSecret(managementSecretValue);
    await store.writeOwnershipRecord({
      ...processIdentity,
      instanceId,
      port: options.config.gateway.port,
      // #94: build-aware executable fingerprint — the digest of the exact
      // serving build identity (incl. artifact digest), so attestation
      // distinguishes same-semantic-version-different-artifact.
      executableFingerprint: buildIdentityDigest(buildIdentity),
      configFingerprint,
      nonceHash: createHash("sha256").update(secretValue).digest("hex"),
      ownerLauncherPid: processIdentity.pid,
      leases: [leaseId],
    });
  } catch (error) {
    await defaultRoot?.rollback();
    leases.dispose();
    await broker?.close();
    controlPlane?.close();
    if (management) await closeGatewayBounded(management).catch(() => undefined);
    if (app) await closeGatewayBounded(app).catch(() => undefined);
    throw error;
  }
  const heartbeat = setInterval(() => {
    void leases.renew(leaseId).catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  return {
    baseUrl,
    authToken: secretValue,
    managementBaseUrl,
    managementToken: managementSecretValue,
    instanceId,
    leaseId,
    reused: false,
    ...(resident
      ? {
          resident: true,
          runtimeVersion: buildIdentity.semanticVersion,
          shutdown,
          stopped,
        }
      : {}),
    release: async () => {
      clearInterval(heartbeat);
      await registry.release(leaseId);
    },
  };
}
