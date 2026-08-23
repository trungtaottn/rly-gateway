import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { startResidentRuntime, type ResidentRuntimeHandle } from "../../src/runtime/resident-runtime.js";
import { acquireGateway, inspectRuntimeGateway } from "../../src/runtime/gateway-lifecycle.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { runUpdate } from "../../src/runtime/update/lifecycle.js";
import { UpdateStateStore } from "../../src/runtime/update/store.js";
import { UPDATE_LOCK_FILE_NAME, type CandidateInstaller, type CandidateManifest } from "../../src/runtime/update/types.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { ServiceManagerAdapter, ServiceStatus } from "../../src/service-manager/types.js";
import { SCHEMA_V4_VERSION } from "../../src/storage/schema-v4.js";
import { writePrivateTextAtomically } from "../../src/storage/private-files.js";

const directories: string[] = [];
const servers: Server[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function config(port: number, managementPort: number, controlPlaneDirectory: string): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port, managementPort, logLevel: "silent" },
    controlPlane: { dataDirectory: controlPlaneDirectory },
    routes: {},
  });
}

/** Seeds one provider/account/pool/profile so launch sessions can be issued. */
async function seedControlPlane(directory: string): Promise<void> {
  const store = await ControlPlaneStore.open(directory);
  const created = store.createProvider({
    name: "openrouter",
    integrationMode: "direct",
    endpointPolicy: "loopback",
  }, "cli");
  const first = store.createAccount({
    pseudonym: "acct-update-a",
    providerId: created.id,
    credentialHandle: "env:OPENROUTER_API_KEY",
  }, "cli");
  const ready = store.bindCredential(first.id, first.version, {
    credentialHandle: "env:OPENROUTER_API_KEY",
    credentialGeneration: 1,
    state: "ready",
  }, "cli");
  const pool = store.createPool({
    name: "update-pool",
    providerId: created.id,
    strategy: "fill-first",
    retryBudget: 1,
    accountIds: [ready.id],
  }, "cli");
  store.createProfile({
    name: "work",
    harness: "claude",
    providerId: created.id,
    poolId: pool.id,
    modelRoles: { primary: "openrouter/model-a" },
  }, "cli");
  store.close();
}

function serverFor(version: string) {
  return (options: Parameters<typeof createGatewayServer>[0]) => createGatewayServer({ ...options, runtimeVersion: version });
}

function fakeArtifactId(version: string): string {
  return createHash("sha256").update(version).digest("hex");
}

class FakeInstaller implements CandidateInstaller {
  installs: string[] = [];
  activations: string[] = [];
  restored = 0;
  verifyOk = true;
  manifest: CandidateManifest | undefined;

  installCandidate(input: { version: string; sourceDirectory: string }): Promise<{ version: string; artifactId: string; previousVersion?: string; previousArtifactId?: string }> {
    this.installs.push(input.version);
    const previousVersion = this.installs.length > 1 ? this.installs[this.installs.length - 2] : undefined;
    return Promise.resolve({
      version: input.version,
      artifactId: fakeArtifactId(input.version),
      ...(previousVersion === undefined ? {} : { previousVersion, previousArtifactId: fakeArtifactId(previousVersion) }),
    });
  }

  verifyCandidate(): Promise<{ ok: boolean; version: string; artifactId?: string; reason?: string }> {
    const version = this.installs.at(-1) ?? "0.1.0";
    return Promise.resolve({ ok: this.verifyOk, version, artifactId: fakeArtifactId(version), ...(this.verifyOk ? {} : { reason: "fake verification failure" }) });
  }

  activateStaged(): Promise<{ version: string; artifactId: string; previousVersion?: string; previousArtifactId?: string }> {
    const candidate = this.installs.at(-1) ?? "0.1.0";
    this.activations.push(candidate);
    const previousVersion = this.activations.length > 1 ? this.activations[this.activations.length - 2] : undefined;
    return Promise.resolve({
      version: candidate,
      artifactId: fakeArtifactId(candidate),
      ...(previousVersion === undefined ? {} : { previousVersion, previousArtifactId: fakeArtifactId(previousVersion) }),
    });
  }

  restorePrevious(): Promise<{ version: string; artifactId: string; previousVersion?: string; previousArtifactId?: string }> {
    this.restored += 1;
    const candidate = this.installs.at(-1);
    return Promise.resolve({
      version: "0.1.0",
      artifactId: fakeArtifactId("0.1.0"),
      ...(candidate === undefined ? {} : { previousVersion: candidate, previousArtifactId: fakeArtifactId(candidate) }),
    });
  }

  /** #93 recovery-grade restore; counts as one bounded rollback attempt. */
  setActiveReferences(input: { activeArtifactId: string; previousArtifactId?: string }): Promise<void> {
    this.restored += 1;
    this.lastActiveRef = input.activeArtifactId;
    this.lastPreviousRef = input.previousArtifactId;
    return Promise.resolve();
  }

  lastActiveRef: string | undefined;
  lastPreviousRef: string | undefined;

  readManifest(): Promise<CandidateManifest | undefined> {
    return Promise.resolve(this.manifest);
  }
}

class FakeServiceManager implements ServiceManagerAdapter {
  platform = "linux" as const;
  serviceName = "rly-gateway";
  restarts = 0;
  starts = 0;
  registers = 0;

  constructor(private readonly onRestart: () => Promise<void>) {}

  isSupported(): boolean { return true; }
  isRegistered(): Promise<boolean> { return Promise.resolve(true); }
  register(): Promise<void> { this.registers += 1; return Promise.resolve(); }
  unregister(): Promise<void> { return Promise.resolve(); }
  start(): Promise<void> { this.starts += 1; return this.onRestart(); }
  restart(): Promise<void> { this.restarts += 1; return this.onRestart(); }
  stop(): Promise<void> { return Promise.resolve(); }
  status(): Promise<ServiceStatus> { return Promise.resolve("running"); }
}

type RuntimeHarness = Readonly<{
  current: ResidentRuntimeHandle;
  restartTo: (version: string) => Promise<void>;
  versionOf: () => Promise<string>;
}>;

async function startHarness(port: number, managementPort: number, runtimeDir: string, controlPlaneDir: string, version = RUNTIME_VERSION): Promise<RuntimeHarness> {
  let current = await startResidentRuntime({
    config: config(port, managementPort, controlPlaneDir),
    runtimeDirectory: runtimeDir,
    controlPlaneDirectory: controlPlaneDir,
    heartbeatMs: 5,
    createServer: serverFor(version),
  });
  const restartTo = async (nextVersion: string): Promise<void> => {
    const old = current;
    await old.shutdown();
    await old.stopped;
    current = await startResidentRuntime({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      heartbeatMs: 5,
      createServer: serverFor(nextVersion),
    });
  };
  const versionOf = async (): Promise<string> => {
    const state = await inspectRuntimeGateway(config(port, managementPort, controlPlaneDir), runtimeDir);
    return state.state === "attested-compatible" ? state.runtimeVersion ?? RUNTIME_VERSION : "down";
  };
  return { current, restartTo, versionOf };
}

/** Issues one launch session through the attested runtime (profile `work`). */
async function issueLaunchSession(port: number, managementPort: number, controlPlaneDir: string, runtimeDir: string): Promise<{ token: string; release: () => Promise<void> }> {
  const launcher = await acquireGateway({
    config: config(port, managementPort, controlPlaneDir),
    runtimeDirectory: runtimeDir,
    controlPlaneDirectory: controlPlaneDir,
    heartbeatMs: 5,
  });
  const response = await fetch(`${launcher.baseUrl}/v1/launch-sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${launcher.authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ profileName: "work", leaseId: launcher.leaseId }),
  });
  expect(response.ok).toBe(true);
  const payload = await response.json() as { token?: string };
  if (typeof payload.token !== "string") throw new Error("launch session did not issue a token");
  return { token: payload.token, release: () => launcher.release() };
}

async function sessionRoundTrip(port: number, token: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/route-traces`, {
    headers: { "x-api-key": token },
    signal: AbortSignal.timeout(2_000),
  });
  return response.status;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("safe zero-downtime runtime update lifecycle (#73)", () => {
  it("activates a verified candidate through a controlled service restart at zero sessions", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    expect(await harness.versionOf()).toBe(RUNTIME_VERSION);

    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    const versionToStart = "2.0.0";
    const manager = new FakeServiceManager(async () => { await harness.restartTo(versionToStart); });
    const store = new UpdateStateStore(controlPlaneDir);

    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: {
        serviceName: "rly-gateway",
        executable: "/usr/local/bin/node",
        entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"),
        configPath: "/work/gateway.config.toml",
      },
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });

    expect(result.outcome).toBe("activated");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe("2.0.0");
    expect(manager.restarts).toBe(1);
    expect(installer.installs).toEqual(["2.0.0"]);
    expect(await harness.versionOf()).toBe("2.0.0");
    const record = await store.read();
    expect(record?.state).toBe("active");
    expect(record?.pendingVersion).toBeUndefined();
    expect(record?.lastActivationResult?.ok).toBe(true);
    await harness.current.shutdown();
  });

  it("keeps one active session on the old runtime, waits for drain, and never kills it", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);

    const session = await issueLaunchSession(port, managementPort, controlPlaneDir, runtimeDir);

    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    const versionToStart = "2.0.0";
    const manager = new FakeServiceManager(async () => { await harness.restartTo(versionToStart); });
    const store = new UpdateStateStore(controlPlaneDir);

    // Installation completes; activation waits for the active session to drain.
    const pending = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: {
        serviceName: "rly-gateway",
        executable: "/usr/local/bin/node",
        entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"),
        configPath: "/work/gateway.config.toml",
      },
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      drainTimeoutMs: 300,
      drainPollMs: 50,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(pending.outcome).toBe("pending");
    expect(pending.state).toBe("pending-activation");
    expect(manager.restarts).toBe(0);

    // The active session keeps working on the old runtime (authorized
    // round-trip through the session token — not proven by an idle token).
    expect(await sessionRoundTrip(port, session.token)).toBe(200);
    expect(await harness.versionOf()).toBe(RUNTIME_VERSION);

    // Session ends naturally → re-running the update activates.
    await session.release();
    const activated = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      serviceDefinition: {
        serviceName: "rly-gateway",
        executable: "/usr/local/bin/node",
        entrypoint: join(controlPlaneDir, "runtime", "refs", "active", "dist", "cli", "main.js"),
        configPath: "/work/gateway.config.toml",
      },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(activated.outcome).toBe("activated");
    expect(activated.state).toBe("active");
    expect(await harness.versionOf()).toBe("2.0.0");
    // The old session token is never moved/replayed onto the new runtime.
    expect(await sessionRoundTrip(port, session.token)).toBe(401);
    await harness.current.shutdown();
  });

  it("waits for multiple concurrent sessions to reach the safe zero count", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const [first, second] = await Promise.all([
      issueLaunchSession(port, managementPort, controlPlaneDir, runtimeDir),
      issueLaunchSession(port, managementPort, controlPlaneDir, runtimeDir),
    ]);
    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    const pending = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      drainTimeoutMs: 200,
      drainPollMs: 50,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(pending.outcome).toBe("pending");
    expect(manager.restarts).toBe(0);
    // One session ends; the other keeps the update pending.
    await first.release();
    const stillPending = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      drainTimeoutMs: 200,
      drainPollMs: 50,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(stillPending.outcome).toBe("pending");
    await second.release();
    const activated = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(activated.outcome).toBe("activated");
    expect(await harness.versionOf()).toBe("2.0.0");
    await harness.current.shutdown();
  });

  it("lets a compatible pair keep launching on the old runtime while activation is pending", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const session = await issueLaunchSession(port, managementPort, controlPlaneDir, runtimeDir);

    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "0.2.0", stateVersion: 4, migrationForwardOnly: false };
    const store = new UpdateStateStore(controlPlaneDir);
    // Compatible candidate (same major as the serving 0.1.0) is pending.
    await store.write({
      schemaVersion: 1,
      state: "pending-activation",
      currentVersion: "0.1.0",
      pendingVersion: "0.2.0",
      previousVersion: "0.1.0",
      updatedAt: new Date().toISOString(),
    });

    // A new launch is still issued on the compatible old runtime.
    const launcher = await acquireGateway({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      heartbeatMs: 5,
    });
    const response = await fetch(`${launcher.baseUrl}/v1/launch-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${launcher.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ profileName: "work", leaseId: launcher.leaseId }),
    });
    expect(response.status).toBe(201);
    // The existing session and the old runtime keep serving.
    expect(await sessionRoundTrip(port, session.token)).toBe(200);
    expect(await harness.versionOf()).toBe(RUNTIME_VERSION);
    await launcher.release();
    await session.release();
    await harness.current.shutdown();
  });

  it("once drain begins the old runtime refuses new launch-session issuance", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const launcher = await acquireGateway({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      heartbeatMs: 5,
    });

    // Authenticated drain request on the attested resident runtime.
    const drain = await fetch(`${launcher.baseUrl}/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${launcher.authToken}` },
    });
    expect(drain.status).toBe(202);
    const unauthorized = await fetch(`${launcher.baseUrl}/drain`, { method: "POST", headers: { authorization: "Bearer wrong-token" } });
    expect(unauthorized.status).toBe(401);

    const refused = await fetch(`${launcher.baseUrl}/v1/launch-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${launcher.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ profileName: "work", leaseId: launcher.leaseId }),
    });
    expect(refused.status).toBe(409);
    const payload = await refused.json() as { error?: string };
    expect(payload.error).toBe("update-pending");
    await launcher.release();
    await harness.current.shutdown();
  });

  it("rolls back to the previous known-good version when the candidate fails health verification", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);

    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    // The candidate restarts but keeps reporting the OLD version (broken).
    const versionToStart = RUNTIME_VERSION;
    const manager = new FakeServiceManager(async () => { await harness.restartTo(versionToStart); });
    const store = new UpdateStateStore(controlPlaneDir);

    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });

    // One bounded rollback: activation restart + rollback restart.
    expect(result.outcome).toBe("rolled-back");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe(RUNTIME_VERSION);
    expect(manager.restarts).toBe(2);
    expect(installer.restored).toBe(1);
    expect(await harness.versionOf()).toBe(RUNTIME_VERSION);
    const record = await store.read();
    expect(record?.lastActivationResult?.ok).toBe(false);
    expect(record?.lastRollbackResult?.ok).toBe(true);
    await harness.current.shutdown();
  });

  it("fails closed on a foreign port after restart and never signals the listener", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);

    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    // The service-manager restart lands on a port now owned by a foreign
    // process; RLY must fail closed and never signal the listener.
    const manager = new FakeServiceManager(async () => {
      await harness.current.shutdown();
      await harness.current.stopped;
      const foreign = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ product: "foreign" }));
      });
      servers.push(foreign);
      await new Promise<void>((resolve, reject) => {
        foreign.once("error", reject);
        foreign.listen(port, "127.0.0.1", resolve);
      });
    });
    const store = new UpdateStateStore(controlPlaneDir);
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(result.outcome).toBe("failed");
    // #93: rollback failure terminates in the explicit recovery-required state.
    expect(result.state).toBe("recovery-required");
    // Deterministic doctor action, no loop.
    expect(result.message).toContain("doctor");
    expect(result.message).toContain("both failed");
    expect(manager.restarts).toBeLessThanOrEqual(2);
    // The foreign listener is never killed or signaled (the first bind
    // survives; a later restart attempt merely fails to rebind it).
    expect(servers.some((server) => server.listening)).toBe(true);
    const record = await store.read();
    expect(record?.failureReason).toContain("foreign");
    expect(record?.failureReason).toContain("both failed");
  });

  it("blocks a forward-only migration before any destructive activation", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "3.0.0", stateVersion: 3, migrationForwardOnly: true };
    const manager = new FakeServiceManager(async () => { await harness.restartTo("3.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "3.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("forward-only");
    expect(manager.restarts).toBe(0);
    // Staging never switched the `active` reference (#92), so a blocked
    // forward-only candidate has no install-time reference to restore.
    expect(installer.restored).toBe(0);
    // The previous version keeps serving.
    expect(await harness.versionOf()).toBe(RUNTIME_VERSION);
    await harness.current.shutdown();
  });

  it("serializes concurrent updates so two invocations cannot double-restart", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new FakeInstaller();
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir);
    const deps = {
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    };
    const [first, second] = await Promise.allSettled([runUpdate(deps), runUpdate(deps)]);
    const results = [first, second];
    const completed = results.find((result) => result.status === "fulfilled");
    const blocked = results.find((result) => result.status === "rejected");
    expect(completed?.status).toBe("fulfilled");
    if (completed?.status === "fulfilled") {
      expect(completed.value.outcome === "activated" || completed.value.outcome === "failed").toBe(true);
    }
    expect(blocked?.status).toBe("rejected");
    if (blocked?.status === "rejected") {
      expect((blocked.reason as Error).message).toContain("already in progress");
    }
    expect(manager.restarts).toBeLessThanOrEqual(1);
    await harness.current.shutdown();
  });

  it("recovers a pending activation and a stale update lock after a crash", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new FakeInstaller();
    installer.verifyOk = true;
    installer.installs.push("2.0.0");
    installer.manifest = { product: "rly-gateway", version: "2.0.0", stateVersion: 4, migrationForwardOnly: false };
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0"); });
    const store = new UpdateStateStore(controlPlaneDir, () => undefined);
    // Crash artifacts: pending-activation record + stale lock owned by a dead process.
    await store.write({
      schemaVersion: 1,
      state: "pending-activation",
      currentVersion: "0.1.0",
      pendingVersion: "2.0.0",
      previousVersion: "0.1.0",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    await writePrivateTextAtomically(join(controlPlaneDir, UPDATE_LOCK_FILE_NAME), `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000073",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner: { pid: 999_999, processStartedAt: "2020-01-01T00:00:00.000Z" },
    })}\n`);
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(result.outcome).toBe("activated");
    expect(await harness.versionOf()).toBe("2.0.0");
    await harness.current.shutdown();
  });

  it("reports identity/readiness verification of the serving runtime version, not the package version", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    // Identity reports the serving runtime version + state version + update state.
    const response = await fetch(`http://127.0.0.1:${String(port)}/identity?challenge=${"a".repeat(32)}`);
    const identity = await response.json() as {
      runtimeVersion?: string;
      stateVersion?: number;
      activeSessions?: number;
      draining?: boolean;
      update?: { state: string };
      proof?: string;
    };
    expect(identity.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(identity.stateVersion).toBe(SCHEMA_V4_VERSION);
    expect(identity.activeSessions).toBe(0);
    expect(identity.draining).toBe(false);
    expect(identity.update?.state).toBe("idle");
    await harness.current.shutdown();
  });

  it("refuses to update a launcher-owned (non-resident) instance", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-update-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-update-plane-");
    const launcher = await acquireGateway({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      heartbeatMs: 5,
    });
    const installer = new FakeInstaller();
    const manager = new FakeServiceManager(() => Promise.resolve());
    const store = new UpdateStateStore(controlPlaneDir);
    await expect(runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: "/fake/candidate" },
      updateStore: store,
    })).rejects.toThrow("launcher-owned");
    expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
    await launcher.release();
  });
});
