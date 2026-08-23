import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALLATION_FILE_NAME, readInstallation, resolveControlPlaneDirectory } from "../storage/installation.js";
import { RLY_STATE_DIRECTORY_NAME, LOG_DIRECTORY, SERVICE_LOG_NAME } from "../storage/paths.js";
import { createServiceManager } from "../service-manager/index.js";
import { bootstrapDirectory } from "../runtime/bootstrap.js";
import { UPDATE_STATE_FILE_NAME, UPDATE_LOCK_FILE_NAME } from "../runtime/update/types.js";
import { INSTALLER_STATE_DIRECTORY } from "../installer/state.js";
import { readPrivateSymlinkTarget, removePrivateSymlinkIfPresent } from "../storage/private-files.js";
import { probeUserLauncherSymlink } from "./install.js";

/**
 * `rly uninstall` (#129) — removes ONLY RLY-owned service registration and
 * product artifacts while PRESERVING `~/.rly` durable user data by default
 * (configuration, accounts, credential state, control-plane database, Claude
 * overlay, logs, compatibility/canary evidence). Never touches native
 * Claude/Codex configuration or any foreign/unowned path.
 *
 * Default: stop/disable/remove the RLY-owned launchd/systemd definition, then
 * remove the installed executable/bootstrap artifacts (`bootstrap/`,
 * `runtime/`, `installer/`, update state) inside the RLY home. The secret-free
 * installation record is retained so a fresh trusted installer can recover an
 * internal or external config path without guessing or overwriting it.
 *
 * `--purge --yes`: explicit destructive removal of the ENTIRE RLY control
 * plane (`~/.rly` by default). Unambiguous intent is required (`--purge`
 * alone refuses); native Claude/Codex config is never touched.
 */

export type UninstallCommandOptions = Readonly<{
  configPath: string;
  purge: boolean;
  yes: boolean;
  home?: string;
}>;

export type UninstallCommandDependencies = Readonly<{
  createServiceManager?: (input: Parameters<typeof createServiceManager>[0]) => ReturnType<typeof createServiceManager>;
}>;

export function parseUninstallArgs(args: readonly string[], cwd: string): UninstallCommandOptions {
  let configPath = resolve(cwd, "gateway.config.toml");
  let purge = false;
  let yes = false;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--config requires a path");
      configPath = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token === "--purge") {
      purge = true;
      index += 1;
      continue;
    }
    if (token === "--yes") {
      yes = true;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${token ?? "<missing>"}`);
  }
  return { configPath, purge, yes };
}

/**
 * Removes ONLY the RLY-owned launchd/systemd definition for the current user
 * (stop/disable first). Foreign or unrelated service definitions are never
 * touched; a missing definition is a no-op.
 */
export async function unregisterService(
  options: Readonly<{ home: string; controlPlaneDirectory: string }>,
  dependencies: UninstallCommandDependencies = {},
): Promise<Readonly<{ unregistered: boolean; platform: string }>> {
  const manager = (dependencies.createServiceManager ?? createServiceManager)({
    home: options.home,
    logPath: join(options.controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    workingDirectory: options.controlPlaneDirectory,
  });
  if (!manager.isSupported()) {
    return { unregistered: false, platform: manager.platform };
  }
  if (await manager.isRegistered()) {
    await manager.unregister();
    return { unregistered: true, platform: manager.platform };
  }
  return { unregistered: false, platform: manager.platform };
}

/** RLY-owned executable/install artifacts removed by a default uninstall. */
export function installArtifactPaths(controlPlaneDirectory: string): ReadonlyArray<{ path: string; kind: string }> {
  return [
    { path: bootstrapDirectory(controlPlaneDirectory), kind: "bootstrap" },
    { path: join(controlPlaneDirectory, "runtime"), kind: "runtime-store" },
    { path: join(controlPlaneDirectory, INSTALLER_STATE_DIRECTORY), kind: "installer-state" },
    { path: join(controlPlaneDirectory, UPDATE_STATE_FILE_NAME), kind: "update-state" },
    { path: join(controlPlaneDirectory, UPDATE_LOCK_FILE_NAME), kind: "update-lock" },
  ];
}

/**
 * Removes the user-facing `~/.local/bin/rly` launcher symlink ONLY when it is
 * RLY-owned (points at the stable bootstrap). A foreign path is never
 * deleted or overwritten.
 */
export async function removeUserLauncherSymlink(
  options: Readonly<{ home: string; controlPlaneDirectory: string }>,
): Promise<Readonly<{ removed: boolean; foreign: boolean }>> {
  const linkPath = join(options.home, ".local", "bin", "rly");
  const expected = bootstrapDirectory(options.controlPlaneDirectory);
  const target = await readPrivateSymlinkTarget(linkPath).catch(() => undefined);
  if (target === undefined) {
    // Not a private symlink; check whether a foreign file occupies the path.
    const { lstat } = await import("node:fs/promises");
    const details = await lstat(linkPath).catch(() => undefined);
    if (details !== undefined) return { removed: false, foreign: true };
    return { removed: false, foreign: false };
  }
  const resolved = resolve(linkPath, "..", target);
  if (!resolved.startsWith(expected)) return { removed: false, foreign: true };
  await removePrivateSymlinkIfPresent(linkPath);
  return { removed: true, foreign: false };
}

/**
 * `rly uninstall` entry: default (preserve durable user data) or `--purge`
 * (destructive removal of the whole RLY control plane with explicit intent).
 */
export async function runUninstallCommand(
  options: UninstallCommandOptions,
  dependencies: UninstallCommandDependencies = {},
): Promise<number> {
  const home = options.home ?? homedir();
  const controlPlaneDirectory = await resolveControlPlaneDirectory(home);
  const installation = await readInstallation(controlPlaneDirectory);

  if (options.purge) {
    if (!options.yes) {
      console.log(JSON.stringify({
        ok: false,
        error: "`--purge` destroys the ENTIRE RLY control plane including configuration, accounts, and credential state. Re-run with `--purge --yes` to confirm the explicit destructive intent",
      }));
      return 1;
    }
    // Stop/disable/remove the RLY-owned service definition first, then remove
    // the whole RLY home. Native Claude/Codex config is never touched (we
    // operate exclusively inside the RLY control plane).
    await unregisterService({ home, controlPlaneDirectory }, dependencies);
    await removeUserLauncherSymlink({ home, controlPlaneDirectory });
    const { rm } = await import("node:fs/promises");
    await rm(controlPlaneDirectory, { recursive: true, force: true });
    const defaultDir = join(home, RLY_STATE_DIRECTORY_NAME);
    if (resolve(controlPlaneDirectory) !== resolve(defaultDir)) {
      await rm(join(defaultDir, INSTALLATION_FILE_NAME), { force: true });
    }
    console.log(JSON.stringify({
      ok: true,
      purged: true,
      removed: controlPlaneDirectory,
      message: "RLY control plane destroyed (explicit --purge). Native Claude/Codex configuration was not touched",
    }));
    return 0;
  }

  if (installation === undefined) {
    console.log(JSON.stringify({ ok: false, error: "RLY is not installed here (no ~/.rly installation record)" }));
    return 1;
  }

  const launcherProbe = await probeUserLauncherSymlink({ home, controlPlaneDirectory });
  if (launcherProbe.foreign) {
    console.log(JSON.stringify({
      ok: false,
      error: "~/.local/bin/rly is not RLY-owned; refusing to remove a foreign path. Inspect it before continuing",
    }));
    return 1;
  }
  const service = await unregisterService({ home, controlPlaneDirectory }, dependencies);
  await removeUserLauncherSymlink({ home, controlPlaneDirectory });
  const { rm } = await import("node:fs/promises");
  for (const artifact of installArtifactPaths(controlPlaneDirectory)) {
    await rm(artifact.path, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    ok: true,
    uninstalled: true,
    service: { unregistered: service.unregistered, platform: service.platform },
    removed: installArtifactPaths(controlPlaneDirectory).map((entry) => ({ path: entry.path, kind: entry.kind })),
    preserved: controlPlaneDirectory,
    message: "RLY service and product artifacts removed; ~/.rly configuration/accounts/credential state preserved. Use `rly uninstall --purge --yes` only to destroy that data explicitly",
  }));
  return 0;
}