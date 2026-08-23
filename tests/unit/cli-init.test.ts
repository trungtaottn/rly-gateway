import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import type { RuntimeInspection } from "../../src/runtime/gateway-lifecycle.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { bootstrapScriptPath } from "../../src/runtime/bootstrap.js";
import type { createServiceManager } from "../../src/service-manager/index.js";
import type { ServiceDefinitionInput, ServiceManagerAdapter } from "../../src/service-manager/types.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-init-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(dataDirectory: string): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port: 17871, managementPort: 17872, logLevel: "silent" },
    controlPlane: { dataDirectory },
    routes: {},
  });
}

/**
 * Fake adapter that actually stores its rendered definition on disk so
 * service-definition reconciliation (#94) can compare real content.
 */
type FakeAdapter = ServiceManagerAdapter & { definitionPath: string; renderDefinition: (input: ServiceDefinitionInput) => string };

function fakeManager(calls: { registered: number; started: number }, definitionPath: string): FakeAdapter {
  let content: string | undefined;
  return {
    platform: "linux",
    serviceName: "rly-gateway",
    definitionPath,
    isSupported: () => true,
    isRegistered: () => Promise.resolve(content !== undefined),
    register: async (input: ServiceDefinitionInput) => {
      calls.registered += 1;
      content = input.executable + " gateway start --config " + input.configPath;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(definitionPath, content, "utf8");
    },
    renderDefinition: (input: ServiceDefinitionInput) => input.executable + " gateway start --config " + input.configPath,
    unregister: () => Promise.resolve(undefined),
    start: () => { calls.started += 1; return Promise.resolve(undefined); },
    restart: () => { calls.started += 1; return Promise.resolve(undefined); },
    stop: () => Promise.resolve(undefined),
    status: () => Promise.resolve("running" as const),
  };
}

function readyInspection(): RuntimeInspection {
  return {
    state: "attested-compatible",
    resident: true,
    runtimeVersion: RUNTIME_VERSION,
    instanceId: "00000000-0000-4000-8000-000000000065",
  };
}

type InitPayload = {
  ok: boolean;
  initialized: boolean;
  reinitialized?: boolean;
  service: { registered: boolean; platform?: string; bootstrap?: string; reconciliation?: { status?: string; migrated?: boolean } };
  runtime?: { state: string; resident?: boolean; instanceId?: string; runtimeVersion?: string; artifactId?: string };
};

function parseOutput(output: ReturnType<typeof vi.fn>): InitPayload {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as InitPayload;
}

describe("rly init", () => {
  it("registers the service against the stable bootstrap, writes the installation record, and reports readiness", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const configPath = join(homeDir, "gateway.config.toml");
    const calls = { registered: 0, started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);

    const code = await runInit(configPath, {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager(calls, join(homeDir, "rly-gateway.service")),
      waitForReadiness: () => Promise.resolve(readyInspection()),
      ensureInitialActiveDeployment: () => Promise.resolve({ created: true, artifactId: "a".repeat(64) }),
    });
    expect(code).toBe(0);
    expect(calls.registered).toBe(1);
    expect(calls.started).toBe(1);

    const installation = JSON.parse(await readFile(join(controlPlaneDirectory, "installation.json"), "utf8")) as {
      schemaVersion: number;
      version: string;
      configPath: string;
      platform: string;
      serviceName: string;
      registeredAt: string;
      bootstrapPath?: string;
      definitionRevision?: string;
    };
    expect(installation.schemaVersion).toBe(1);
    expect(installation.version).toBe(RUNTIME_VERSION);
    expect(installation.configPath).toBe(configPath);
    expect(installation.platform).toBe("linux");
    expect(installation.serviceName).toBe("rly-gateway");
    expect(installation.registeredAt).toBeDefined();
    // #94: the installation records the stable bootstrap path + definition
    // revision; the definition never points at dist/cli/init.js.
    expect(installation.bootstrapPath).toBe(bootstrapScriptPath(controlPlaneDirectory));
    expect(installation.definitionRevision).toMatch(/^[0-9a-f]{64}$/);

    const pointer = JSON.parse(await readFile(join(homeDir, ".rly", "installation.json"), "utf8")) as {
      dataDirectory: string;
      configPath: string;
      bootstrapPath?: string;
      definitionRevision?: string;
    };
    expect(pointer.dataDirectory).toBe(controlPlaneDirectory);
    expect(pointer.configPath).toBe(configPath);
    expect(pointer.bootstrapPath).toBe(installation.bootstrapPath);
    expect(pointer.definitionRevision).toBe(installation.definitionRevision);

    const payload = parseOutput(output);
    expect(payload.ok).toBe(true);
    expect(payload.initialized).toBe(true);
    expect(payload.runtime?.resident).toBe(true);
    expect(payload.service.registered).toBe(true);
    expect(payload.service.bootstrap).toBe(bootstrapScriptPath(controlPlaneDirectory));
    expect(payload.service.reconciliation?.status).toBe("repaired");
  });

  it("is idempotent: a second init with a correct definition does not re-register", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const configPath = join(homeDir, "gateway.config.toml");
    const calls = { registered: 0, started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);

    const dependencies = {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager(calls, join(homeDir, "rly-gateway.service")),
      waitForReadiness: () => Promise.resolve(readyInspection()),
      ensureInitialActiveDeployment: () => Promise.resolve({ created: false, artifactId: "a".repeat(64) }),
    };
    expect(await runInit(configPath, dependencies)).toBe(0);
    expect(await runInit(configPath, dependencies)).toBe(0);
    // First init repaired the missing definition; the second found it correct
    // (no duplicate registration, no provider reconfiguration).
    expect(calls.registered).toBe(1);
    expect(calls.started).toBe(2);
    const payload = parseOutput(output);
    expect(payload.reinitialized).toBe(true);
    expect(payload.service.reconciliation?.status).toBe("ok");
  });

  it("migrates a stale legacy definition (node + dist/cli/init.js) on re-init", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const configPath = join(homeDir, "gateway.config.toml");
    const calls = { registered: 0, started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const definitionPath = join(homeDir, "rly-gateway.service");
    const manager = fakeManager(calls, definitionPath);
    const dependencies = {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => manager,
      waitForReadiness: () => Promise.resolve(readyInspection()),
      ensureInitialActiveDeployment: () => Promise.resolve({ created: false, artifactId: "a".repeat(64) }),
    };
    // Simulate a legacy pre-#94 definition left by an older install.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(definitionPath, "/usr/bin/node /opt/rly/dist/cli/init.js gateway start --config /old/gateway.config.toml\n", "utf8");
    expect(await runInit(configPath, dependencies)).toBe(0);
    const payload = parseOutput(output);
    expect(payload.service.reconciliation?.status).toBe("repaired");
    expect(payload.service.reconciliation?.migrated).toBe(true);
    const definition = await readFile(definitionPath, "utf8");
    expect(definition).toContain(bootstrapScriptPath(controlPlaneDirectory));
    expect(definition).not.toMatch(/dist[/\\]cli[/\\]init\.js/);
  });

  it("reports failure when the resident runtime never becomes ready", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runInit(join(homeDir, "gateway.config.toml"), {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager({ registered: 0, started: 0 }, join(homeDir, "rly-gateway.service")),
      waitForReadiness: () => Promise.resolve({ state: "occupied-foreign" }),
      ensureInitialActiveDeployment: () => Promise.resolve({ created: true, artifactId: "a".repeat(64) }),
    });
    expect(code).toBe(1);
    const payload = parseOutput(output);
    expect(payload.ok).toBe(false);
    expect(payload.runtime?.state).toBe("occupied-foreign");
  });

  it("passes the durable log and working paths into the service manager", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const captured: { options?: Parameters<typeof createServiceManager>[0] } = {};
    const createManager: (input: Parameters<typeof createServiceManager>[0]) => ServiceManagerAdapter = (input) => {
      captured.options = input;
      return fakeManager({ registered: 0, started: 0 }, join(homeDir, "rly-gateway.service"));
    };
    const code = await runInit(join(homeDir, "gateway.config.toml"), {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: createManager,
      waitForReadiness: () => Promise.resolve(readyInspection()),
      ensureInitialActiveDeployment: () => Promise.resolve({ created: true, artifactId: "a".repeat(64) }),
    });
    expect(code).toBe(0);
    expect(captured.options).toMatchObject({
      home: homeDir,
      logPath: join(controlPlaneDirectory, "logs", "service.log"),
      workingDirectory: controlPlaneDirectory,
    });
  });

  it("skips service registration on unsupported platforms but still initializes the home", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const unsupported: ServiceManagerAdapter = {
      platform: "unsupported",
      serviceName: "rly-gateway",
      isSupported: () => false,
      isRegistered: () => Promise.resolve(false),
      register: () => Promise.resolve(undefined),
      unregister: () => Promise.resolve(undefined),
      start: () => Promise.resolve(undefined),
      restart: () => Promise.resolve(undefined),
      stop: () => Promise.resolve(undefined),
      status: () => Promise.resolve("not-registered"),
    };
    const code = await runInit(join(homeDir, "gateway.config.toml"), {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => unsupported,
    });
    expect(code).toBe(0);
    const payload = parseOutput(output);
    expect(payload.ok).toBe(true);
    expect(payload.service.registered).toBe(false);
  });
});
