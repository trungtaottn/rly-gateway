#!/usr/bin/env node
import { constants as osConstants, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAdminArgs, runAdmin, type AdminCommand } from "./admin.js";
import { parseConfigArgs, runConfig, type ConfigCommand } from "./config.js";
import { runDoctor, runQuota, runRouteTrace, runStatus } from "./diagnostics.js";
import { runCost } from "./cost.js";
import { runCanaryCommand, type CanaryAction } from "./canary.js";
import { parseCompatArgs, runCompatCommand, type CompatAction } from "./compat.js";
import { runGatewayCommand, type GatewayAction } from "./gateway.js";
import { runInit } from "./init.js";
import { parseInstallArgs, runInstallCommand, type InstallCommandOptions } from "./install.js";
import { parseUninstallArgs, runUninstallCommand, type UninstallCommandOptions } from "./uninstall.js";
import { parseUpdateArgs, runUpdateCommand, assertUpdateLaunchAllowed } from "./update.js";
import { loadConfig } from "../config/load-config.js";
import { assertSecretFree } from "../control-plane/secret-free.js";
import { ProfileActivationError } from "../profiles/errors.js";
import { parseLaunchPolicy, type LaunchPolicy } from "../profiles/schema.js";
import { launchClaude, launchCodex, type ChildExit, type LaunchClaudeOptions } from "../runtime/child-launcher.js";
import {
  DEFAULT_CLAUDE_VIEW_ID,
  deriveClaudeViewId,
  prepareClaudeOverlay,
  type ClaudeOverlayResolution,
  type ExplicitClaudeSettings,
} from "../runtime/claude-overlay.js";
import { acquireGateway, type GatewayLeaseHandle } from "../runtime/gateway-lifecycle.js";
import { currentBuildIdentity } from "../runtime/build-identity.js";
import { detectClaudeTarget, detectCodexTarget } from "../targets/detect.js";
import { RLY_STATE_DIRECTORY_NAME } from "../storage/paths.js";

const DEFAULT_CONFIG = "gateway.config.toml";
const DIAGNOSTIC_COMMANDS = ["status", "doctor", "quota", "route-trace"] as const;
const ACTIVATION_CODES = [
  "profile-not-found",
  "profile-not-claude",
  "profile-has-no-pool",
  "role-unmapped",
  "capability-rejected",
  "invalid-launch-policy",
  "context_window_exceeded",
] as const satisfies readonly ProfileActivationError["code"][];
const ROUTE_ROLES = ["primary", "fast", "reasoning"] as const;

function usage(): void {
  console.log("Usage: rly <profile> [--config path] [--] [claude args] | rly <status|doctor|quota|route-trace|cost> [--config path] | rly --version | admin <providers|accounts|pools|profiles|credentials|ui|models> ... [--config path] | run <claude|codex> [--config path] [--profile name | --route provider/model] -- [harness args] | rly init [--config path] | rly install [--channel beta|stable|current] [--origin url] [--target t] [--version v] [--artifact tarball --metadata-dir dir] [--config path] | rly uninstall [--purge --yes] [--config path] | rly gateway <start|stop|status> [--config path] | rly config [status|ui|providers|accounts|pools|profiles ...] [--config path] [--headless] | rly canary <run|status|run-b|run-c> [--config path] | rly compat <status|review promote|reject|quarantine|lift|explain> [--config path] | rly update [--candidate dir] [--version v] [--channel beta|stable|current] [--origin url] [--target t] [--install-only] [--force] [--wait-timeout ms] [--config path]");
}

export type ParsedCliCommand =
  | Readonly<{ command: "version" }>
  | Readonly<{ command: "status" | "doctor" | "quota" | "route-trace"; configPath: string }>
  | Readonly<{ command: "cost"; configPath: string; costArgs: readonly string[] }>
  | Readonly<{ command: "run-claude" | "run-codex"; configPath: string; claudeArgs: readonly string[]; route?: string; profile?: string }>
  | Readonly<{ command: "init"; configPath: string }>
  | Readonly<{ command: "install"; options: InstallCommandOptions }>
  | Readonly<{ command: "uninstall"; options: UninstallCommandOptions }>
  | Readonly<{ command: "gateway"; action: GatewayAction; configPath: string }>
  | Readonly<{ command: "canary"; action: CanaryAction; configPath: string }>
  | Readonly<{ command: "compat"; action: CompatAction; configPath: string }>
  | Readonly<{ command: "update"; options: ReturnType<typeof parseUpdateArgs> }>
  | AdminCommand
  | ConfigCommand;

function isDiagnosticCommand(value: string | undefined): value is "status" | "doctor" | "quota" | "route-trace" {
  return value !== undefined && (DIAGNOSTIC_COMMANDS as readonly string[]).includes(value);
}

function configPath(args: readonly string[], cwd: string): string {
  const index = args.indexOf("--config");
  const configuredPath = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && configuredPath === undefined) throw new Error("--config requires a path");
  return resolve(cwd, configuredPath ?? DEFAULT_CONFIG);
}

function optionalFlag(options: readonly string[], flag: string, missing: string): string | undefined {
  const index = options.indexOf(flag);
  if (index < 0) return undefined;
  const value = options[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(missing);
  if (options.filter((item) => item === flag).length !== 1) throw new Error(`${flag} may be provided once`);
  return value;
}

function isActivationCode(value: unknown): value is ProfileActivationError["code"] {
  return typeof value === "string" && (ACTIVATION_CODES as readonly string[]).includes(value);
}

function throwActivationFailure(payload: unknown): never {
  const code = payload !== null && typeof payload === "object" && "error" in payload
    ? (payload as { error?: unknown }).error
    : undefined;
  if (isActivationCode(code)) {
    throw new ProfileActivationError(code, code === "profile-not-found" ? "Unknown profile" : "Profile cannot be activated");
  }
  throw new Error("Profile activation failed");
}

function assertBareProfileOptions(options: readonly string[]): void {
  let index = 0;
  while (index < options.length) {
    const token = options[index];
    if (token === undefined) throw new Error("bare profile requires `--` before Claude arguments");
    if (token === "--profile") throw new Error("--profile cannot be combined with a bare profile name");
    if (token === "--route") throw new Error("--profile cannot be combined with --route");
    if (token === "--config") {
      const value = options[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--config requires a path");
      index += 2;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`unknown option ${token}`);
    throw new Error("bare profile requires `--` before Claude arguments");
  }
  if (options.filter((item) => item === "--config").length > 1) throw new Error("--config may be provided once");
}

function parseRunCommand(args: readonly string[], cwd: string): ParsedCliCommand | undefined {
  const harness = args[1];
  if (harness !== "claude" && harness !== "codex") return undefined;
  const separator = args.indexOf("--", 2);
  if (separator < 0) throw new Error(`run ${harness} requires \`--\` before ${harness} arguments`);
  const options = args.slice(2, separator);
  const route = optionalFlag(options, "--route", "--route requires an exact provider/model value");
  const profile = optionalFlag(options, "--profile", "--profile requires a profile name");
  if (route !== undefined && profile !== undefined) throw new Error("--profile cannot be combined with --route");
  return {
    command: harness === "codex" ? "run-codex" : "run-claude",
    configPath: configPath(options, cwd),
    claudeArgs: args.slice(separator + 1),
    ...(route === undefined ? {} : { route }),
    ...(profile === undefined ? {} : { profile }),
  };
}

function parseBareProfileCommand(profile: string, args: readonly string[], cwd: string): ParsedCliCommand {
  const separator = args.indexOf("--", 1);
  const options = separator < 0 ? args.slice(1) : args.slice(1, separator);
  assertBareProfileOptions(options);
  return {
    command: "run-claude",
    configPath: configPath(options, cwd),
    claudeArgs: separator < 0 ? [] : args.slice(separator + 1),
    profile,
  };
}

/** Parses gateway arguments and leaves all arguments after `--` untouched for Claude. */
export function parseCliArgs(args: readonly string[], cwd = process.cwd()): ParsedCliCommand | undefined {
  const [command] = args;
  if (command === "version" || command === "--version") {
    if (args.length > 1) throw new Error("version accepts no arguments");
    return { command: "version" };
  }
  if (isDiagnosticCommand(command)) {
    return { command, configPath: configPath(args.slice(1), cwd) };
  }
  if (command === "cost") {
    const rest = args.slice(1);
    return { command: "cost", configPath: configPath(rest, cwd), costArgs: rest.filter((value, index, all) => value !== "--config" && all[index - 1] !== "--config") };
  }
  if (command === "admin") {
    return parseAdminArgs(args.filter((value, index, all) => value !== "--config" && all[index - 1] !== "--config"), configPath(args, cwd));
  }
  if (command === "config") return parseConfigArgs(args, cwd);
  if (command === "run") return parseRunCommand(args, cwd);
  if (command === "init") {
    const rest = args.slice(1);
    if (rest.length > 0 && rest[0] !== "--config") throw new Error("init accepts only --config");
    return { command: "init", configPath: configPath(rest, cwd) };
  }
  if (command === "install") {
    return { command: "install", options: parseInstallArgs(args.slice(1), cwd) };
  }
  if (command === "uninstall") {
    return { command: "uninstall", options: parseUninstallArgs(args.slice(1), cwd) };
  }
  if (command === "gateway") {
    const rest = args.slice(1);
    const action = rest[0];
    if (action !== "start" && action !== "stop" && action !== "status") {
      throw new Error("gateway requires start, stop, or status");
    }
    const options = rest.slice(1);
    if (options.length > 0 && options[0] !== "--config") throw new Error(`unknown option ${String(options[0])}`);
    return { command: "gateway", action, configPath: configPath(options, cwd) };
  }
  if (command === "canary") {
    const rest = args.slice(1);
    const action = rest[0];
    if (action !== "run" && action !== "status" && action !== "run-b" && action !== "run-c") {
      throw new Error("canary requires run, status, run-b (installed-client black-box), or run-c (live access path)");
    }
    const options = rest.slice(1);
    if (options.length > 0 && options[0] !== "--config") throw new Error(`unknown option ${String(options[0])}`);
    return { command: "canary", action, configPath: configPath(options, cwd) };
  }
  if (command === "compat") {
    const rest = args.slice(1);
    const action = parseCompatArgs(rest);
    return { command: "compat", action, configPath: configPath(rest, cwd) };
  }
  if (command === "update") {
    return { command: "update", options: parseUpdateArgs(args.slice(1), cwd) };
  }
  if (command === undefined || command.startsWith("-")) return undefined;
  return parseBareProfileCommand(command, args, cwd);
}

function configuredRoleForRoute(config: Awaited<ReturnType<typeof loadConfig>>, route: string): "primary" | "fast" | "reasoning" {
  for (const role of ROUTE_ROLES) {
    const candidate = config.routes[role];
    if (candidate !== undefined && `${candidate.provider}/${candidate.model}` === route) return role;
  }
  throw new Error("Requested route is not configured");
}

function routeScopedClaudeArgs(args: readonly string[], role: "primary" | "fast" | "reasoning"): readonly string[] {
  if (args.includes("--model")) throw new Error("--model cannot be combined with gateway --route");
  return ["--model", role, ...args];
}

function detectForHarness(harness: "claude" | "codex"): typeof detectClaudeTarget {
  return harness === "codex" ? detectCodexTarget : detectClaudeTarget;
}

function printPlannedLaunchReceipt(planned: unknown): void {
  if (planned === null || typeof planned !== "object") return;
  try {
    assertSecretFree(planned);
  } catch {
    return;
  }
  console.log(JSON.stringify({ planned }));
}

async function issueProfileLaunch(
  lease: GatewayLeaseHandle,
  profileName: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  harness: "claude" | "codex" = "claude",
): Promise<ProfileLaunchResolution> {
  const detect = detectForHarness(harness);
  const target = detect(environment);
  const response = await fetch(`${lease.baseUrl}/v1/launch-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lease.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ profileName, leaseId: lease.leaseId }),
  });
  const payload = await response.json() as {
    token?: unknown;
    harness?: unknown;
    profileId?: unknown;
    launchPolicy?: unknown;
    planned?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof payload.token !== "string") {
    throwActivationFailure(payload);
  }
  if (typeof payload.harness === "string" && payload.harness !== harness) {
    throw new Error(`Profile harness is ${payload.harness}, not ${harness}`);
  }
  if (typeof payload.profileId !== "string" || payload.profileId === "") {
    throw new Error("Profile launch did not resolve a profile identity");
  }
  printPlannedLaunchReceipt(payload.planned);
  let policy: LaunchPolicy;
  try {
    policy = parseLaunchPolicy(payload.launchPolicy);
  } catch {
    throw new ProfileActivationError("invalid-launch-policy", "Profile launch policy is invalid");
  }
  const configured = policy.executable;
  const resolved = detect(
    environment,
    typeof configured === "string" ? { executable: configured } : {},
  );
  const explicit: ExplicitClaudeSettings | undefined =
    policy.model === undefined && policy.env === undefined
      ? undefined
      : { ...(policy.model === undefined ? {} : { model: policy.model }), ...(policy.env === undefined ? {} : { env: policy.env }) };
  return {
    token: payload.token,
    args,
    executable: resolved.found ? resolved.executable : target.executable,
    profileId: payload.profileId,
    explicit,
  };
}

export function childExitCode(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  if (exit.signal !== null) return 128 + osConstants.signals[exit.signal];
  return 1;
}

export type ProfileLaunchResolution = Readonly<{
  token: string;
  args: readonly string[];
  executable: string | undefined;
  /** Immutable control-plane profile id used to derive the profile-scoped Claude view (#126). */
  profileId: string;
  /** Explicit RLY/profile settings tier (launch policy model/env). */
  explicit: ExplicitClaudeSettings | undefined;
}>;

export type CliDependencies = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  launchClaude?: (options: LaunchClaudeOptions) => Promise<ChildExit>;
  launchCodex?: (options: LaunchClaudeOptions) => Promise<ChildExit>;
  acquireGateway?: (options: Parameters<typeof acquireGateway>[0]) => Promise<GatewayLeaseHandle>;
  issueProfileLaunch?: (
    lease: GatewayLeaseHandle,
    profileName: string,
    args: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    harness?: "claude" | "codex",
  ) => Promise<ProfileLaunchResolution>;
  prepareClaudeOverlay?: (controlPlaneDirectory: string, options?: { environment?: Readonly<NodeJS.ProcessEnv>; viewId?: string; explicit?: ExplicitClaudeSettings }) => Promise<ClaudeOverlayResolution>;
  runInit?: (configPath: string) => Promise<number>;
  runGateway?: (action: GatewayAction, configPath: string) => Promise<number>;
}>;

async function runHarnessCommand(
  parsed: Extract<ParsedCliCommand, { command: "run-claude" | "run-codex" }>,
  dependencies: CliDependencies,
): Promise<number> {
  const config = await loadConfig(parsed.configPath);
  const harness = parsed.command === "run-codex" ? "codex" : "claude";
  const claudeArgs = parsed.route === undefined
    ? parsed.claudeArgs
    : harness === "claude"
      ? routeScopedClaudeArgs(parsed.claudeArgs, configuredRoleForRoute(config, parsed.route))
      : (configuredRoleForRoute(config, parsed.route), parsed.claudeArgs);
  // Claude launches point CLAUDE_CONFIG_DIR at the durable profile-scoped RLY
  // view (composed from native user config) instead of a throwaway temp
  // directory. Codex keeps its historical throwaway CODEX_HOME isolation. The
  // default RLY home resolves from the launch environment so tests and other
  // callers with an overridden HOME never touch the real user home.
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? join(dependencies.environment["HOME"] ?? homedir(), RLY_STATE_DIRECTORY_NAME);
  const lease = await (dependencies.acquireGateway ?? acquireGateway)({ config });
  try {
    // #73: while an update is pending/activating on a resident runtime, new
    // launches follow the documented compatibility policy — a compatible pair
    // may continue on the old runtime; an incompatible pair refuses only NEW
    // launches with an actionable error (existing sessions are never touched).
    if (parsed.profile !== undefined) {
      await assertUpdateLaunchAllowed(lease, config);
    }
    let launched: ProfileLaunchResolution | Readonly<{ token: string; args: readonly string[]; executable: string | undefined }>;
    if (parsed.profile !== undefined) {
      launched = await (dependencies.issueProfileLaunch ?? issueProfileLaunch)(lease, parsed.profile, claudeArgs, dependencies.environment, harness);
    } else {
      launched = { token: lease.authToken, args: claudeArgs, executable: undefined };
    }
    // #126: the Claude view identity is deterministic per profile (immutable
    // profile id) or the reserved `default` view for profile-less launches;
    // explicit launch-policy model/env form the explicit settings tier.
    let configDirectory: string | undefined;
    let environmentOverrides: Readonly<Record<string, string>> | undefined;
    if (harness === "claude") {
      const viewId = "profileId" in launched
        ? deriveClaudeViewId(launched.profileId)
        : DEFAULT_CLAUDE_VIEW_ID;
      const explicit = "explicit" in launched ? launched.explicit : undefined;
      const resolution = await (dependencies.prepareClaudeOverlay ?? prepareClaudeOverlay)(
        controlPlaneDirectory,
        { environment: dependencies.environment, viewId, ...(explicit === undefined ? {} : { explicit }) },
      );
      configDirectory = resolution.directory;
      environmentOverrides = explicit?.env;
    }
    const launch = harness === "codex" ? (dependencies.launchCodex ?? launchCodex) : (dependencies.launchClaude ?? launchClaude);
    const exit = await launch({
      gatewayBaseUrl: lease.baseUrl,
      authToken: launched.token,
      args: launched.args,
      environment: dependencies.environment,
      ...(launched.executable === undefined ? {} : { executable: launched.executable }),
      ...(configDirectory === undefined ? {} : { configDirectory }),
      ...(environmentOverrides === undefined ? {} : { environmentOverrides }),
    });
    return childExitCode(exit);
  } finally {
    await lease.release();
  }
}

/**
 * `rly --version`: prints the exact CLI build identity (#94) — the same
 * versioned fields `/identity`, doctor/status, the release manifest, and
 * update probation compare. Secret-free build metadata only.
 */
async function runVersion(): Promise<number> {
  const identity = await currentBuildIdentity();
  console.log(JSON.stringify({
    product: identity.product,
    version: identity.semanticVersion,
    commitRevision: identity.commitRevision,
    buildId: identity.buildId,
    releaseChannel: identity.releaseChannel,
    controlProtocolVersion: identity.controlProtocolVersion,
    dataProtocolVersion: identity.dataProtocolVersion,
    stateSchemaVersion: identity.stateSchemaVersion,
    identitySchemaVersion: identity.identitySchemaVersion,
  }));
  return 0;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = { environment: process["env"] },
): Promise<number> {
  const parsed = parseCliArgs(args);
  if (parsed === undefined) {
    usage();
    return 2;
  }
  if (parsed.command === "run-claude" || parsed.command === "run-codex") return runHarnessCommand(parsed, dependencies);
  if (parsed.command === "version") return runVersion();
  if (parsed.command === "canary") return runCanaryCommand(parsed.action, parsed.configPath);
  if (parsed.command === "compat") return runCompatCommand(parsed.action, parsed.configPath);
  if (parsed.command === "update") return runUpdateCommand(parsed.options);
  if (parsed.command === "init") return (dependencies.runInit ?? runInit)(parsed.configPath);
  if (parsed.command === "install") return runInstallCommand(parsed.options);
  if (parsed.command === "uninstall") return runUninstallCommand(parsed.options);
  if (parsed.command === "gateway") return (dependencies.runGateway ?? runGatewayCommand)(parsed.action, parsed.configPath);
  if (parsed.command === "admin") return runAdmin(parsed, await loadConfig(parsed.configPath));
  if (parsed.command === "config") return runConfig(parsed);
  if (parsed.command === "doctor") return runDoctor(parsed.configPath);
  if (parsed.command === "status") return runStatus(parsed.configPath);
  if (parsed.command === "quota") return runQuota(parsed.configPath);
  if (parsed.command === "cost") return runCost(parsed.configPath, parsed.costArgs);
  return runRouteTrace(parsed.configPath);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const code = await runCli(args);
  process.exitCode = code;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  });
}
