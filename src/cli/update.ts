import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { RUNTIME_VERSION } from "../runtime/gateway-attestation.js";
import { currentBuildIdentity } from "../runtime/build-identity.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import { bootstrapServiceDefinition, writeBootstrapScript } from "../runtime/bootstrap.js";
import { readCandidateManifestFromDirectory, LocalCandidateInstaller } from "../runtime/update/installer.js";
import { runUpdate, type UpdateRunResult } from "../runtime/update/lifecycle.js";
import { UpdateStateStore } from "../runtime/update/store.js";
import { createServiceManager } from "../service-manager/index.js";
import { readInstallation } from "../storage/installation.js";
import { defaultControlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME } from "../storage/paths.js";
import { SCHEMA_V4_VERSION } from "../storage/schema-v4.js";
import { readProcessIdentity } from "../runtime/process-identity.js";
import type { GatewayConfig } from "../config/schema.js";
import type { GatewayLeaseHandle } from "../runtime/gateway-lifecycle.js";
import { launchPolicy } from "../runtime/update/policy.js";
import { acquireVerifiedCandidate, hostTarget } from "../installer/acquire.js";
import { DEFAULT_ORIGIN } from "../installer/metadata.js";
import { AcquisitionStateStore } from "../installer/state.js";
import { AcquisitionError, CHANNEL_POLICIES, type ChannelPolicy, type ReleaseChannel, type VerifiedCandidate } from "../installer/types.js";

export type UpdateCommandOptions = Readonly<{
  configPath: string;
  /** Channel policy: explicit beta/stable, or `current` (the installed channel). */
  channel: ChannelPolicy;
  /** True when `--channel beta|stable` was given explicitly (channel switch). */
  channelExplicit: boolean;
  /** Artifact origin (GitHub Releases repository by default). */
  origin: string;
  /** Explicit platform target override; default is the host target. */
  target?: string;
  /** #129: install + verify a candidate and STOP (INSTALL != ACTIVATE). */
  installOnly: boolean;
  /** Local candidate directory (dev/offline path; the existing lifecycle). */
  candidate?: Readonly<{ sourceDirectory: string; version?: string }>;
  /** Exact release version pin for remote acquisition. */
  version?: string;
  force: boolean;
  waitTimeoutMs: number;
}>;

export type UpdateCommandDependencies = Readonly<{
  loadConfig?: typeof loadConfig;
  runUpdate?: (dependencies: Parameters<typeof runUpdate>[0]) => Promise<UpdateRunResult>;
  acquire?: (options: Parameters<typeof acquireVerifiedCandidate>[0]) => Promise<VerifiedCandidate>;
  buildIdentity?: () => Promise<BuildIdentity>;
}>;

export function parseUpdateArgs(args: readonly string[], cwd: string): UpdateCommandOptions {
  let configPath = resolve(cwd, "gateway.config.toml");
  let candidateDirectory: string | undefined;
  let version: string | undefined;
  let channel: ChannelPolicy = "current";
  let channelExplicit = false;
  let origin = DEFAULT_ORIGIN;
  let target: string | undefined;
  let installOnly = false;
  let force = false;
  let waitTimeoutMs = 60_000;
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
    if (token === "--candidate") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--candidate requires a candidate directory");
      candidateDirectory = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token === "--version") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--version requires a version");
      version = value;
      index += 2;
      continue;
    }
    if (token === "--channel") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || !(CHANNEL_POLICIES as readonly string[]).includes(value)) {
        throw new Error(`--channel requires one of ${CHANNEL_POLICIES.join("|")}`);
      }
      channel = value as ChannelPolicy;
      channelExplicit = channel !== "current";
      index += 2;
      continue;
    }
    if (token === "--origin") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--origin requires a URL");
      origin = value;
      index += 2;
      continue;
    }
    if (token === "--target") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--target requires a platform target");
      target = value;
      index += 2;
      continue;
    }
    if (token === "--install-only") {
      installOnly = true;
      index += 1;
      continue;
    }
    if (token === "--wait-timeout") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (value === undefined || !Number.isInteger(parsed) || parsed < 1) throw new Error("--wait-timeout requires a positive millisecond value");
      waitTimeoutMs = parsed;
      index += 2;
      continue;
    }
    if (token === "--force") {
      force = true;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${token ?? "<missing>"}`);
  }
  const base = {
    configPath,
    channel,
    channelExplicit,
    origin,
    ...(target === undefined ? {} : { target }),
    installOnly,
    force,
    waitTimeoutMs,
  };
  if (candidateDirectory !== undefined) {
    return {
      ...base,
      candidate: { sourceDirectory: candidateDirectory, ...(version === undefined ? {} : { version }) },
    };
  }
  const remote = channelExplicit || origin !== DEFAULT_ORIGIN || target !== undefined || version !== undefined;
  if (version !== undefined && !remote) throw new Error("--version requires --candidate or --channel");
  return { ...base, ...(version === undefined ? {} : { version }) };
}

/**
 * Resolves the channel policy (#129): an explicit `--channel beta|stable` is
 * honored directly (a documented, auditable channel switch); `current` keeps
 * the channel recorded on the installed build identity (`dev` maps to
 * `stable`). The resolved channel + switch intent is recorded in the
 * acquisition log.
 */
export async function resolveChannelPolicy(
  options: Readonly<{ channel: ChannelPolicy; channelExplicit: boolean; home: string }>,
  dependencies: Readonly<{ buildIdentity?: () => Promise<BuildIdentity> }> = {},
): Promise<Readonly<{ channel: ReleaseChannel; switched: boolean; previousChannel?: ReleaseChannel }>> {
  if (options.channelExplicit && options.channel !== "current") {
    const previous = await currentChannelForHome(options.home, dependencies);
    const switched = previous !== undefined && previous !== options.channel;
    return {
      channel: options.channel,
      switched,
      ...(switched ? { previousChannel: previous } : {}),
    };
  }
  const current = await currentChannelForHome(options.home, dependencies);
  const channel: ReleaseChannel = ((): ReleaseChannel => {
    switch (current) {
      case "beta":
      case "stable":
        return current;
      default:
        return "stable";
    }
  })();
  return { channel, switched: false };
}

async function currentChannelForHome(
  home: string,
  dependencies: Readonly<{ buildIdentity?: () => Promise<BuildIdentity> }>,
): Promise<ReleaseChannel | undefined> {
  const installation = await readInstallation(join(home, ".rly"));
  if (installation !== undefined) {
    // The installation record does not carry a channel; the CLI build identity
    // is the running product's channel (dev/beta/stable).
  }
  const identity = await (dependencies.buildIdentity ?? currentBuildIdentity)();
  if (identity.releaseChannel === "beta" || identity.releaseChannel === "stable") return identity.releaseChannel;
  return undefined;
}

/**
 * `rly update`: two distinct boundaries.
 *
 * Local/dev path (`--candidate <dir>`): the existing #73/#93 lifecycle —
 * install a verified candidate, drain, activate through a controlled
 * service-manager restart, verify, roll back on failure.
 *
 * Remote acquisition path (`--channel beta|stable` / `--origin` / `--version`):
 * #129 verified acquisition resolves the signed channel metadata + release
 * manifest, downloads and verifies the EXACT artifact (digest/signature/
 * tree/qualification), installs it into the #92 immutable store (only
 * `refs/staged`) and reports a VerifiedCandidate — WITHOUT changing the
 * serving `active` reference and WITHOUT restarting the service
 * (INSTALL != ACTIVATE). A later plain `rly update` resumes activation
 * (Wave 4).
 *
 * `--install-only` stops after staging for either path. Distribution/signing
 * is #35/#128; the lifecycle owns activation once a candidate is obtained.
 */
export async function runUpdateCommand(
  options: UpdateCommandOptions,
  dependencies: UpdateCommandDependencies = {},
): Promise<number> {
  const config = await (dependencies.loadConfig ?? loadConfig)(options.configPath);
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const installation = await readInstallation(controlPlaneDirectory);
  if (installation === undefined) {
    console.log(JSON.stringify({ ok: false, error: "RLY is not initialized; run `rly init` first" }));
    return 1;
  }
  const manager = createServiceManager({
    home: homedir(),
    logPath: join(controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    workingDirectory: controlPlaneDirectory,
  });
  if (!manager.isSupported()) {
    console.log(JSON.stringify({ ok: false, error: `per-user service management is not supported on platform ${manager.platform}; update activation requires the resident service` }));
    return 1;
  }
  const installer = new LocalCandidateInstaller({ directory: controlPlaneDirectory });
  const updateStore = new UpdateStateStore(controlPlaneDirectory, (pid) => readProcessIdentity(pid));
  const acquisitionState = new AcquisitionStateStore(controlPlaneDirectory);
  // #94 stable bootstrap: the service definition references the RLY-owned
  // launcher (never dist/cli/init.js, never an incidental Node path, never a
  // direct runtime/refs/... path), so the controlled restart after the
  // `active` ref switch automatically boots the newly committed deployment.
  await writeBootstrapScript(controlPlaneDirectory);

  const remoteAcquisition = options.candidate === undefined
    && (options.channelExplicit || options.origin !== DEFAULT_ORIGIN || options.target !== undefined || options.version !== undefined);

  // #129 verified remote acquisition → stage → VerifiedCandidate handoff.
  if (remoteAcquisition) {
    return await runRemoteAcquisition(options, {
      config,
      controlPlaneDirectory,
      installer,
      updateStore,
      acquisitionState,
      manager,
      installation,
      dependencies,
    });
  }

  let candidate: Readonly<{ version: string; sourceDirectory: string }> | undefined;
  if (options.candidate !== undefined) {
    const manifest = await readCandidateManifestFromDirectory(options.candidate.sourceDirectory);
    const version = options.candidate.version ?? manifest?.version;
    if (version === undefined) {
      console.log(JSON.stringify({ ok: false, error: `candidate ${options.candidate.sourceDirectory} has no rly.json manifest and no --version` }));
      return 1;
    }
    candidate = { version, sourceDirectory: options.candidate.sourceDirectory };
  }
  const result = await (dependencies.runUpdate ?? runUpdate)({
    config,
    controlPlaneDirectory,
    installer,
    serviceManager: manager,
    serviceDefinition: bootstrapServiceDefinition(
      controlPlaneDirectory,
      installation.configPath,
      join(controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    ),
    ...(candidate === undefined ? {} : { candidate }),
    ...(options.installOnly ? { installOnly: true } : {}),
    ...(options.force ? { force: true } : {}),
    drainTimeoutMs: options.waitTimeoutMs,
    updateStore,
    cliRuntimeVersion: RUNTIME_VERSION,
    cliStateVersion: SCHEMA_V4_VERSION,
  });
  console.log(JSON.stringify({
    ok: result.outcome !== "failed",
    state: result.state,
    outcome: result.outcome,
    currentVersion: result.currentVersion,
    ...(result.pendingVersion === undefined ? {} : { pendingVersion: result.pendingVersion }),
    ...(result.phase === undefined ? {} : { phase: result.phase }),
    ...(result.state === "recovery-required" ? { recovery: "manual" } : {}),
    ...(result.message === undefined ? {} : { message: result.message }),
  }));
  return result.outcome === "failed" ? 1 : 0;
}

async function runRemoteAcquisition(
  options: UpdateCommandOptions,
  context: Readonly<{
    config: GatewayConfig;
    controlPlaneDirectory: string;
    installer: LocalCandidateInstaller;
    updateStore: UpdateStateStore;
    acquisitionState: AcquisitionStateStore;
    manager: ReturnType<typeof createServiceManager>;
    installation: NonNullable<Awaited<ReturnType<typeof readInstallation>>>;
    dependencies: UpdateCommandDependencies;
  }>,
): Promise<number> {
  const { dependencies } = context;
  const target = options.target ?? hostTarget() ?? "";
  if (target === "") {
    console.log(JSON.stringify({
      ok: false,
      error: `unsupported platform ${process.platform}-${process.arch}; RLY artifacts are published for darwin-arm64, darwin-x64, linux-x64, linux-arm64`,
    }));
    return 1;
  }
  const policy = await resolveChannelPolicy({ channel: options.channel, channelExplicit: options.channelExplicit, home: homedir() }, dependencies);
  let candidate: VerifiedCandidate;
  try {
    candidate = await (dependencies.acquire ?? acquireVerifiedCandidate)({
      origin: options.origin,
      channel: policy.channel,
      target: target as "linux-x64",
      ...(options.version === undefined ? {} : { version: options.version }),
      stagingDirectory: join(context.controlPlaneDirectory, "installer", "staging"),
      highestObservedVersion: await context.acquisitionState.highestObservedVersion(policy.channel),
    });
  } catch (error) {
    if (error instanceof AcquisitionError) {
      console.log(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    } else {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "acquisition failed" }));
    }
    return 1;
  }
  await context.acquisitionState.recordObserved(policy.channel, candidate.metadataVersion);
  await context.acquisitionState.appendAcquisition({
    schemaVersion: 1,
    at: new Date().toISOString(),
    kind: policy.switched ? "channel-switch" : "update",
    channel: candidate.channel,
    ...(policy.previousChannel === undefined ? {} : { previousChannel: policy.previousChannel }),
    version: candidate.version,
    target: candidate.target,
    sha256: candidate.sha256,
    artifactDigest: candidate.artifactDigest,
    metadataVersion: candidate.metadataVersion,
    verifiedAt: candidate.verifiedAt,
  });
  // INSTALL != ACTIVATE: stage the verified candidate only; activation is a
  // later explicit `rly update` (Wave 4 owns the serving active reference).
  const result = await (dependencies.runUpdate ?? runUpdate)({
    config: context.config,
    controlPlaneDirectory: context.controlPlaneDirectory,
    installer: context.installer,
    serviceManager: context.manager,
    serviceDefinition: bootstrapServiceDefinition(
      context.controlPlaneDirectory,
      context.installation.configPath,
      join(context.controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    ),
    candidate: { version: candidate.version, sourceDirectory: candidate.sourceDirectory },
    installOnly: true,
    drainTimeoutMs: options.waitTimeoutMs,
    updateStore: context.updateStore,
    cliRuntimeVersion: RUNTIME_VERSION,
    cliStateVersion: SCHEMA_V4_VERSION,
  });
  console.log(JSON.stringify({
    ok: result.outcome !== "failed",
    state: result.state,
    outcome: result.outcome,
    currentVersion: result.currentVersion,
    ...(result.pendingVersion === undefined ? {} : { pendingVersion: result.pendingVersion }),
    ...(result.phase === undefined ? {} : { phase: result.phase }),
    verifiedCandidate: {
      channel: candidate.channel,
      version: candidate.version,
      target: candidate.target,
      sha256: candidate.sha256,
      artifactDigest: candidate.artifactDigest,
      qualificationStatus: candidate.qualificationStatus,
      metadataVersion: candidate.metadataVersion,
    },
    ...(result.message === undefined ? {} : { message: result.message }),
  }));
  return result.outcome === "failed" ? 1 : 0;
}

/**
 * New-launch policy while an update is pending/activating (#73): a compatible
 * pair may keep launching on the old resident runtime; an incompatible pair
 * refuses NEW launches with an actionable message and never touches existing
 * sessions. Only enforced for resident handles (launcher-owned foreground
 * checkouts have no resident update lifecycle).
 */
export async function assertUpdateLaunchAllowed(
  lease: GatewayLeaseHandle,
  config: GatewayConfig,
): Promise<void> {
  if (lease.runtimeVersion === undefined) return;
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const store = new UpdateStateStore(controlPlaneDirectory);
  const update = await store.read().catch(() => undefined);
  if (update === undefined) return;
  const decision = launchPolicy(update, RUNTIME_VERSION, lease.runtimeVersion);
  if (decision.allowed) return;
  throw new Error(
    `update-pending: the resident runtime (${lease.runtimeVersion}) is not protocol-compatible with this RLY (${RUNTIME_VERSION}) while activation is pending. `
    + "New launches are refused until the update activates; existing sessions are unaffected. "
    + "Run `rly update` to complete activation.",
  );
}
