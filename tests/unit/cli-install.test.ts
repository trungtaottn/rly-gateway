import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installUserLauncherSymlink, parseInstallArgs, runInstallCommand } from "../../src/cli/install.js";
import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { DEFAULT_ORIGIN } from "../../src/installer/metadata.js";
import { writeInstallation } from "../../src/storage/installation.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { VerifiedCandidate } from "../../src/installer/types.js";
import type { ServiceManagerAdapter } from "../../src/service-manager/types.js";

const plantForeignLauncher: { path: string | undefined } = { path: undefined };

vi.mock("node:fs/promises", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (target: string, path: string, type?: string) => {
      if (plantForeignLauncher.path !== undefined && path.includes(".tmp")) {
        await actual.writeFile(plantForeignLauncher.path, "foreign-race\n", { mode: 0o755 });
      }
      if (type === undefined) return actual.symlink(target, path);
      return actual.symlink(target, path, type);
    },
  };
});

const directories: string[] = [];

async function directory(prefix = "rly-install-cli-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  plantForeignLauncher.path = undefined;
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function candidate(version = "1.0.0-beta.5", artifactDigest = "b".repeat(64)): VerifiedCandidate {
  return {
    product: "rly-gateway",
    version,
    channel: "beta",
    target: "linux-x64",
    filename: `rly-${version}-linux-x64.tar.gz`,
    sha256: "a".repeat(64),
    artifactDigest,
    buildId: `build-${version}`,
    commitRevision: "c".repeat(40),
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
    stateVersion: 2,
    qualificationStatus: "qualified",
    sourceDirectory: "/tmp/unpacked",
    metadataVersion: 1,
    verifiedAt: new Date().toISOString(),
  };
}

describe("rly install CLI (#129)", () => {
  it("parses install flags", () => {
    expect(parseInstallArgs([], "/work")).toEqual({
      configPath: "/work/gateway.config.toml",
      channel: "current",
      channelExplicit: false,
      origin: DEFAULT_ORIGIN,
    });
    expect(parseInstallArgs(["--channel", "stable", "--target", "linux-x64", "--version", "1.0.0"], "/work")).toEqual({
      configPath: "/work/gateway.config.toml",
      channel: "stable",
      channelExplicit: true,
      origin: DEFAULT_ORIGIN,
      target: "linux-x64",
      version: "1.0.0",
    });
    expect(parseInstallArgs(["--artifact", "rly.tgz", "--metadata-dir", "md"], "/work")).toEqual({
      configPath: "/work/gateway.config.toml",
      channel: "current",
      channelExplicit: false,
      origin: DEFAULT_ORIGIN,
      artifact: "/work/rly.tgz",
      metadataDirectory: "/work/md",
    });
    expect(() => parseInstallArgs(["--bogus"], "/work")).toThrow("unknown option");
    expect(() => parseInstallArgs(["--channel", "prod"], "/work")).toThrow("--channel requires one of");
  });

  it("fails closed on an unsupported platform before any mutation", async () => {
    const homeDir = await directory("rly-home-");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "current", channelExplicit: false, origin: DEFAULT_ORIGIN, target: "win32-x64", home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate()) },
    );
    expect(code).toBe(1);
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { code: string };
    expect(payload.code).toBe("unsupported-platform");
  });

  it("performs a verified first install and guides rly config", async () => {
    const homeDir = await directory("rly-home-");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runInit = vi.fn().mockResolvedValue(0);
    const code = await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "beta", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate()), runInit },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { installed: boolean; version: string; verification: Record<string, unknown>; service: { registered: boolean } };
    expect(payload.installed).toBe(true);
    expect(payload.version).toBe("1.0.0-beta.5");
    expect(payload.verification.signature).toBe(true);
    expect(payload.verification.digest).toBe(true);
    expect(payload.service.registered).toBe(true);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("rly config");
    expect(runInit).toHaveBeenCalledWith(
      join(homeDir, ".rly", "gateway.config.toml"),
      expect.objectContaining({ home: homeDir, packageRoot: "/tmp/unpacked" }),
    );
    // The durable config was written for the installed path.
    const { readFile } = await import("node:fs/promises");
    const configText = await readFile(join(homeDir, ".rly", "gateway.config.toml"), "utf8");
    expect(configText).toContain("dataDirectory");
  });

  it("completes the documented beta reset without overwriting config or credentials", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlane = join(homeDir, ".rly");
    const externalConfig = join(homeDir, "config", "gateway.config.toml");
    const configText = "schemaVersion = 1\n[gateway]\nport = 18765\n";
    await mkdir(join(homeDir, "config"), { recursive: true });
    await writeFile(externalConfig, configText, { mode: 0o600 });
    await mkdir(join(controlPlane, "credentials"), { recursive: true });
    const credentialPath = join(controlPlane, "credentials", "account-1.json");
    await writeFile(credentialPath, "{\"secret\":\"preserved\"}\n", { mode: 0o600 });
    await writeInstallation(controlPlane, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: externalConfig,
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const installationPath = join(controlPlane, "installation.json");
    const savedInstallation = await readFile(installationPath, "utf8");
    const serviceManager: ServiceManagerAdapter = {
      platform: "linux",
      serviceName: "rly-gateway",
      isSupported: () => true,
      isRegistered: () => Promise.resolve(true),
      register: () => Promise.resolve(undefined),
      unregister: () => Promise.resolve(undefined),
      start: () => Promise.resolve(undefined),
      restart: () => Promise.resolve(undefined),
      stop: () => Promise.resolve(undefined),
      status: () => Promise.resolve("stopped"),
    };
    expect(await runUninstallCommand(
      { configPath: externalConfig, purge: false, yes: false, home: homeDir },
      { createServiceManager: () => serviceManager },
    )).toBe(0);
    // Old beta uninstallers removed this record. The documented reset backs
    // it up before uninstall and restores it before running the new bootstrap.
    await unlink(installationPath);
    await writeFile(installationPath, savedInstallation, { mode: 0o600 });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runInit = vi.fn().mockResolvedValue(0);
    const code = await runInstallCommand(
      { configPath: "/ignored/gateway.config.toml", channel: "stable", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue({ ...candidate("0.1.0"), channel: "stable" }), runInit },
    );
    expect(code).toBe(0);
    expect(runInit).toHaveBeenCalledWith(externalConfig, expect.objectContaining({ home: homeDir }));
    await expect(readFile(externalConfig, "utf8")).resolves.toBe(configText);
    await expect(readFile(credentialPath, "utf8")).resolves.toContain("preserved");
  });

  it("repairs an existing installation idempotently and reports an update handoff", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlane = join(homeDir, ".rly");
    await mkdir(join(controlPlane, "runtime", "refs"), { recursive: true, mode: 0o700 });
    await writeInstallation(controlPlane, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(controlPlane, "gateway.config.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    await writeFile(join(controlPlane, "gateway.config.toml"), "schemaVersion = 1\n[gateway]\nlogLevel = \"silent\"\n", "utf8");
    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
    await mkdirFs(join(controlPlane, "runtime", "versions", "b".repeat(64)), { recursive: true, mode: 0o700 });
    await mkdirFs(join(controlPlane, "runtime", "versions", "b".repeat(64), "dist", "cli"), { recursive: true, mode: 0o700 });
    await writeFileFs(join(controlPlane, "runtime", "versions", "b".repeat(64), "dist", "cli", "main.js"), "// runtime\n", "utf8");
    await writeFileFs(join(controlPlane, "runtime", "versions", "b".repeat(64), ".rly-deployment.json"), `${JSON.stringify({
      schemaVersion: 1,
      artifactId: "b".repeat(64),
      product: "rly-gateway",
      version: "1.0.0-beta.5",
      stateVersion: 2,
      migrationClass: "backward-compatible-expand",
      installedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const { replacePrivateSymlinkAtomically } = await import("../../src/storage/private-files.js");
    await replacePrivateSymlinkAtomically(join(controlPlane, "runtime", "refs", "active"), `../versions/${"b".repeat(64)}`);
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runInit = vi.fn().mockResolvedValue(0);
    const code = await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "beta", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate("1.0.0-beta.5", "b".repeat(64))), runInit },
    );
    expect(code).toBe(0);
    expect(runInit).toHaveBeenCalledWith(
      join(controlPlane, "gateway.config.toml"),
      expect.objectContaining({ home: homeDir, packageRoot: "/tmp/unpacked" }),
    );
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { reinitialized: boolean; repair: { verified: boolean; updated: boolean } };
    expect(payload.reinitialized).toBe(true);
    expect(payload.repair.verified).toBe(true);
    expect(payload.repair.updated).toBe(false);
  });

  it("reports a verified update handoff when the artifact differs from the serving deployment", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlane = join(homeDir, ".rly");
    await mkdir(join(controlPlane, "runtime", "refs"), { recursive: true, mode: 0o700 });
    await writeInstallation(controlPlane, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(controlPlane, "gateway.config.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    await writeFile(join(controlPlane, "gateway.config.toml"), "schemaVersion = 1\n[gateway]\nlogLevel = \"silent\"\n", "utf8");
    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
    await mkdirFs(join(controlPlane, "runtime", "versions", "d".repeat(64)), { recursive: true, mode: 0o700 });
    await mkdirFs(join(controlPlane, "runtime", "versions", "d".repeat(64), "dist", "cli"), { recursive: true, mode: 0o700 });
    await writeFileFs(join(controlPlane, "runtime", "versions", "d".repeat(64), "dist", "cli", "main.js"), "// runtime\n", "utf8");
    await writeFileFs(join(controlPlane, "runtime", "versions", "d".repeat(64), ".rly-deployment.json"), `${JSON.stringify({
      schemaVersion: 1,
      artifactId: "d".repeat(64),
      product: "rly-gateway",
      version: "1.0.0-beta.5",
      stateVersion: 2,
      migrationClass: "backward-compatible-expand",
      installedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const { replacePrivateSymlinkAtomically } = await import("../../src/storage/private-files.js");
    await replacePrivateSymlinkAtomically(join(controlPlane, "runtime", "refs", "active"), `../versions/${"d".repeat(64)}`);
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runInit = vi.fn().mockResolvedValue(0);
    const code = await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "beta", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate("1.0.0-beta.6", "b".repeat(64))), runInit },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { repair: { updated: boolean } };
    expect(payload.repair.updated).toBe(true);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("rly update");
  });

  it("records acquisition state (observed channel + audit log) secret-free", async () => {
    const homeDir = await directory("rly-home-");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "beta", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate()), runInit: vi.fn().mockResolvedValue(0) },
    );
    const { AcquisitionStateStore } = await import("../../src/installer/state.js");
    const store = new AcquisitionStateStore(join(homeDir, ".rly"));
    expect(await store.highestObservedVersion("beta")).toBe(1);
    const log = await store.readLog();
    expect(log.length).toBe(1);
    expect(log[0]?.kind).toBe("install");
    expect(JSON.stringify(log[0])).not.toMatch(/Bearer|token|api[_-]?key|authorization|@/i);
  });

  it("refuses a foreign launcher symlink before firstInstall/runInit", async () => {
    const homeDir = await directory("rly-home-");
    await mkdir(join(homeDir, ".local", "bin"), { recursive: true, mode: 0o755 });
    await symlink("/usr/bin/true", join(homeDir, ".local", "bin", "rly"));
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runInit = vi.fn().mockResolvedValue(0);
    const code = await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "beta", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate()), runInit },
    );
    expect(code).toBe(1);
    expect(runInit).not.toHaveBeenCalled();
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { ok: boolean; error: string; service?: { registered?: boolean } };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("not RLY-owned");
    expect(payload.service?.registered).not.toBe(true);
    const { readlink } = await import("node:fs/promises");
    await expect(readlink(join(homeDir, ".local", "bin", "rly"))).resolves.toBe("/usr/bin/true");
  });

  it("returns structured JSON for a regular-file launcher instead of throwing EINVAL", async () => {
    const homeDir = await directory("rly-home-");
    const linkPath = join(homeDir, ".local", "bin", "rly");
    await mkdir(join(homeDir, ".local", "bin"), { recursive: true, mode: 0o755 });
    await writeFile(linkPath, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runInit = vi.fn().mockResolvedValue(0);
    const code = await runInstallCommand(
      { configPath: "/work/gateway.config.toml", channel: "beta", channelExplicit: true, origin: DEFAULT_ORIGIN, home: homeDir },
      { acquire: vi.fn().mockResolvedValue(candidate()), runInit },
    );
    expect(code).toBe(1);
    expect(runInit).not.toHaveBeenCalled();
    const printed = String(output.mock.calls.at(-1)?.[0]);
    expect(printed).not.toContain("EINVAL");
    const payload = JSON.parse(printed) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("not RLY-owned");
    await expect(readFile(linkPath, "utf8")).resolves.toContain("foreign");
    const launcher = await installUserLauncherSymlink({ home: homeDir, controlPlaneDirectory: join(homeDir, ".rly") });
    expect(launcher.foreign).toBe(true);
    expect(launcher.created).toBe(false);
    await expect(readFile(linkPath, "utf8")).resolves.toContain("foreign");
  });

  it("does not overwrite a foreign file that appears before launcher rename", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlaneDirectory = join(homeDir, ".rly");
    const linkPath = join(homeDir, ".local", "bin", "rly");
    await mkdir(join(homeDir, ".local", "bin"), { recursive: true, mode: 0o755 });
    plantForeignLauncher.path = linkPath;
    const result = await installUserLauncherSymlink({ home: homeDir, controlPlaneDirectory });
    expect(result.foreign).toBe(true);
    expect(result.created).toBe(false);
    await expect(readFile(linkPath, "utf8")).resolves.toBe("foreign-race\n");
  });

});
