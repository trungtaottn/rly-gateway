import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { resolveInstallContext } from "../../src/cli/install.js";
import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { resolveUserConfig } from "../../src/config/user-config.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { DEFAULT_ORIGIN } from "../../src/installer/metadata.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { bootstrapScriptPath } from "../../src/runtime/bootstrap.js";
import type { RuntimeInspection } from "../../src/runtime/gateway-lifecycle.js";
import type { ServiceDefinitionInput, ServiceManagerAdapter } from "../../src/service-manager/types.js";

const directories: string[] = [];

async function directory(prefix = "rly-custom-root-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(dataDirectory: string): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port: 17871, managementPort: 17872, logLevel: "silent" },
    controlPlane: { dataDirectory },
  });
}

function fakeManager(calls: { registered: number; started: number; unregistered: number }, definitionPath: string): ServiceManagerAdapter {
  let content: string | undefined;
  return {
    platform: "linux",
    serviceName: "rly-gateway",
    isSupported: () => true,
    isRegistered: () => Promise.resolve(content !== undefined),
    register: async (input: ServiceDefinitionInput) => {
      calls.registered += 1;
      content = input.executable + " gateway start --config " + input.configPath;
      await writeFile(definitionPath, content, "utf8");
    },
    unregister: () => {
      calls.unregistered += 1;
      content = undefined;
      return Promise.resolve(undefined);
    },
    start: () => {
      calls.started += 1;
      return Promise.resolve(undefined);
    },
    restart: () => Promise.resolve(undefined),
    stop: () => Promise.resolve(undefined),
    status: () => Promise.resolve("running"),
  };
}

function readyInspection(): RuntimeInspection {
  return {
    state: "attested-compatible",
    resident: true,
    runtimeVersion: RUNTIME_VERSION,
    instanceId: "00000000-0000-4000-8000-000000000165",
  };
}

describe("custom dataDirectory pointer flow (N1)", () => {
  it("init --config custom shares one root across config/install/uninstall with no dangling launcher", async () => {
    const home = await directory("rly-home-");
    const custom = await directory("rly-plane-");
    const configPath = join(home, "custom.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      "host = \"127.0.0.1\"",
      "port = 17871",
      "managementPort = 17872",
      "logLevel = \"silent\"",
      "[controlPlane]",
      `dataDirectory = ${JSON.stringify(custom)}`,
    ].join("\n"), "utf8");
    const calls = { registered: 0, started: 0, unregistered: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);

    const code = await runInit(configPath, {
      home,
      loadConfig: () => Promise.resolve(config(custom)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager(calls, join(home, "rly-gateway.service")),
      waitForReadiness: () => Promise.resolve(readyInspection()),
      ensureInitialActiveDeployment: () => Promise.resolve({ created: true, artifactId: "a".repeat(64) }),
    });
    expect(code).toBe(0);

    const pointer = JSON.parse(await readFile(join(home, ".rly", "installation.json"), "utf8")) as {
      dataDirectory: string;
      configPath: string;
      bootstrapPath?: string;
    };
    expect(pointer.dataDirectory).toBe(custom);
    expect(pointer.configPath).toBe(configPath);
    expect(pointer).not.toHaveProperty("schemaVersion");

    const full = JSON.parse(await readFile(join(custom, "installation.json"), "utf8")) as { schemaVersion: number; bootstrapPath?: string };
    expect(full.schemaVersion).toBe(1);

    const actualBootstrap = bootstrapScriptPath(custom);
    expect(full.bootstrapPath).toBe(actualBootstrap);
    expect(pointer.bootstrapPath).toBe(actualBootstrap);
    const launcherTarget = join(custom, "bootstrap", "rly-gateway");
    expect(launcherTarget).toBe(actualBootstrap);

    const resolved = await resolveUserConfig({ home, cwd: "/somewhere/else" });
    expect(resolved.source).toBe("installation");
    expect(resolved.configPath).toBe(configPath);
    expect(resolved.config.controlPlane.dataDirectory).toBe(custom);
    expect(resolved.initialized).toBe(true);

    const installContext = await resolveInstallContext({
      home,
      origin: DEFAULT_ORIGIN,
      channel: "current",
      channelExplicit: false,
      target: "linux-x64",
    });
    expect(installContext.controlPlaneDirectory).toBe(custom);

    await mkdir(join(custom, "runtime", "versions"), { recursive: true, mode: 0o700 });
    await mkdir(join(custom, "installer"), { recursive: true, mode: 0o700 });
    await writeFile(join(custom, "control-plane.sqlite"), "sqlite-bytes\n", { mode: 0o600 });

    const uninstallCode = await runUninstallCommand(
      { configPath, purge: false, yes: false, home },
      { createServiceManager: () => fakeManager(calls, join(home, "rly-gateway.service")) },
    );
    expect(uninstallCode).toBe(0);
    await expect(lstat(join(custom, "bootstrap"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(custom, "installation.json"))).resolves.toBeDefined();
    await expect(lstat(join(home, ".rly", "installation.json"))).resolves.toBeDefined();
    const preservedPointer = JSON.parse(await readFile(join(home, ".rly", "installation.json"), "utf8")) as { dataDirectory: string };
    expect(preservedPointer.dataDirectory).toBe(custom);
  });

  it("fails closed when a ~/.rly pointer refers to a missing data directory", async () => {
    const home = await directory("rly-home-");
    await mkdir(join(home, ".rly"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".rly", "installation.json"), `${JSON.stringify({
      dataDirectory: join(home, "missing-plane"),
      configPath: join(home, "gone.toml"),
    })}\n`, { mode: 0o600 });
    await expect(resolveUserConfig({ home, cwd: "/somewhere/else" })).rejects.toThrow(/missing data directory/);
  });
});