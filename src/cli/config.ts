import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayConfig } from "../config/schema.js";
import { resolveUserConfig, type ResolvedUserConfig } from "../config/user-config.js";
import {
  inspectRuntimeGateway,
  type AcquireGatewayOptions,
  type RuntimeInspection,
} from "../runtime/gateway-lifecycle.js";
import { startResidentRuntime, type ResidentRuntimeHandle } from "../runtime/resident-runtime.js";
import { createServiceManager } from "../service-manager/index.js";
import type { ServiceManagerAdapter } from "../service-manager/types.js";
import { readInstallation } from "../storage/installation.js";
import { RLY_STATE_DIRECTORY_NAME } from "../storage/paths.js";
import {
  issueBootstrapUrl,
  managementBaseUrl,
  managementRequest,
  parseFields,
  printManagementResult,
  readManagementToken,
} from "./management-client.js";

export type ConfigFocus =
  | Readonly<{ kind: "control-center" }>
  | Readonly<{ kind: "status" }>
  | Readonly<{ kind: "providers"; action: "list" | "create"; fields: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "accounts"; action: "list" | "create" | "login" | "import" | "revoke" | "refresh" | "pause" | "resume"; fields: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "pools"; action: "list" | "create"; fields: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "profiles"; action: "list" | "create"; fields: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "keys"; action: "list" | "create" | "revoke"; fields: Readonly<Record<string, string>> }>;

export type ConfigCommand = Readonly<{
  command: "config";
  configPath: string | undefined;
  headless: boolean;
  focus: ConfigFocus;
}>;

const CONFIG_RESOURCES = ["providers", "accounts", "pools", "profiles", "keys"] as const;
const ACCOUNT_ACTIONS = ["list", "create", "login", "import", "revoke", "refresh", "pause", "resume"] as const;
const RESOURCE_ACTIONS = ["list", "create"] as const;
const KEYS_ACTIONS = ["list", "create", "revoke"] as const;

export function parseConfigArgs(args: readonly string[], cwd: string): ConfigCommand | undefined {
  if (args[0] !== "config") return undefined;
  const rest = args.slice(1);
  const configIndex = rest.indexOf("--config");
  let configPath: string | undefined;
  if (configIndex >= 0) {
    const value = rest[configIndex + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--config requires a path");
    configPath = resolve(cwd, value);
  }
  const headless = rest.includes("--headless");
  const tokens = rest.filter((value, index, all) =>
    value !== "--config" && value !== "--headless" && all[index - 1] !== "--config"
  );
  const [domain, action, ...fieldTokens] = tokens;
  if (domain === undefined || domain === "ui") {
    if (tokens.length > 1) throw new Error("config ui accepts no arguments");
    return { command: "config", configPath, headless, focus: { kind: "control-center" } };
  }
  if (domain === "status") {
    if (tokens.length > 1) throw new Error("config status accepts no arguments");
    return { command: "config", configPath, headless, focus: { kind: "status" } };
  }
  if (!(CONFIG_RESOURCES as readonly string[]).includes(domain)) {
    throw new Error("config requires status, ui, providers, accounts, pools, profiles, or keys");
  }
  const resource = domain as "providers" | "accounts" | "pools" | "profiles" | "keys";
  const allowed: readonly string[] = resource === "accounts" ? ACCOUNT_ACTIONS : resource === "keys" ? KEYS_ACTIONS : RESOURCE_ACTIONS;
  const selected = action === undefined ? "list" : action;
  if (!allowed.includes(selected)) {
    throw new Error(`config ${resource} action is not valid for ${resource}`);
  }
  const fields = parseFields(fieldTokens);
  if (resource === "accounts") {
    return {
      command: "config",
      configPath,
      headless,
      focus: { kind: "accounts", action: selected as (typeof ACCOUNT_ACTIONS)[number], fields },
    };
  }
  if (resource === "providers") {
    return {
      command: "config",
      configPath,
      headless,
      focus: { kind: "providers", action: selected as "list" | "create", fields },
    };
  }
  if (resource === "pools") {
    return {
      command: "config",
      configPath,
      headless,
      focus: { kind: "pools", action: selected as "list" | "create", fields },
    };
  }
  if (resource === "keys") {
    return {
      command: "config",
      configPath,
      headless,
      focus: { kind: "keys", action: selected as "list" | "create" | "revoke", fields },
    };
  }
  return {
    command: "config",
    configPath,
    headless,
    focus: { kind: "profiles", action: selected as "list" | "create", fields },
  };
}

export type ConfigDependencies = Readonly<{
  home?: string;
  cwd?: string;
  resolveUserConfig?: (options: Readonly<{ home: string; cwd: string; explicit?: string }>) => Promise<ResolvedUserConfig>;
  inspectRuntime?: (config: GatewayConfig, directory?: string) => Promise<RuntimeInspection>;
  readInstallation?: typeof readInstallation;
  createServiceManager?: (input: Parameters<typeof createServiceManager>[0]) => ServiceManagerAdapter;
  waitForResident?: (config: GatewayConfig, timeoutMs?: number) => Promise<RuntimeInspection>;
  startResidentRuntime?: (options: AcquireGatewayOptions) => Promise<ResidentRuntimeHandle>;
  readManagementToken?: typeof readManagementToken;
  managementRequest?: typeof managementRequest;
  openBrowser?: (url: string) => Promise<void> | void;
}>;

type EnsuredRuntime = Readonly<{
  inspection: RuntimeInspection;
  /** Session-scoped fallback runtime started by this CLI process (dev path). */
  foreground?: ResidentRuntimeHandle;
}>;

const READINESS_POLL_MS = 250;
const READINESS_TIMEOUT_MS = 15_000;
const FOREGROUND_SHUTDOWN_TIMEOUT_MS = 5_000;

async function defaultWaitForResident(config: GatewayConfig, timeoutMs = READINESS_TIMEOUT_MS): Promise<RuntimeInspection> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await inspectRuntimeGateway(config);
    if (state.state === "attested-compatible") return state;
    if (state.state === "occupied-foreign" || state.state === "attested-incompatible") return state;
    if (Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
  }
}

/**
 * Ensures a usable attested management runtime before any control-plane
 * operation. The resident service is recovered when it is installed but not
 * running; a launcher-owned instance is reused as-is; the foreground fallback
 * starts a session-scoped runtime for uninitialized/dev checkouts. Foreign or
 * incompatible listeners always fail closed and are never signaled.
 */
async function ensureManagementRuntime(
  config: GatewayConfig,
  home: string,
  dependencies: ConfigDependencies,
): Promise<EnsuredRuntime> {
  const inspect = dependencies.inspectRuntime ?? inspectRuntimeGateway;
  let state = await inspect(config);
  if (state.state === "occupied-foreign") {
    throw new Error("Configured gateway or management port is occupied by a foreign listener; refusing to manage it");
  }
  if (state.state === "attested-incompatible") {
    throw new Error("Configured listener is attested but incompatible; re-run `rly init` to align the configuration before running `rly config`");
  }
  if (state.state === "attested-compatible") return { inspection: state };

  const installation = await (dependencies.readInstallation ?? readInstallation)(join(home, RLY_STATE_DIRECTORY_NAME));
  if (installation !== undefined) {
    const manager = (dependencies.createServiceManager ?? createServiceManager)({ home });
    if (manager.isSupported()) {
      await manager.start();
      state = await (dependencies.waitForResident ?? defaultWaitForResident)(config);
      if (state.state === "attested-compatible") return { inspection: state };
      if (state.state === "occupied-foreign" || state.state === "attested-incompatible") {
        throw new Error(`Resident runtime did not become ready (${state.state}); inspect \`rly gateway status\` and the service log`);
      }
    }
  }

  const handle = await (dependencies.startResidentRuntime ?? startResidentRuntime)({ config });
  const inspection: RuntimeInspection = {
    state: "attested-compatible",
    resident: true,
    runtimeVersion: handle.runtimeVersion,
    instanceId: handle.instanceId,
  };
  return handle.alreadyRunning ? { inspection } : { inspection, foreground: handle };
}

export async function runConfig(command: ConfigCommand, dependencies: ConfigDependencies = {}): Promise<number> {
  const home = dependencies.home ?? homedir();
  const cwd = dependencies.cwd ?? process.cwd();
  const resolved = await (dependencies.resolveUserConfig ?? resolveUserConfig)({
    home,
    cwd,
    ...(command.configPath === undefined ? {} : { explicit: command.configPath }),
  });
  const config = resolved.config;
  const ensured = await ensureManagementRuntime(config, home, dependencies);
  // Interactive control-center keeps a session-scoped runtime alive; one-shot
  // status/focused paths and the token-missing early exit must always release it.
  let retainForeground = false;
  try {
    const token = await (dependencies.readManagementToken ?? readManagementToken)(config);
    if (!token) {
      console.log(JSON.stringify({ ok: false, error: "management is not running" }));
      return 1;
    }
    const baseUrl = managementBaseUrl(config);
    const origin = baseUrl;
    if (command.focus.kind === "status") {
      return await runStatusSummary(resolved, ensured, token, baseUrl, origin, dependencies);
    }
    if (command.focus.kind === "control-center") {
      const code = await runControlCenter(resolved, ensured, token, baseUrl, origin, command.headless, dependencies);
      retainForeground = true;
      return code;
    }
    return await runFocused(command.focus, token, baseUrl, origin, dependencies);
  } finally {
    if (!retainForeground && ensured.foreground !== undefined) {
      await shutdownForegroundBounded(ensured.foreground);
    }
  }
}

async function shutdownForegroundBounded(
  foreground: ResidentRuntimeHandle,
  timeoutMs = FOREGROUND_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      foreground.shutdown(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("session-scoped foreground runtime did not shut down within the bounded window"));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runtimeSummary(ensured: EnsuredRuntime): Readonly<Record<string, unknown>> {
  const inspection = ensured.inspection;
  if (inspection.state !== "attested-compatible") return { state: inspection.state };
  return {
    state: inspection.state,
    resident: inspection.resident,
    ...(inspection.runtimeVersion === undefined ? {} : { runtimeVersion: inspection.runtimeVersion }),
    instanceId: inspection.instanceId,
  };
}

function configSummary(resolved: ResolvedUserConfig): Readonly<Record<string, unknown>> {
  return {
    source: resolved.source,
    ...(resolved.configPath === undefined ? {} : { configPath: resolved.configPath }),
    initialized: resolved.initialized,
  };
}

async function runStatusSummary(
  resolved: ResolvedUserConfig,
  ensured: EnsuredRuntime,
  token: string,
  baseUrl: string,
  origin: string,
  dependencies: ConfigDependencies,
): Promise<number> {
  const request = dependencies.managementRequest ?? managementRequest;
  const policy = await request(baseUrl, token, origin, "GET", "/v1/policy");
  const health = await request(baseUrl, token, origin, "GET", "/v1/health");
  const policyBody = policy.body as
    | { revision?: number; providers?: readonly unknown[]; accounts?: readonly unknown[]; pools?: readonly unknown[]; profiles?: readonly unknown[] }
    | undefined;
  const healthBody = health.body as { items?: readonly unknown[] } | undefined;
  console.log(JSON.stringify({
    ok: true,
    runtime: runtimeSummary(ensured),
    config: configSummary(resolved),
    policy: {
      revision: policyBody?.revision ?? 0,
      providers: policyBody?.providers?.length ?? 0,
      accounts: policyBody?.accounts?.length ?? 0,
      pools: policyBody?.pools?.length ?? 0,
      profiles: policyBody?.profiles?.length ?? 0,
    },
    health: { accounts: healthBody?.items?.length ?? 0 },
    management: { url: baseUrl },
    ...(ensured.foreground === undefined ? {} : { foreground: { sessionScoped: true } }),
  }));
  return 0;
}

async function runControlCenter(
  resolved: ResolvedUserConfig,
  ensured: EnsuredRuntime,
  token: string,
  baseUrl: string,
  origin: string,
  headless: boolean,
  dependencies: ConfigDependencies,
): Promise<number> {
  console.log(JSON.stringify({
    ok: true,
    runtime: runtimeSummary(ensured),
    config: configSummary(resolved),
    management: { url: baseUrl },
    message: headless
      ? "config UI URL"
      : "opening the local config UI; the RLY runtime keeps running after it closes",
  }));
  const url = await issueBootstrapUrl(baseUrl, token, origin, dependencies.managementRequest);
  if (!url) {
    console.log(JSON.stringify({ ok: false, error: "bootstrap failed" }));
    return 1;
  }
  if (!headless) {
    const open = dependencies.openBrowser ?? openBrowser;
    await open(url);
  }
  console.log(JSON.stringify({ ok: true, ui: { url }, headless }));

  if (ensured.foreground !== undefined && !headless) {
    // The fallback runtime lives inside this process; keep it alive for the
    // session and shut it down boundedly on interrupt. The installed path
    // never reaches here because the resident service owns the runtime.
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void ensured.foreground?.shutdown().finally(() => { process.exitCode = 0; });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await ensured.foreground.stopped;
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  return 0;
}

async function runFocused(
  focus: Extract<ConfigFocus, { kind: "providers" | "accounts" | "pools" | "profiles" | "keys" }>,
  token: string,
  baseUrl: string,
  origin: string,
  dependencies: ConfigDependencies,
): Promise<number> {
  const request = dependencies.managementRequest ?? managementRequest;
  const fields = focus.fields;
  if (focus.kind === "providers") {
    if (focus.action === "create") {
      return requestOk(request, baseUrl, token, origin, "POST", "/v1/providers", providerCreateBody(fields));
    }
    return requestOk(request, baseUrl, token, origin, "GET", "/v1/providers");
  }
  if (focus.kind === "pools") {
    if (focus.action === "create") {
      return requestOk(request, baseUrl, token, origin, "POST", "/v1/pools", poolCreateBody(fields));
    }
    return requestOk(request, baseUrl, token, origin, "GET", "/v1/pools");
  }
  if (focus.kind === "profiles") {
    if (focus.action === "create") {
      return requestOk(request, baseUrl, token, origin, "POST", "/v1/profiles", profileCreateBody(fields));
    }
    return requestOk(request, baseUrl, token, origin, "GET", "/v1/profiles");
  }
  if (focus.kind === "keys") {
    if (focus.action === "create") {
      return requestOk(request, baseUrl, token, origin, "POST", "/v1/keys", fields);
    }
    if (focus.action === "list") {
      return requestOk(request, baseUrl, token, origin, "GET", "/v1/keys");
    }
    const keyId = fields["id"];
    if (keyId === undefined) throw new Error("keys revoke requires --id");
    return requestOk(request, baseUrl, token, origin, "POST", `/v1/keys/${keyId}/revoke`);
  }
  if (focus.action === "list") {
    return requestOk(request, baseUrl, token, origin, "GET", "/v1/accounts");
  }
  if (focus.action === "create") {
    return requestOk(request, baseUrl, token, origin, "POST", "/v1/accounts", accountCreateBody(fields));
  }
  if (focus.action === "login") {
    const started = await request(baseUrl, token, origin, "POST", "/v1/credentials/login", accountLoginBody(fields));
    if (!started.ok) return 1;
    return requestOk(request, baseUrl, token, origin, "POST", "/v1/credentials/login/complete", {});
  }
  if (focus.action === "import") {
    return requestOk(request, baseUrl, token, origin, "POST", "/v1/credentials/import", accountImportBody(fields));
  }
  const id = fields["id"];
  const version = fields["version"];
  if (id === undefined || version === undefined) throw new Error(`${focus.action} requires --id and --version`);
  if (focus.action === "revoke") {
    return requestOk(request, baseUrl, token, origin, "POST", `/v1/accounts/${id}/revoke`, { version: Number(version) });
  }
  if (focus.action === "refresh") {
    return requestOk(request, baseUrl, token, origin, "POST", `/v1/accounts/${id}/refresh`, { version: Number(version) });
  }
  const state = focus.action === "pause" ? "paused" : "ready";
  return requestOk(request, baseUrl, token, origin, "PATCH", `/v1/accounts/${id}`, { state, version: Number(version) });
}

async function requestOk(
  request: typeof managementRequest,
  baseUrl: string,
  token: string,
  origin: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<number> {
  const result = await request(baseUrl, token, origin, method, path, body);
  printManagementResult(result);
  return result.ok ? 0 : 1;
}

function copyField(body: Record<string, unknown>, fields: Readonly<Record<string, string>>, from: string, to = from): void {
  const value = fields[from];
  if (value !== undefined) body[to] = value;
}

function providerCreateBody(fields: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  copyField(body, fields, "name");
  copyField(body, fields, "mode", "integrationMode");
  copyField(body, fields, "endpoint", "endpointPolicy");
  if (body["name"] === undefined || body["integrationMode"] === undefined) {
    throw new Error("providers create requires --name and --mode (direct|oauth|bridge)");
  }
  return body;
}

function poolCreateBody(fields: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  copyField(body, fields, "name");
  copyField(body, fields, "provider-id", "providerId");
  copyField(body, fields, "strategy");
  if (fields["accounts"] !== undefined) {
    body["accountIds"] = fields["accounts"].split(",").filter(Boolean);
  }
  if (body["name"] === undefined || body["providerId"] === undefined || body["strategy"] === undefined) {
    throw new Error("pools create requires --name, --provider-id, and --strategy (manual|round-robin|fill-first|adaptive)");
  }
  return body;
}

function profileCreateBody(fields: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  copyField(body, fields, "name");
  copyField(body, fields, "harness");
  copyField(body, fields, "provider-id", "providerId");
  copyField(body, fields, "pool-id", "poolId");
  if (fields["roles"] !== undefined) body["modelRoles"] = JSON.parse(fields["roles"]) as unknown;
  if (body["name"] === undefined || body["harness"] === undefined) {
    throw new Error("profiles create requires --name, --harness (claude|codex), and --roles <json>");
  }
  return body;
}

function accountCreateBody(fields: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const providerId = fields["provider-id"];
  const pseudonym = fields["pseudonym"];
  const environmentName = fields["credential-env"];
  if (providerId === undefined || pseudonym === undefined || environmentName === undefined) {
    throw new Error("accounts create requires --provider-id, --pseudonym, and --credential-env");
  }
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(environmentName)) {
    throw new Error("--credential-env must be an environment variable name");
  }
  return { providerId, pseudonym, credentialRef: `env:${environmentName}` };
}

function accountLoginBody(fields: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  copyField(body, fields, "provider-id", "providerId");
  copyField(body, fields, "pseudonym");
  if (body["providerId"] === undefined || body["pseudonym"] === undefined) {
    throw new Error("accounts login requires --provider-id and --pseudonym");
  }
  return body;
}

function accountImportBody(fields: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  copyField(body, fields, "provider-id", "providerId");
  copyField(body, fields, "pseudonym");
  copyField(body, fields, "source", "sourcePath");
  copyField(body, fields, "source-fingerprint", "sourceFingerprint");
  if (body["providerId"] === undefined || body["pseudonym"] === undefined || body["sourcePath"] === undefined || body["sourceFingerprint"] === undefined) {
    throw new Error("accounts import requires --provider-id, --pseudonym, --source, and --source-fingerprint");
  }
  return body;
}

function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.unref();
  return Promise.resolve();
}
