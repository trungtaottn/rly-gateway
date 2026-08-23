import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUninstallArgs, runUninstallCommand } from "../../src/cli/uninstall.js";
import { writeInstallation } from "../../src/storage/installation.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { ServiceManagerAdapter } from "../../src/service-manager/types.js";

const directories: string[] = [];

async function directory(prefix = "rly-uninstall-cli-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fakeManager(calls: { unregistered: number; stopped: number }): ServiceManagerAdapter {
  return {
    platform: "linux",
    serviceName: "rly-gateway",
    isSupported: () => true,
    isRegistered: () => Promise.resolve(true),
    register: () => Promise.resolve(undefined),
    unregister: () => { calls.unregistered += 1; return Promise.resolve(undefined); },
    start: () => Promise.resolve(undefined),
    restart: () => Promise.resolve(undefined),
    stop: () => { calls.stopped += 1; return Promise.resolve(undefined); },
    status: () => Promise.resolve("stopped" as const),
  };
}

async function installedHome(): Promise<{ home: string; controlPlane: string }> {
  const home = await directory("rly-home-");
  const controlPlane = join(home, ".rly");
  await mkdir(join(controlPlane, "credentials"), { recursive: true, mode: 0o700 });
  await writeFile(join(controlPlane, "credentials", "account-1.json"), "{\"secret\":\"redacted\"}\n", { mode: 0o600 });
  await mkdir(join(controlPlane, "bootstrap"), { recursive: true, mode: 0o700 });
  await writeFile(join(controlPlane, "bootstrap", "rly-gateway"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(controlPlane, "runtime", "versions", "a".repeat(64)), { recursive: true, mode: 0o700 });
  await writeFile(join(controlPlane, "control-plane.sqlite"), "sqlite-bytes\n", { mode: 0o600 });
  await mkdir(join(controlPlane, "installer"), { recursive: true, mode: 0o700 });
  await writeInstallation(controlPlane, {
    schemaVersion: 1,
    version: RUNTIME_VERSION,
    configPath: join(controlPlane, "gateway.config.toml"),
    platform: "linux",
    serviceName: "rly-gateway",
    registeredAt: new Date().toISOString(),
  });
  return { home, controlPlane };
}

describe("rly uninstall CLI (#129)", () => {
  it("parses uninstall flags", () => {
    expect(parseUninstallArgs([], "/work")).toEqual({ configPath: "/work/gateway.config.toml", purge: false, yes: false });
    expect(parseUninstallArgs(["--purge", "--yes"], "/work")).toEqual({ configPath: "/work/gateway.config.toml", purge: true, yes: true });
    expect(() => parseUninstallArgs(["--bogus"], "/work")).toThrow("unknown option");
  });

  it("refuses when RLY is not installed", async () => {
    const home = await directory("rly-home-");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runUninstallCommand(
      { configPath: "/work/gateway.config.toml", purge: false, yes: false, home },
      { createServiceManager: () => fakeManager({ unregistered: 0, stopped: 0 }) },
    );
    expect(code).toBe(1);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("not installed");
  });

  it("unregisters the RLY-owned service and removes product artifacts while preserving durable data", async () => {
    const { home, controlPlane } = await installedHome();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const calls = { unregistered: 0, stopped: 0 };
    const code = await runUninstallCommand(
      { configPath: "/work/gateway.config.toml", purge: false, yes: false, home },
      { createServiceManager: () => fakeManager(calls) },
    );
    expect(code).toBe(0);
    expect(calls.unregistered).toBe(1);
    const { lstat } = await import("node:fs/promises");
    // Product artifacts removed.
    await expect(lstat(join(controlPlane, "bootstrap"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(controlPlane, "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(controlPlane, "installer"))).rejects.toMatchObject({ code: "ENOENT" });
    // Durable user data preserved.
    await expect(lstat(join(controlPlane, "installation.json"))).resolves.toBeDefined();
    await expect(lstat(join(controlPlane, "credentials"))).resolves.toBeDefined();
    await expect(lstat(join(controlPlane, "control-plane.sqlite"))).resolves.toBeDefined();
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { preserved: string; service: { unregistered: boolean } };
    expect(payload.preserved).toBe(controlPlane);
    expect(payload.service.unregistered).toBe(true);
  });

  it("refuses --purge without explicit confirmation", async () => {
    const { home } = await installedHome();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runUninstallCommand(
      { configPath: "/work/gateway.config.toml", purge: true, yes: false, home },
      { createServiceManager: () => fakeManager({ unregistered: 0, stopped: 0 }) },
    );
    expect(code).toBe(1);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("--purge --yes");
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(join(home, ".rly"))).resolves.toBeDefined();
  });

  it("--purge --yes destroys the RLY control plane with explicit intent and never touches native config", async () => {
    const { home, controlPlane } = await installedHome();
    // Simulate native Claude/Codex config OUTSIDE the RLY home.
    const nativeConfig = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true, mode: 0o700 });
    await writeFile(nativeConfig, "{\"model\":\"opus\"}\n", "utf8");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const calls = { unregistered: 0, stopped: 0 };
    const code = await runUninstallCommand(
      { configPath: "/work/gateway.config.toml", purge: true, yes: true, home },
      { createServiceManager: () => fakeManager(calls) },
    );
    expect(code).toBe(0);
    expect(calls.unregistered).toBe(1);
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(controlPlane)).rejects.toMatchObject({ code: "ENOENT" });
    // Native Claude config untouched.
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(nativeConfig, "utf8")).resolves.toContain("opus");
  });

  it("never removes a foreign ~/.local/bin/rly launcher", async () => {
    const { home, controlPlane } = await installedHome();
    await mkdir(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".local", "bin", "rly"), "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const calls = { unregistered: 0, stopped: 0 };
    const code = await runUninstallCommand(
      { configPath: "/work/gateway.config.toml", purge: false, yes: false, home },
      { createServiceManager: () => fakeManager(calls) },
    );
    expect(code).toBe(1);
    expect(calls.unregistered).toBe(0);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("foreign");
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(home, ".local", "bin", "rly"), "utf8")).resolves.toContain("foreign");
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(join(controlPlane, "bootstrap"))).resolves.toBeDefined();
  });
});
