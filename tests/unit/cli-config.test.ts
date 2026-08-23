import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfigArgs, runConfig, type ConfigDependencies } from "../../src/cli/config.js";
import { parseCliArgs, runCli } from "../../src/cli/main.js";
import { loadConfig } from "../../src/config/load-config.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { resolveUserConfig } from "../../src/config/user-config.js";
import { acquireGateway } from "../../src/runtime/gateway-lifecycle.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { RuntimeInspection } from "../../src/runtime/gateway-lifecycle.js";
import type { ResidentRuntimeHandle } from "../../src/runtime/resident-runtime.js";
import type { ServiceManagerAdapter } from "../../src/service-manager/types.js";
import { persistUserInstallation, writeInstallation } from "../../src/storage/installation.js";
import type { ManagementResult } from "../../src/cli/management-client.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-config-"));
  directories.push(path);
  return path;
}

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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(dataDirectory: string, port = 17871, managementPort = 17872): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port, managementPort, logLevel: "silent" },
    controlPlane: { dataDirectory },
    routes: {},
  });
}

function readyInspection(): RuntimeInspection {
  return {
    state: "attested-compatible",
    resident: true,
    runtimeVersion: RUNTIME_VERSION,
    instanceId: "00000000-0000-4000-8000-000000000066",
  };
}

function foregroundHandle(
  alreadyRunning: boolean,
  overrides: Partial<Pick<ResidentRuntimeHandle, "shutdown" | "stopped">> = {},
): ResidentRuntimeHandle {
  return {
    baseUrl: "http://127.0.0.1:17871",
    instanceId: "00000000-0000-4000-8000-000000000066",
    runtimeVersion: RUNTIME_VERSION,
    alreadyRunning,
    shutdown: () => Promise.resolve(),
    stopped: Promise.resolve(),
    ...overrides,
  };
}

function fakeManager(calls: { started: number }): ServiceManagerAdapter {
  return {
    platform: "linux",
    serviceName: "rly-gateway",
    isSupported: () => true,
    isRegistered: () => Promise.resolve(calls.started > 0),
    register: () => Promise.resolve(undefined),
    unregister: () => Promise.resolve(undefined),
    start: () => { calls.started += 1; return Promise.resolve(undefined); },
    restart: () => { calls.started += 1; return Promise.resolve(undefined); },
    stop: () => Promise.resolve(undefined),
    status: () => Promise.resolve("running"),
  };
}

function policyResponse(): ManagementResult {
  return { ok: true, status: 200, body: { revision: 3, providers: [], accounts: [], pools: [], profiles: [] } };
}

function healthResponse(): ManagementResult {
  return { ok: true, status: 200, body: { items: [] } };
}

describe("rly config parsing", () => {
  it("parses the bare control-center command and headless flag", () => {
    expect(parseConfigArgs(["config"], "/work")).toEqual({
      command: "config",
      configPath: undefined,
      headless: false,
      focus: { kind: "control-center" },
    });
    expect(parseCliArgs(["config"], "/work")).toMatchObject({ command: "config" });
    expect(parseCliArgs(["config", "--headless"], "/work")).toMatchObject({ headless: true });
    expect(parseCliArgs(["config", "ui"], "/work")).toMatchObject({ focus: { kind: "control-center" } });
    expect(() => parseCliArgs(["config", "ui", "extra"], "/work")).toThrow("config ui accepts no arguments");
  });

  it("parses status with an explicit config path", () => {
    expect(parseConfigArgs(["config", "status"], "/work")).toEqual({
      command: "config",
      configPath: undefined,
      headless: false,
      focus: { kind: "status" },
    });
    expect(parseConfigArgs(["config", "status", "--config", "custom.toml"], "/work")).toMatchObject({
      configPath: "/work/custom.toml",
      focus: { kind: "status" },
    });
    expect(() => parseConfigArgs(["config", "status", "extra"], "/work")).toThrow("config status accepts no arguments");
  });

  it("parses providers/pools/profiles create and accounts actions", () => {
    expect(parseConfigArgs(["config", "providers", "create", "--name", "codex", "--mode", "oauth"], "/work")).toMatchObject({
      focus: { kind: "providers", action: "create", fields: { name: "codex", mode: "oauth" } },
    });
    expect(parseConfigArgs(["config", "providers"], "/work")).toMatchObject({ focus: { kind: "providers", action: "list" } });
    expect(parseConfigArgs(["config", "accounts", "create", "--provider-id", "p-1", "--pseudonym", "acct-1", "--credential-env", "OPENROUTER_API_KEY"], "/work")).toMatchObject({
      focus: { kind: "accounts", action: "create", fields: { "provider-id": "p-1", pseudonym: "acct-1", "credential-env": "OPENROUTER_API_KEY" } },
    });
    expect(parseConfigArgs(["config", "accounts", "login", "--provider-id", "p-1", "--pseudonym", "acct-1"], "/work")).toMatchObject({
      focus: { kind: "accounts", action: "login", fields: { "provider-id": "p-1", pseudonym: "acct-1" } },
    });
    expect(parseConfigArgs(["config", "accounts", "revoke", "--id", "a-1", "--version", "2"], "/work")).toMatchObject({
      focus: { kind: "accounts", action: "revoke", fields: { id: "a-1", version: "2" } },
    });
    expect(parseConfigArgs(["config", "pools", "create", "--name", "pool", "--provider-id", "p-1", "--strategy", "round-robin"], "/work")).toMatchObject({
      focus: { kind: "pools", action: "create", fields: { name: "pool", "provider-id": "p-1", strategy: "round-robin" } },
    });
    expect(parseConfigArgs(["config", "profiles", "create", "--name", "work", "--harness", "claude", "--roles", "{}"], "/work")).toMatchObject({
      focus: { kind: "profiles", action: "create", fields: { name: "work", harness: "claude", roles: "{}" } },
    });
  });

  it("rejects unknown resources and invalid actions", () => {
    expect(() => parseConfigArgs(["config", "bogus"], "/work")).toThrow("config requires status, ui, providers, accounts, pools, profiles, or keys");
    expect(() => parseConfigArgs(["config", "accounts", "bogus"], "/work")).toThrow("config accounts action is not valid");
    expect(() => parseConfigArgs(["config", "providers", "bogus"], "/work")).toThrow("config providers action is not valid");
    expect(() => parseConfigArgs(["config", "--config"], "/work")).toThrow("--config requires a path");
  });

  it("treats config as a reserved command, never a bare profile", () => {
    expect(parseCliArgs(["config"], "/work")).not.toMatchObject({ command: "run-claude" });
  });
});

describe("rly config durable configuration resolution", () => {
  it("uses an explicit --config path when provided", async () => {
    const dir = await directory();
    const path = join(dir, "gateway.toml");
    await writeFile(path, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const resolved = await resolveUserConfig({ home: dir, cwd: dir, explicit: path });
    expect(resolved.source).toBe("explicit");
    expect(resolved.configPath).toBe(path);
    expect(resolved.initialized).toBe(false);
  });

  it("resolves the recorded installation config path from the durable ~/.rly home", async () => {
    const home = await directory();
    await mkdir(join(home, ".rly"), { recursive: true });
    const recorded = join(home, "durable-config.toml");
    await writeFile(recorded, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    await writeInstallation(join(home, ".rly"), {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: recorded,
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const resolved = await resolveUserConfig({ home, cwd: "/somewhere/else" });
    expect(resolved.source).toBe("installation");
    expect(resolved.configPath).toBe(recorded);
    expect(resolved.initialized).toBe(true);
  });

  it("follows a ~/.rly pointer to a custom dataDirectory installation", async () => {
    const home = await directory();
    const custom = await directory();
    const recorded = join(home, "durable-config.toml");
    await writeFile(recorded, "schemaVersion = 1\n[gateway]\nport = 17871\n[controlPlane]\n" + `dataDirectory = ${JSON.stringify(custom)}\n`, "utf8");
    await persistUserInstallation(home, custom, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: recorded,
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const resolved = await resolveUserConfig({ home, cwd: "/somewhere/else" });
    expect(resolved.source).toBe("installation");
    expect(resolved.configPath).toBe(recorded);
    expect(resolved.config.controlPlane.dataDirectory).toBe(custom);
    expect(resolved.initialized).toBe(true);
  });

  it("falls back to schema defaults when the recorded config file is missing", async () => {
    const home = await directory();
    await mkdir(join(home, ".rly"), { recursive: true });
    await writeInstallation(join(home, ".rly"), {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(home, "missing.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const resolved = await resolveUserConfig({ home, cwd: "/somewhere/else" });
    expect(resolved.source).toBe("defaults");
    expect(resolved.configPath).toBeUndefined();
    expect(resolved.initialized).toBe(true);
    expect(resolved.config.gateway.port).toBe(17871);
  });

  it("keeps the CWD file as an explicit dev/operator fallback", async () => {
    const home = await directory();
    const cwd = await directory();
    await writeFile(join(cwd, "gateway.config.toml"), "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const resolved = await resolveUserConfig({ home, cwd });
    expect(resolved.source).toBe("cwd");
    expect(resolved.configPath).toBe(join(cwd, "gateway.config.toml"));
  });

  it("fails actionably when RLY is not initialized", async () => {
    const home = await directory();
    const cwd = await directory();
    await expect(resolveUserConfig({ home, cwd })).rejects.toThrow("run `rly init` first");
  });
});

describe("rly config against a live management listener", () => {
  it("reports status and configures providers from an arbitrary directory", async () => {
    const dir = await directory();
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(dir, "gateway.toml");
    await writeFile(configPath, `schemaVersion = 1\n[gateway]\nport = ${String(port)}\nmanagementPort = ${String(managementPort)}\nlogLevel = "silent"\n`, "utf8");
    const lease = await acquireGateway({
      config: await loadConfig(configPath),
      controlPlaneDirectory: join(dir, "control-plane"),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runCli(["config", "status", "--config", configPath], { environment: {} })).resolves.toBe(0);
      const status = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        ok: boolean; runtime: { state: string; resident?: boolean }; policy: { revision: number };
      };
      expect(status.ok).toBe(true);
      expect(status.runtime.state).toBe("attested-compatible");
      expect(status.policy.revision).toBe(0);

      await expect(runCli([
        "config", "providers", "create", "--name", "openrouter", "--mode", "direct", "--config", configPath,
      ], { environment: {} })).resolves.toBe(0);
      await expect(runCli(["config", "providers", "list", "--config", configPath], { environment: {} })).resolves.toBe(0);
      const listed = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(listed).toContain("openrouter");
      expect(listed).not.toContain("authorization");
      expect(listed).not.toContain("accessToken");
    } finally {
      log.mockRestore();
      await lease.release();
    }
  });

  it("requires id/version fields for account mutations", async () => {
    const dir = await directory();
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(dir, "gateway.toml");
    await writeFile(configPath, `schemaVersion = 1\n[gateway]\nport = ${String(port)}\nmanagementPort = ${String(managementPort)}\nlogLevel = "silent"\n`, "utf8");
    const lease = await acquireGateway({
      config: await loadConfig(configPath),
      controlPlaneDirectory: join(dir, "control-plane"),
    });
    try {
      const command = parseConfigArgs(["config", "accounts", "revoke", "--config", configPath], dir);
      if (!command) throw new Error("expected config command");
      await expect(runConfig(command)).rejects.toThrow("revoke requires --id and --version");
    } finally {
      await lease.release();
    }
  });
});

describe("rly config runtime recovery and headless behavior", () => {
  function deps(overrides: Partial<ConfigDependencies> = {}): ConfigDependencies {
    return {
      home: "/home/fixture",
      cwd: "/work",
      resolveUserConfig: () => Promise.resolve({
        config: config("/home/fixture/.rly"),
        configPath: "/home/fixture/.rly/gateway.toml",
        source: "installation",
        initialized: true,
        home: "/home/fixture",
      }),
      inspectRuntime: () => Promise.resolve(readyInspection()),
      readManagementToken: () => Promise.resolve("mgmt-token"),
      managementRequest: vi.fn((_base, _token, _origin, method, path) => {
        if (method === "GET" && path === "/v1/policy") return Promise.resolve(policyResponse());
        if (method === "GET" && path === "/v1/health") return Promise.resolve(healthResponse());
        return Promise.resolve({ ok: false, status: 404, body: { error: "not-found" } });
      }),
      ...overrides,
    };
  }

  it("recovers the resident service when it is installed but not running", async () => {
    const homeDir = await directory();
    await mkdir(join(homeDir, ".rly"), { recursive: true });
    await writeInstallation(join(homeDir, ".rly"), {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(homeDir, "gateway.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const calls = { started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const command = parseConfigArgs(["config", "status"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps({
      home: homeDir,
      inspectRuntime: () => Promise.resolve({ state: "not-running" }),
      waitForResident: () => Promise.resolve(readyInspection()),
      createServiceManager: () => fakeManager(calls),
    }));
    expect(code).toBe(0);
    expect(calls.started).toBe(1);
    const payload = JSON.parse(String(output.mock.calls[0]?.[0])) as {
      ok: boolean; runtime: { state: string; resident: boolean }; config: { source: string; initialized: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.runtime.state).toBe("attested-compatible");
    expect(payload.runtime.resident).toBe(true);
    expect(payload.config.source).toBe("installation");
    expect(payload.config.initialized).toBe(true);
  });

  it("starts a session-scoped foreground runtime when no service is initialized", async () => {
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const ports = { gateway: true, management: true };
    const shutdown = vi.fn(() => {
      ports.gateway = false;
      ports.management = false;
      return Promise.resolve();
    });
    const start = vi.fn().mockResolvedValue(foregroundHandle(false, { shutdown }));
    const command = parseConfigArgs(["config", "status"], "/work");
    if (!command) throw new Error("expected config command");
    const startedAt = Date.now();
    const code = await runConfig(command, deps({
      inspectRuntime: () => Promise.resolve({ state: "not-running" }),
      readInstallation: () => Promise.resolve(undefined),
      startResidentRuntime: start,
    }));
    expect(code).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(ports).toEqual({ gateway: false, management: false });
    expect(Date.now() - startedAt).toBeLessThan(500);
    const payload = JSON.parse(String(output.mock.calls[0]?.[0])) as { foreground?: { sessionScoped: boolean } };
    expect(payload.foreground?.sessionScoped).toBe(true);
  });

  it("shuts down session-scoped foreground after one-shot focused commands", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const shutdown = vi.fn(() => Promise.resolve());
    const command = parseConfigArgs(["config", "providers", "list"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps({
      inspectRuntime: () => Promise.resolve({ state: "not-running" }),
      readInstallation: () => Promise.resolve(undefined),
      startResidentRuntime: () => Promise.resolve(foregroundHandle(false, { shutdown })),
      managementRequest: vi.fn(() => Promise.resolve({ ok: true, status: 200, body: { items: [] } })),
    }));
    expect(code).toBe(0);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("shuts down session-scoped foreground when the management token is missing", async () => {
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const shutdown = vi.fn(() => Promise.resolve());
    const command = parseConfigArgs(["config", "status"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps({
      inspectRuntime: () => Promise.resolve({ state: "not-running" }),
      readInstallation: () => Promise.resolve(undefined),
      startResidentRuntime: () => Promise.resolve(foregroundHandle(false, { shutdown })),
      readManagementToken: () => Promise.resolve(undefined),
    }));
    expect(code).toBe(1);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(String(output.mock.calls[0]?.[0])).toContain("management is not running");
  });

  it("keeps the session-scoped foreground alive for the interactive control-center", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const shutdown = vi.fn(() => Promise.resolve());
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
    const openBrowser = vi.fn(() => { opened(); });
    const command = parseConfigArgs(["config"], "/work");
    if (!command) throw new Error("expected config command");
    const done = runConfig(command, deps({
      inspectRuntime: () => Promise.resolve({ state: "not-running" }),
      readInstallation: () => Promise.resolve(undefined),
      startResidentRuntime: () => Promise.resolve(foregroundHandle(false, { shutdown, stopped })),
      managementRequest: vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        body: { token: "bootstrap-token-fixture", expiresAt: "2026-08-14T00:00:00.000Z" },
      })),
      openBrowser,
    }));
    await openedPromise;
    expect(shutdown).not.toHaveBeenCalled();
    resolveStopped();
    await expect(done).resolves.toBe(0);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("reuses an already-running resident runtime without touching the service", async () => {
    const calls = { started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const command = parseConfigArgs(["config", "status"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps({
      createServiceManager: () => fakeManager(calls),
    }));
    expect(code).toBe(0);
    expect(calls.started).toBe(0);
  });

  it("fails closed on a foreign listener without signaling it", async () => {
    const command = parseConfigArgs(["config", "status"], "/work");
    if (!command) throw new Error("expected config command");
    await expect(runConfig(command, deps({
      inspectRuntime: () => Promise.resolve({ state: "occupied-foreign" }),
    }))).rejects.toThrow("occupied by a foreign listener");
  });

  it("prints a headless bootstrap URL and never prints the token outside the fragment", async () => {
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const openBrowser = vi.fn();
    const command = parseConfigArgs(["config", "ui", "--headless"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps({
      managementRequest: vi.fn(() => Promise.resolve({ ok: true, status: 200, body: { token: "bootstrap-token-fixture", expiresAt: "2026-08-14T00:00:00.000Z" } })),
      openBrowser,
    }));
    expect(code).toBe(0);
    expect(openBrowser).not.toHaveBeenCalled();
    const printed = output.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain('"url":"http://127.0.0.1:17872/#t=bootstrap-token-fixture"');
    expect(printed).toContain('"headless":true');
  });

  it("requires credential-env for accounts create", async () => {
    const command = parseConfigArgs(["config", "accounts", "create", "--provider-id", "p-1", "--pseudonym", "acct-1"], "/work");
    if (!command) throw new Error("expected config command");
    await expect(runConfig(command, deps())).rejects.toThrow("accounts create requires --provider-id, --pseudonym, and --credential-env");
  });

  it("propagates stale-version mutations explicitly and exits non-zero", async () => {
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const command = parseConfigArgs(["config", "accounts", "pause", "--id", "00000000-0000-4000-8000-000000000001", "--version", "2"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps({
      managementRequest: vi.fn(() => Promise.resolve({ ok: false, status: 409, body: { error: "stale-version" } })),
    }));
    expect(code).toBe(1);
    const printed = output.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("stale-version");
    expect(printed).not.toContain("secret");
    expect(printed).not.toContain("token");
  });

  it("keeps every printed status key on the privacy allowlist", async () => {
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const command = parseConfigArgs(["config", "status"], "/work");
    if (!command) throw new Error("expected config command");
    const code = await runConfig(command, deps());
    expect(code).toBe(0);
    const printed = output.mock.calls.map((call) => String(call[0])).join("\n");
    for (const forbidden of ["accessToken", "refreshToken", "authorization", "password", "email", "identity", "secret"]) {
      expect(printed).not.toContain(forbidden);
    }
  });
});
