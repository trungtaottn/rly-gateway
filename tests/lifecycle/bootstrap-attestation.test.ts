import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { startResidentRuntime, type ResidentRuntimeHandle } from "../../src/runtime/resident-runtime.js";
import { acquireGateway, inspectGateway, inspectRuntimeGateway } from "../../src/runtime/gateway-lifecycle.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { RuntimeStore } from "../../src/runtime/runtime-store.js";
import { runUpdate } from "../../src/runtime/update/lifecycle.js";
import { LocalCandidateInstaller, computeArtifactId } from "../../src/runtime/update/installer.js";
import { UpdateStateStore } from "../../src/runtime/update/store.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { defaultBuildIdentity, buildIdentityDigest, type BuildIdentity } from "../../src/runtime/build-identity.js";
import { resolveActiveDeployment } from "../../src/runtime/bootstrap.js";
import { runtimePaths } from "../../src/storage/paths.js";
import type { ServiceManagerAdapter, ServiceStatus } from "../../src/service-manager/types.js";
import { SCHEMA_V4_VERSION } from "../../src/storage/schema-v4.js";

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

function buildIdentityFor(version: string, artifactId?: string): BuildIdentity {
  return {
    ...defaultBuildIdentity(),
    semanticVersion: version,
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

function serverFor(version: string, artifactId?: string) {
  return (options: Parameters<typeof createGatewayServer>[0]) => createGatewayServer({
    ...options,
    runtimeVersion: version,
    buildIdentity: buildIdentityFor(version, artifactId),
  });
}

/** Builds a real immutable candidate directory for the LocalCandidateInstaller. */
async function candidateDir(root: string, version: string): Promise<string> {
  const source = join(root, `candidate-${version}`);
  await mkdir(join(source, "dist", "cli"), { recursive: true, mode: 0o700 });
  await chmod(source, 0o700);
  await chmod(join(source, "dist"), 0o700);
  await chmod(join(source, "dist", "cli"), 0o700);
  await writeFile(join(source, "dist", "cli", "main.js"), `// rly ${version}\n`, "utf8");
  await writeFile(join(source, "rly.json"), JSON.stringify({ product: "rly-gateway", version, stateVersion: 4, migrationClass: "backward-compatible-expand" }), "utf8");
  return source;
}

async function seedControlPlane(directory: string): Promise<void> {
  const store = await ControlPlaneStore.open(directory);
  const created = store.createProvider({ name: "openrouter", integrationMode: "direct", endpointPolicy: "loopback" }, "cli");
  const first = store.createAccount({ pseudonym: "acct-attest-a", providerId: created.id, credentialHandle: "env:OPENROUTER_API_KEY" }, "cli");
  const ready = store.bindCredential(first.id, first.version, { credentialHandle: "env:OPENROUTER_API_KEY", credentialGeneration: 1, state: "ready" }, "cli");
  const pool = store.createPool({ name: "attest-pool", providerId: created.id, strategy: "fill-first", retryBudget: 1, accountIds: [ready.id] }, "cli");
  store.createProfile({ name: "work", harness: "claude", providerId: created.id, poolId: pool.id, modelRoles: { primary: "openrouter/model-a" } }, "cli");
  store.close();
}

class FakeServiceManager implements ServiceManagerAdapter {
  platform = "linux" as const;
  serviceName = "rly-gateway";
  restarts = 0;
  #handler: () => Promise<void>;

  constructor(handler: () => Promise<void>) {
    this.#handler = handler;
  }

  set handler(handler: () => Promise<void>) { this.#handler = handler; }

  isSupported(): boolean { return true; }
  isRegistered(): Promise<boolean> { return Promise.resolve(true); }
  register(): Promise<void> { return Promise.resolve(); }
  unregister(): Promise<void> { return Promise.resolve(); }
  start(): Promise<void> { return this.#handler(); }
  restart(): Promise<void> { this.restarts += 1; return this.#handler(); }
  stop(): Promise<void> { return Promise.resolve(); }
  status(): Promise<ServiceStatus> { return Promise.resolve("running"); }
}

type RuntimeHarness = Readonly<{
  current: ResidentRuntimeHandle;
  restartTo: (version: string, artifactId?: string) => Promise<void>;
}>;

async function startHarness(
  port: number,
  managementPort: number,
  runtimeDir: string,
  controlPlaneDir: string,
  version = RUNTIME_VERSION,
  artifactId?: string,
): Promise<RuntimeHarness> {
  const bootOptions = {
    config: config(port, managementPort, controlPlaneDir),
    runtimeDirectory: runtimeDir,
    controlPlaneDirectory: controlPlaneDir,
    heartbeatMs: 5,
    createServer: serverFor(version, artifactId),
    buildIdentity: buildIdentityFor(version, artifactId),
  };
  let current = await startResidentRuntime(bootOptions);
  const restartTo = async (nextVersion: string, nextArtifactId?: string): Promise<void> => {
    const old = current;
    await old.shutdown();
    await old.stopped;
    current = await startResidentRuntime({
      ...bootOptions,
      createServer: serverFor(nextVersion, nextArtifactId),
      buildIdentity: buildIdentityFor(nextVersion, nextArtifactId),
    });
  };
  return { current, restartTo };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bootstrap attestation and exact build identity (#94)", () => {
  it("reports the exact build identity on /identity and inspection", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-attest-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-attest-plane-");
    const artifactId = "a".repeat(64);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir, RUNTIME_VERSION, artifactId);

    const state = await inspectRuntimeGateway(config(port, managementPort, controlPlaneDir), runtimeDir);
    expect(state.state).toBe("attested-compatible");
    if (state.state !== "attested-compatible") return;
    expect(state.buildIdentity?.semanticVersion).toBe(RUNTIME_VERSION);
    expect(state.buildIdentity?.artifactId).toBe(artifactId);
    expect(state.runtimeVersion).toBe(RUNTIME_VERSION);

    // The raw /identity payload carries the same build identity.
    const store = new RuntimeStore(runtimeDir);
    const secret = await store.readInstanceSecret();
    expect(secret).toBeDefined();
    const identity = await fetch(`http://127.0.0.1:${String(port)}/identity?challenge=${"a".repeat(32)}`).then((r) => r.json()) as { build?: BuildIdentity };
    expect(identity.build?.semanticVersion).toBe(RUNTIME_VERSION);
    expect(identity.build?.artifactId).toBe(artifactId);
    await harness.current.shutdown();
  });

  it("reuses one attested instance only for the exact same build identity", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-attest-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-attest-plane-");
    const artifactId = "a".repeat(64);
    const [first, second] = await Promise.all([
      acquireGateway({
        config: config(port, managementPort, controlPlaneDir),
        runtimeDirectory: runtimeDir,
        controlPlaneDirectory: controlPlaneDir,
        heartbeatMs: 5,
        buildIdentity: buildIdentityFor(RUNTIME_VERSION, artifactId),
      }),
      acquireGateway({
        config: config(port, managementPort, controlPlaneDir),
        runtimeDirectory: runtimeDir,
        controlPlaneDirectory: controlPlaneDir,
        heartbeatMs: 5,
        buildIdentity: buildIdentityFor(RUNTIME_VERSION, artifactId),
      }),
    ]);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(second.instanceId).toBe(first.instanceId);
    await second.release();
    await first.release();
  });

  it("fails closed on same-semantic-version-different-artifact ownership evidence", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-attest-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-attest-plane-");
    const artifactId = "a".repeat(64);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir, RUNTIME_VERSION, artifactId);

    // Same semantic version, DIFFERENT artifact: rewrite the ownership record
    // with the digest of another artifact's build identity — the running
    // process reports artifact A, so this record can never be reused.
    const store = new RuntimeStore(runtimeDir);
    const record = await store.readOwnershipRecord();
    expect(record).toBeDefined();
    if (record === undefined) return;
    await store.writeOwnershipRecord({
      ...record,
      executableFingerprint: buildIdentityDigest(buildIdentityFor(RUNTIME_VERSION, "b".repeat(64))),
    });

    expect(await inspectGateway(config(port, managementPort, controlPlaneDir), runtimeDir)).toBe("attested-incompatible");
    await expect(acquireGateway({
      config: config(port, managementPort, controlPlaneDir),
      runtimeDirectory: runtimeDir,
      controlPlaneDirectory: controlPlaneDir,
      buildIdentity: buildIdentityFor(RUNTIME_VERSION, "b".repeat(64)),
    })).rejects.toThrow(/attested but incompatible/);
    // The foreign/unattested gate still applies and the process is never signaled.
    expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
    await harness.current.shutdown();
  });

  it("probation rejects a candidate whose serving artifact differs (same semantic version)", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-attest-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-attest-plane-");
    const root = await temporaryDirectory("rly-attest-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id1 = await computeArtifactId(src1);
    // The restarted runtime boots DIFFERENT bytes than the committed candidate
    // (same semantic version, different artifact): probation must fail closed.
    const boots = [
      { version: "2.0.0", artifactId: "c".repeat(64) },
      { version: "0.1.0", artifactId: id1 },
    ];
    const manager = new FakeServiceManager(async () => {
      const boot = boots.shift();
      if (boot === undefined) throw new Error("unexpected restart");
      await harness.restartTo(boot.version, boot.artifactId);
    });
    const store = new UpdateStateStore(controlPlaneDir);

    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: src2 },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(result.outcome).toBe("rolled-back");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe("0.1.0");
    expect(manager.restarts).toBe(2); // one candidate boot, one verified rollback boot
    const finalState = await inspectGateway(config(port, managementPort, controlPlaneDir), runtimeDir);
    expect(finalState).toBe("attested-compatible");
    await harness.current.shutdown();
  });

  it("probation accepts the exact committed artifact identity and the update commits", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-attest-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-attest-plane-");
    const root = await temporaryDirectory("rly-attest-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id2 = await computeArtifactId(src2);
    // The restarted runtime boots the committed candidate deployment exactly.
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0", id2); });
    const store = new UpdateStateStore(controlPlaneDir);

    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: src2 },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(result.outcome).toBe("activated");
    expect(result.state).toBe("active");
    expect(result.currentVersion).toBe("2.0.0");
    await harness.current.shutdown();
  });

  it("keeps definition-write/reload/restart boundaries safe: bootstrap always resolves the committed ref", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const runtimeDir = await temporaryDirectory("rly-attest-runtime-");
    const controlPlaneDir = await temporaryDirectory("rly-attest-plane-");
    const root = await temporaryDirectory("rly-attest-candidates-");
    await seedControlPlane(controlPlaneDir);
    const harness = await startHarness(port, managementPort, runtimeDir, controlPlaneDir);
    const installer = new LocalCandidateInstaller({ directory: controlPlaneDir });
    const src1 = await candidateDir(root, "0.1.0");
    await installer.installCandidate({ version: "0.1.0", sourceDirectory: src1 });
    await installer.activateStaged();
    const src2 = await candidateDir(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: src2 });
    const id2 = await computeArtifactId(src2);
    const store = new UpdateStateStore(controlPlaneDir);

    // Crash-window simulation: the definition was written, the active ref was
    // switched, but the restart has NOT happened yet. The bootstrap (and the
    // resolver) must already point at the committed candidate — never at a
    // staged-only or deleted deployment.
    const beforeSwitch = await resolveActiveDeployment(controlPlaneDir).catch(() => undefined);
    expect(beforeSwitch?.artifactId).toBe(await computeArtifactId(src1));
    await installer.activateStaged();
    const afterSwitch = await resolveActiveDeployment(controlPlaneDir);
    expect(afterSwitch.artifactId).toBe(id2);
    expect(afterSwitch.entrypoint).toBe(join(runtimePaths(controlPlaneDir).versions, id2, "dist", "cli", "main.js"));

    // Restart boots the committed candidate; probation verifies exact identity.
    const manager = new FakeServiceManager(async () => { await harness.restartTo("2.0.0", id2); });
    const result = await runUpdate({
      config: config(port, managementPort, controlPlaneDir),
      controlPlaneDirectory: controlPlaneDir,
      runtimeDirectory: runtimeDir,
      installer,
      serviceManager: manager,
      candidate: { version: "2.0.0", sourceDirectory: src2 },
      updateStore: store,
      cliRuntimeVersion: RUNTIME_VERSION,
      cliStateVersion: SCHEMA_V4_VERSION,
    });
    expect(result.outcome).toBe("activated");
    expect(afterSwitch.artifactId).toBe(id2);
    await harness.current.shutdown();
  });
});
