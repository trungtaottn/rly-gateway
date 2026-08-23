import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { RLY_MODEL_PREFIX } from "../routing/model-projection/types.js";

export { RLY_MODEL_PREFIX } from "../routing/model-projection/types.js";

/**
 * RLY profile-scoped Claude configuration views (#126), evolving the safe
 * overlay from #74.
 *
 * Claude Code's `CLAUDE_CONFIG_DIR` owns settings, agents, skills, commands,
 * plugins, and session/history state for the supported client baseline (pinned
 * through #24; supported baseline `claude-code-2.1.229`, observed `2.1.233`
 * is not promoted). The historical
 * launcher pointed that variable at a fresh throwaway temp directory so RLY
 * never touched the user's real `~/.claude` — but it also threw away the
 * user's settings/agents/plugins and every RLY session/history on exit.
 *
 * #74 replaced the throwaway directory with one durable RLY-owned overlay
 * (`<control-plane>/claude`). #126 makes the namespace profile-scoped:
 *
 * ```
 * <control-plane>/claude/views/<view-id>/
 *   settings.json          composed one-way from native input + RLY-owned state
 *   agents/ commands/ skills/ plugins/config.json   one-way imports
 *   history/ projects/ ... Claude's own durable state (view-owned)
 *   .rly-overlay.json      allowlist marker (metadata)
 *   .rly-manifest.json     ownership manifest (metadata + hashes only)
 * ```
 *
 * A deterministic view identity (`deriveClaudeViewId(profileId)`) gives each
 * RLY profile its own durable namespace so RLY-only model/default/cache/
 * history state cannot silently bleed between profiles. Profile-less launches
 * (raw `--route` or standalone API) use the reserved `default` view. Plain
 * non-RLY `claude` reads native `~/.claude` only and is never affected.
 *
 * Ownership is asymmetric and typed:
 * - Native Claude config root (parent `CLAUDE_CONFIG_DIR` or `~/.claude`) is
 *   read/compose-only INPUT. RLY never rewrites it, and never "restores"
 *   native settings on child exit (unsafe under concurrent sessions).
 * - RLY gateway/model state is written only inside a view: the child-only
 *   gateway contract env is never persisted; a persisted `claude-rly-*`
 *   projection model is RLY-owned state and wins over native model input.
 * - The ownership manifest distinguishes native-imported, RLY-generated, and
 *   durable view-owned files/state using paths/revisions/hashes only.
 * - Deletion reconciliation removes an imported view file when its native
 *   source disappears and the view copy still matches the imported hash; a
 *   divergent view copy is reclassified view-owned and never deleted; RLY
 *   never deletes a file it does not own as an import.
 *
 * Concurrency: individual writes are atomic (temp + rename, `0600`, dirs
 * `0700`); the manifest read-modify-write and deletion reconciliation are
 * serialized per view with a bounded reconcile lock (skipped when busy —
 * refresh stays atomic and convergent, reconciliation is best-effort).
 *
 * Migration (#74 → #126): the legacy shared `<control-plane>/claude` overlay
 * is moved atomically into `views/default` on the next RLY Claude launch
 * (never touching native `~/.claude`). Ambiguous shared persisted state stays
 * in the unprofiled `default` view — it is never silently assigned to a
 * profile, and `rly status`/`rly doctor` surface the view layout.
 */

export const CLAUDE_OVERLAY_DIRECTORY_NAME = "claude";
export const CLAUDE_VIEWS_DIRECTORY_NAME = "views";
export const DEFAULT_CLAUDE_VIEW_ID = "default";
export const CLAUDE_OVERLAY_MARKER_NAME = ".rly-overlay.json";
export const CLAUDE_OVERLAY_MANIFEST_NAME = ".rly-manifest.json";
export const CLAUDE_OVERLAY_RECONCILE_LOCK_NAME = ".rly-reconcile.lock";
/**
 * Allowlist composition version. Bumped when the typed allowlist contract
 * changes: v2 added the gateway model-discovery key; v3 (#126) introduces
 * profile-scoped views, the ownership manifest, deletion reconciliation, and
 * the explicit settings-ownership precedence. An older marker re-composes on
 * the next launch while RLY-owned state (a persisted `claude-rly-*` model)
 * still wins.
 */
export const CLAUDE_OVERLAY_ALLOWLIST_VERSION = 3;

/** Env keys RLY owns for the child-only gateway contract and must never inherit from native settings. */
export const GATEWAY_CONTRACT_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
] as const;

/** Settings surfaces RLY refuses to compose (credential-bearing shapes). */
const UNSUPPORTED_SETTINGS_KEYS = ["oauthAccounts"] as const;

const SETTINGS_FILE = "settings.json";
const AGENTS_DIRECTORY = "agents";
const COMMANDS_DIRECTORY = "commands";
const SKILLS_DIRECTORY = "skills";
const PLUGIN_CONFIG_RELATIVE = join("plugins", "config.json");
/** Keys carried from the native plugin config; everything else (including OAuth accounts) stays native. */
const PLUGIN_CONFIG_ALLOWED_KEYS = new Set(["enabledPlugins", "marketplaces"]);
/** Dependency/version-control directories are never copied as part of the skills allowlist. */
const SKILLS_EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);
/** Bounded reconcile-lock acquisition: 40 × 25 ms = 1 s. */
const RECONCILE_LOCK_ATTEMPTS = 40;
const RECONCILE_LOCK_RETRY_MS = 25;

/** Typed ownership categories for Claude/model/gateway settings (issue #126). */
export type SettingsOwnership =
  /** RLY owns the value: gateway-contract env keys and RLY projection model ids. */
  | "rly-owned"
  /** Both native input and view/client persistence can set the key; precedence is explicit and tested. */
  | "conflicting"
  /** Carried through composition without change (user-owned input). */
  | "safe-pass-through"
  /** Never composed (credential-bearing shapes); stays native. */
  | "unsupported"
  /** Set explicitly by RLY/profile policy (launch policy env/model), above native input. */
  | "user-override";

/** Explicit RLY/profile settings tier (launch policy). Applied below the child-only gateway contract. */
export type ExplicitClaudeSettings = Readonly<{
  model?: string;
  env?: Readonly<Record<string, string>>;
}>;

export type ClaudeOverlayPaths = Readonly<{
  viewId: string;
  directory: string;
  settings: string;
  agents: string;
  commands: string;
  skills: string;
  pluginConfig: string;
  marker: string;
  manifest: string;
  reconcileLock: string;
}>;

/**
 * Deterministic profile-scoped view identity (#126): a stable, collision-safe
 * short id derived from the immutable control-plane profile id (never the
 * mutable profile name), so a renamed profile keeps its durable view and two
 * profiles can never share one. Reserved ids are never produced by this
 * function.
 */
export function deriveClaudeViewId(profileId: string): string {
  if (profileId === "" || profileId === DEFAULT_CLAUDE_VIEW_ID) return DEFAULT_CLAUDE_VIEW_ID;
  return createHash("sha256").update(`rly:claude-view:${profileId}`).digest("hex").slice(0, 16);
}

export function claudeOverlayPaths(
  controlPlaneDirectory: string,
  viewId: string = DEFAULT_CLAUDE_VIEW_ID,
): ClaudeOverlayPaths {
  const directory = join(controlPlaneDirectory, CLAUDE_OVERLAY_DIRECTORY_NAME, CLAUDE_VIEWS_DIRECTORY_NAME, viewId);
  return {
    viewId,
    directory,
    settings: join(directory, SETTINGS_FILE),
    agents: join(directory, AGENTS_DIRECTORY),
    commands: join(directory, COMMANDS_DIRECTORY),
    skills: join(directory, SKILLS_DIRECTORY),
    pluginConfig: join(directory, PLUGIN_CONFIG_RELATIVE),
    marker: join(directory, CLAUDE_OVERLAY_MARKER_NAME),
    manifest: join(directory, CLAUDE_OVERLAY_MANIFEST_NAME),
    reconcileLock: join(directory, CLAUDE_OVERLAY_RECONCILE_LOCK_NAME),
  };
}

/** Resolves the native (user-owned) Claude config root to compose from. */
export function nativeClaudeConfigDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const configured = environment["CLAUDE_CONFIG_DIR"];
  if (configured !== undefined && configured !== "") return configured;
  return join(environment["HOME"] ?? homedir(), ".claude");
}

/** Drops native `env` overrides that would fight the RLY child-only gateway contract. */
function stripGatewayEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings["env"];
  if (typeof env !== "object" || env === null || Array.isArray(env)) return settings;
  const stripped = Object.fromEntries(
    Object.entries(env as Record<string, unknown>).filter(([key]) => !(GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(key)),
  );
  return { ...settings, env: stripped };
}

/**
 * Classifies one top-level `settings.json` key with its current value.
 * Metadata only — never content.
 */
export function classifySettingsKey(key: string, value: unknown): SettingsOwnership {
  if (key === "model") {
    return rlyOwnedModel({ model: value }) !== undefined ? "rly-owned" : "conflicting";
  }
  if (key === "env") return "safe-pass-through";
  if ((UNSUPPORTED_SETTINGS_KEYS as readonly string[]).includes(key)) return "unsupported";
  return "safe-pass-through";
}

/** Classifies one `settings.json` `env` key (gateway contract keys are RLY-owned). */
export function classifySettingsEnvKey(key: string): SettingsOwnership {
  return (GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(key) ? "rly-owned" : "safe-pass-through";
}

export type SettingsOwnershipSummary = Readonly<{
  rlyOwned: number;
  conflicting: readonly string[];
  safePassThrough: number;
  unsupported: readonly string[];
  userOverride: number;
  gatewayEnvKeys: readonly string[];
}>;

/**
 * Secret-free ownership summary of native settings for diagnostics: counts and
 * key names only, never values.
 */
export function settingsOwnershipSummary(
  native: unknown,
  explicit?: ExplicitClaudeSettings,
): SettingsOwnershipSummary {
  const conflicting: string[] = [];
  const unsupported: string[] = [];
  const gatewayEnvKeys: string[] = [];
  let rlyOwned = 0;
  let safePassThrough = 0;
  let userOverride = 0;
  if (typeof native === "object" && native !== null && !Array.isArray(native)) {
    for (const [key, value] of Object.entries(native)) {
      if (key === "env" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const envKey of Object.keys(value as Record<string, unknown>)) {
          if ((GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(envKey)) gatewayEnvKeys.push(envKey);
          else safePassThrough += 1;
        }
        continue;
      }
      const ownership = classifySettingsKey(key, value);
      if (ownership === "rly-owned") rlyOwned += 1;
      else if (ownership === "conflicting") conflicting.push(key);
      else if (ownership === "unsupported") unsupported.push(key);
      else safePassThrough += 1;
    }
  }
  if (explicit?.model !== undefined) userOverride += 1;
  if (explicit?.env !== undefined) userOverride += Object.keys(explicit.env).length;
  return { rlyOwned, conflicting, safePassThrough, unsupported, gatewayEnvKeys, userOverride };
}

/**
 * Merges native settings with RLY-owned and view-local state under the
 * explicit #126 precedence contract (high → low):
 *
 * 1. child-only RLY gateway contract env — never in settings, never inherited.
 * 2. RLY-owned persisted projection model (`claude-rly-*`) — wins on re-compose.
 * 3. explicit RLY/profile settings (launch policy `model`) — above native input.
 * 4. user native settings/env — gateway-conflicting `env` keys stripped.
 * 5. client persistence in the view (Claude-added keys absent from native).
 * 6. defaults.
 */
export function composeOverlaySettings(
  native: unknown,
  previous?: unknown,
  explicit?: ExplicitClaudeSettings,
): Record<string, unknown> {
  if (native !== undefined && (typeof native !== "object" || native === null || Array.isArray(native))) {
    throw new Error("RLY cannot compose Claude settings: native settings.json is not a JSON object");
  }
  const nativeRecord = native as Record<string, unknown> | undefined;
  const previousRecord = normalizeSettings(previous);
  const result: Record<string, unknown> = {};

  // 4. user native settings/env (gateway contract env stripped; unsupported
  //    credential-bearing shapes like `oauthAccounts` are never composed).
  if (nativeRecord !== undefined) {
    const nativeSurface = stripGatewayEnv(nativeRecord);
    const composedSurface = Object.fromEntries(
      Object.entries(nativeSurface).filter(([key]) => !(UNSUPPORTED_SETTINGS_KEYS as readonly string[]).includes(key)),
    );
    Object.assign(result, composedSurface);
  }

  // 5. client persistence: keys Claude added in the view and absent from native.
  if (previousRecord !== undefined) {
    const previousEnv = previousRecord["env"];
    for (const [key, value] of Object.entries(previousRecord)) {
      if (key === "env" || key === "model") continue;
      if ((UNSUPPORTED_SETTINGS_KEYS as readonly string[]).includes(key)) continue;
      if (!(key in result)) result[key] = value;
    }
    if (typeof previousEnv === "object" && previousEnv !== null && !Array.isArray(previousEnv)) {
      const mergedEnv: Record<string, unknown> = { ...(typeof result["env"] === "object" && result["env"] !== null
        ? (result["env"] as Record<string, unknown>)
        : {}) };
      for (const [key, value] of Object.entries(previousEnv as Record<string, unknown>)) {
        if ((GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(key)) continue;
        if (!(key in mergedEnv)) mergedEnv[key] = value;
      }
      if (Object.keys(mergedEnv).length > 0) result["env"] = mergedEnv;
    }
  }

  // 3. explicit RLY/profile settings (user override tier) — wins over native.
  if (explicit?.model !== undefined) result["model"] = explicit.model;

  // 2. RLY-owned persisted projection model wins over everything.
  const rlyModel = rlyOwnedModel(previousRecord);
  if (rlyModel !== undefined) result["model"] = rlyModel;

  // 5 continued: a non-RLY model persisted in the view survives only when no
  // native model and no explicit model exists (client persistence).
  if (!("model" in result) && typeof previousRecord?.["model"] === "string") {
    result["model"] = previousRecord["model"];
  }
  return result;
}

/** Returns the overlay-persisted model only when it is an RLY-only projection id. */
export function rlyOwnedModel(settings: unknown): string | undefined {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
  const model = (settings as Record<string, unknown>)["model"];
  return typeof model === "string" && model.startsWith(RLY_MODEL_PREFIX) ? model : undefined;
}

function normalizeSettings(settings: unknown): Record<string, unknown> | undefined {
  if (settings === undefined || settings === null) return undefined;
  if (typeof settings !== "object" || Array.isArray(settings)) return undefined;
  return settings as Record<string, unknown>;
}

/** Carries only the plugin enablement declaration; never OAuth accounts or token-like keys. */
export function composeOverlayPluginConfig(native: unknown): unknown {
  if (typeof native !== "object" || native === null || Array.isArray(native)) return undefined;
  const source = native as Record<string, unknown>;
  const carried = Object.fromEntries(Object.entries(source).filter(([key]) => PLUGIN_CONFIG_ALLOWED_KEYS.has(key)));
  return Object.keys(carried).length === 0 ? undefined : carried;
}

export type ClaudeOverlayResolution = Readonly<{
  viewId: string;
  directory: string;
  source: string;
  /** True when any overlay file was composed/refreshed/reconciled on this call. */
  composed: boolean;
  refreshed: readonly string[];
  /** Imported view files removed because their native source disappeared (deletion reconciliation). */
  reconciledDeletions: readonly string[];
  /** Imported view files reclassified view-owned because the view copy diverged from the import. */
  reclassified: readonly string[];
  /** True when this call migrated the legacy shared overlay into the default view. */
  migratedFromShared: boolean;
}>;

export type ClaudeOverlayPrepareOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  /** Deterministic profile-scoped view identity; defaults to the unprofiled `default` view. */
  viewId?: string;
  /** Explicit RLY/profile settings tier (launch policy model/env). */
  explicit?: ExplicitClaudeSettings;
}>;

export type ClaudeOverlayStatus = Readonly<{
  viewId: string;
  directory: string;
  source: string;
  allowlistVersion: number;
  lastComposedAt?: string;
  migratedFromShared?: boolean;
}>;

export type ClaudeViewStatus = Readonly<{
  viewId: string;
  directory: string;
  source: string;
  allowlistVersion: number;
  lastComposedAt?: string;
  lastReconciledAt?: string;
  migratedFromShared?: boolean;
  ownership: Readonly<{
    nativeImported: number;
    rlyGenerated: number;
    viewOwned: number;
    reclassifiedToViewOwned: number;
  }>;
  settings: SettingsOwnershipSummary;
}>;

/** Ownership manifest categories (metadata + hashes only, never content). */
export type ManifestEntryCategory = "native-imported" | "rly-generated" | "view-owned";

export type ManifestEntry = Readonly<{
  category: ManifestEntryCategory;
  /** Native-relative path of the import source (imported entries only). */
  source?: string;
  /** sha256 of the native source at last import (imported entries only). */
  sourceHash: string | undefined;
  /** sha256 of the view file when last written/reconciled. */
  viewHash: string | undefined;
  importedAt?: string;
  lastRefreshedAt?: string;
  /** Top-level `settings.json` keys (plus `env.<key>`) imported from native; metadata only. */
  settingsSourceKeys?: readonly string[];
}>;

export type OwnershipManifest = Readonly<{
  schemaVersion: 1;
  allowlistVersion: number;
  source: string;
  lastReconciledAt?: string;
  entries: Readonly<Record<string, ManifestEntry>>;
}>;

function explicitPolicyFingerprint(explicit?: ExplicitClaudeSettings): string | undefined {
  if (explicit === undefined) return undefined;
  const model = explicit.model ?? "";
  const envKeys = explicit.env === undefined ? [] : Object.keys(explicit.env).sort();
  if (model === "" && envKeys.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify({ model, envKeys })).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isNewer(source: string, target: string): Promise<boolean> {
  const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
  return sourceStat.mtimeMs > targetStat.mtimeMs;
}

async function needsRefresh(source: string, target: string): Promise<boolean> {
  try {
    return await isNewer(source, target);
  } catch {
    // Target missing (or source unreadable): refresh.
    return true;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    // Missing, unreadable, or malformed JSON surfaces are treated as absent:
    // RLY never fails the launch over content it cannot compose, and never
    // rewrites native files. Malformed native settings are skipped (documented
    // difference) rather than dropped silently from a shared file.
    return undefined;
  }
}

async function fileHash(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

async function writePrivateText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temporaryPath = join(dirname(path), `.rly-overlay.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** One-way refresh copy of a single allowlisted file (atomic, 0600). */
async function refreshFileCopy(source: string, target: string): Promise<boolean> {
  if (!(await isRegularFile(source))) return false;
  if (!(await needsRefresh(source, target))) return false;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700).catch(() => undefined);
  const temporaryPath = join(dirname(target), `.rly-overlay.${randomUUID()}.copy`);
  await copyFile(source, temporaryPath);
  await chmod(temporaryPath, 0o600).catch(() => undefined);
  try {
    await rename(temporaryPath, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return true;
}

/** Lists regular files below a directory. Symlinks are never followed (safety). */
async function listFiles(directory: string, recursive: boolean): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKILLS_EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...await listFiles(path, true));
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
  return files;
}

type OverlayMarker = Readonly<{
  allowlistVersion?: number;
  source?: string;
  lastComposedAt?: string;
  migratedFromShared?: boolean;
  /** Digest of launch-policy model/env keys; changing policy recomposes even if native is unchanged. */
  explicitPolicyFingerprint?: string;
}>;

async function readMarker(path: string): Promise<OverlayMarker | undefined> {
  const value = await readJsonFile(path);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record["allowlistVersion"] === "number" ? { allowlistVersion: record["allowlistVersion"] } : {}),
    ...(typeof record["source"] === "string" ? { source: record["source"] } : {}),
    ...(typeof record["lastComposedAt"] === "string" ? { lastComposedAt: record["lastComposedAt"] } : {}),
    ...(typeof record["migratedFromShared"] === "boolean" ? { migratedFromShared: record["migratedFromShared"] } : {}),
    ...(typeof record["explicitPolicyFingerprint"] === "string" ? { explicitPolicyFingerprint: record["explicitPolicyFingerprint"] } : {}),
  };
}

async function writeMarker(path: string, marker: OverlayMarker): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(marker, null, 2)}\n`);
}

async function readManifest(path: string): Promise<OwnershipManifest | undefined> {
  const value = await readJsonFile(path);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 || typeof record["allowlistVersion"] !== "number") return undefined;
  const entries: Record<string, ManifestEntry> = {};
  if (typeof record["entries"] === "object" && record["entries"] !== null) {
    for (const [relativePath, entry] of Object.entries(record["entries"] as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item["category"] !== "native-imported" && item["category"] !== "rly-generated" && item["category"] !== "view-owned") continue;
      entries[relativePath] = {
        category: item["category"],
        sourceHash: typeof item["sourceHash"] === "string" ? item["sourceHash"] : undefined,
        viewHash: typeof item["viewHash"] === "string" ? item["viewHash"] : undefined,
        ...(typeof item["source"] === "string" ? { source: item["source"] } : {}),
        ...(typeof item["importedAt"] === "string" ? { importedAt: item["importedAt"] } : {}),
        ...(typeof item["lastRefreshedAt"] === "string" ? { lastRefreshedAt: item["lastRefreshedAt"] } : {}),
        ...(Array.isArray(item["settingsSourceKeys"])
          ? { settingsSourceKeys: item["settingsSourceKeys"].filter((key): key is string => typeof key === "string") }
          : {}),
      };
    }
  }
  return {
    schemaVersion: 1,
    allowlistVersion: record["allowlistVersion"],
    source: typeof record["source"] === "string" ? record["source"] : "",
    ...(typeof record["lastReconciledAt"] === "string" ? { lastReconciledAt: record["lastReconciledAt"] } : {}),
    entries,
  };
}

async function writeManifest(path: string, manifest: OwnershipManifest): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

type ReconcileLock = Readonly<{ release: () => Promise<void> }>;

/** Bounded per-view reconcile lock. Returns undefined when a sibling holds it (best-effort reconcile). */
async function acquireReconcileLock(path: string): Promise<ReconcileLock | undefined> {
  const lockId = randomUUID();
  for (let attempt = 0; attempt < RECONCILE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(`${lockId}\n`);
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          const current = await readFile(path, "utf8").catch(() => "");
          if (current === `${lockId}\n`) await unlink(path).catch(() => undefined);
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_LOCK_RETRY_MS));
    }
  }
  return undefined;
}

/**
 * Moves the legacy shared `<control-plane>/claude` overlay into
 * `views/default` exactly once, idempotent under concurrent launches.
 * `rename` cannot move a directory into its own subtree, so the move is
 * two-phase: `claude` → `claude.legacy` (sibling) then `claude.legacy` →
 * `claude/views/default`. A crash between the phases leaves the sibling
 * staging directory; the next launch completes phase two. Native `~/.claude`
 * is never touched; ambiguous shared persisted state is never assigned to a
 * profile — it stays in the unprofiled default view, which doctor/status
 * surface.
 */
async function migrateSharedOverlay(controlPlaneDirectory: string, source: string): Promise<boolean> {
  const legacy = join(controlPlaneDirectory, CLAUDE_OVERLAY_DIRECTORY_NAME);
  const viewsRoot = join(controlPlaneDirectory, CLAUDE_OVERLAY_DIRECTORY_NAME, CLAUDE_VIEWS_DIRECTORY_NAME);
  const defaultView = join(viewsRoot, DEFAULT_CLAUDE_VIEW_ID);
  const staging = join(controlPlaneDirectory, `${CLAUDE_OVERLAY_DIRECTORY_NAME}.legacy`);
  if (!(await isDirectory(legacy))) {
    // Legacy absent: a previous run may have crashed after phase one — finish
    // the move from the sibling staging directory.
    if (await isDirectory(staging)) {
      await mkdir(viewsRoot, { recursive: true, mode: 0o700 });
      try {
        await rename(staging, defaultView);
        return true;
      } catch {
        return await isDirectory(defaultView);
      }
    }
    return false;
  }
  if (samePath(source, legacy)) return false; // never migrate a live native root
  if (await isDirectory(defaultView)) return false; // already migrated
  // A `views/` subdirectory means `<cp>/claude` is already the profile-scoped
  // view container, not a #74-era shared overlay — never migrate the container.
  if (await isDirectory(join(legacy, CLAUDE_VIEWS_DIRECTORY_NAME))) return false;
  try {
    await rename(legacy, staging);
  } catch (error) {
    // A sibling completed phase one concurrently; finish phase two ourselves.
    if (!(await isDirectory(staging))) throw error;
  }
  await mkdir(viewsRoot, { recursive: true, mode: 0o700 });
  try {
    await rename(staging, defaultView);
    await chmod(defaultView, 0o700).catch(() => undefined);
    return true;
  } catch {
    return await isDirectory(defaultView);
  }
}

/** Returns a shallow copy of entries without `key` (replaces dynamic `delete`). */
function withoutEntry(
  entries: Readonly<Record<string, ManifestEntry>>,
  key: string,
): Record<string, ManifestEntry> {
  const next: Record<string, ManifestEntry> = {};
  for (const [entryKey, entry] of Object.entries(entries)) {
    if (entryKey !== key) next[entryKey] = entry;
  }
  return next;
}

/**
 * Deletion/rename reconciliation for one imported surface. RLY deletes the
 * view file only when (a) the native source is gone (deleted/renamed) AND
 * (b) the manifest says it was native-imported AND (c) the view copy still
 * matches the imported hash. A divergent view copy is reclassified view-owned
 * and never deleted. A native source that still exists is a live import — the
 * view copy is never deleted for it (the refresh loop already updated its
 * hash). Never touches entries RLY does not own as imports.
 * Returns `{ deleted, reclassified }`.
 */
async function reconcileMissingImport(
  viewPath: string,
  nativeSourcePath: string,
  entry: ManifestEntry | undefined,
): Promise<{ deleted: boolean; reclassified: boolean }> {
  if (entry === undefined || entry.category !== "native-imported") {
    return { deleted: false, reclassified: false };
  }
  // Native source still present: the import is live; never delete the view copy.
  if (await isRegularFile(nativeSourcePath)) return { deleted: false, reclassified: false };
  const currentHash = await fileHash(viewPath);
  if (currentHash === undefined) return { deleted: false, reclassified: false };
  if (entry.sourceHash === currentHash) {
    await unlink(viewPath).catch(() => undefined);
    return { deleted: true, reclassified: false };
  }
  return { deleted: false, reclassified: true };
}

/**
 * Prepares (idempotently) the durable, profile-scoped RLY Claude config view
 * for a launch.
 *
 * Returns the `CLAUDE_CONFIG_DIR` value for the child. Missing, unreadable,
 * or malformed native surfaces are skipped (never rewritten); the native
 * `settings.json` is never failed over or modified.
 */
export async function prepareClaudeOverlay(
  controlPlaneDirectory: string,
  options: ClaudeOverlayPrepareOptions = {},
): Promise<ClaudeOverlayResolution> {
  const environment = options.environment ?? process.env;
  const viewId = options.viewId ?? DEFAULT_CLAUDE_VIEW_ID;
  const source = nativeClaudeConfigDirectory(environment);

  // Deterministic one-time migration of the legacy shared overlay (#74 → #126).
  const migratedFromShared = await migrateSharedOverlay(controlPlaneDirectory, source);

  const paths = claudeOverlayPaths(controlPlaneDirectory, viewId);
  if (samePath(source, paths.directory)) {
    // Never compose an overlay from itself (nested/self reference).
    return {
      viewId,
      directory: paths.directory,
      source,
      composed: false,
      refreshed: [],
      reconciledDeletions: [],
      reclassified: [],
      migratedFromShared,
    };
  }

  const refreshed: string[] = [];
  const reconciledDeletions: string[] = [];
  const reclassified: string[] = [];
  let composed = false;

  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700).catch(() => undefined);

  // Reconcile (manifest + deletion) and refresh under the bounded per-view
  // lock; when a sibling holds the lock, refresh and reconciliation still
  // proceed atomically (reconciliation is idempotent and the manifest write is
  // atomic), while `lastReconciledAt` metadata is only recorded by the lock
  // holder (best-effort, never corrupting).
  const lock = await acquireReconcileLock(paths.reconcileLock);
  const marker = await readMarker(paths.marker);
  let manifest = await readManifest(paths.manifest);
  const hadManifest = manifest !== undefined;
  let manifestChanged = false;
  const reconcileAt = new Date().toISOString();

  // settings.json: one-way merge with RLY-owned overrides (never deleted —
  // it carries RLY-owned model state and view persistence).
  const nativeSettingsPath = join(source, SETTINGS_FILE);
  const nativeSettings = await readJsonFile(nativeSettingsPath);
  const settingsEntry = manifest?.entries[SETTINGS_FILE];
  const explicitFingerprint = explicitPolicyFingerprint(options.explicit);
  const hasExplicitModel = options.explicit?.model !== undefined;
  const shouldComposeSettings = (nativeSettings !== undefined || hasExplicitModel) && (
    !(await exists(paths.settings))
    || marker === undefined
    || (marker.allowlistVersion ?? 0) < CLAUDE_OVERLAY_ALLOWLIST_VERSION
    || (nativeSettings !== undefined && await needsRefresh(nativeSettingsPath, paths.settings))
    || explicitFingerprint !== marker.explicitPolicyFingerprint
  );
  if (shouldComposeSettings) {
    const previous = await readJsonFile(paths.settings);
    const composedNative = nativeSettings ?? {};
    await writePrivateText(paths.settings, `${JSON.stringify(composeOverlaySettings(composedNative, previous, options.explicit), null, 2)}\n`);
    refreshed.push(SETTINGS_FILE);
    composed = true;
    const nativeRecord = nativeSettings as Record<string, unknown> | undefined;
    const nativeEnv = nativeRecord === undefined ? undefined : nativeRecord["env"];
    const nativeEnvKeys = typeof nativeEnv === "object" && nativeEnv !== null && !Array.isArray(nativeEnv)
      ? Object.keys(nativeEnv)
      : [];
    // Keys that can actually appear in the composed view (gateway-contract and
    // unsupported shapes are never composed, so they are not reconciliation
    // metadata — keeping the manifest lean and privacy-preserving).
    const settingsSourceKeys = nativeRecord === undefined
      ? []
      : [
          ...Object.keys(nativeRecord).filter(
            (key) => !(UNSUPPORTED_SETTINGS_KEYS as readonly string[]).includes(key),
          ),
          ...nativeEnvKeys
            .filter((key) => !(GATEWAY_CONTRACT_ENV_KEYS as readonly string[]).includes(key))
            .map((key) => `env.${key}`),
        ];
    const sourceHashValue = nativeRecord === undefined ? undefined : await fileHash(nativeSettingsPath);
    const viewHashValue = await fileHash(paths.settings);
    manifestChanged = true;
    manifest = {
      schemaVersion: 1,
      allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
      source,
      ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
      entries: {
        ...manifest?.entries,
        [SETTINGS_FILE]: {
          category: nativeRecord === undefined ? "rly-generated" : "native-imported",
          ...(nativeRecord === undefined ? {} : { source: SETTINGS_FILE }),
          sourceHash: sourceHashValue,
          viewHash: viewHashValue,
          ...(settingsEntry?.importedAt === undefined ? {} : { importedAt: settingsEntry.importedAt }),
          lastRefreshedAt: reconcileAt,
          settingsSourceKeys,
        },
      },
    };
  } else if (nativeSettings === undefined && settingsEntry !== undefined && settingsEntry.sourceHash !== undefined) {
    // Native settings removed: recompose from the previous view, dropping keys
    // that were imported from native (metadata snapshot) while keeping
    // RLY-owned model state and view-persisted keys. The file itself is never
    // deleted while it carries RLY-owned state.
    const currentHash = await fileHash(paths.settings);
    if (currentHash !== undefined) {
      const previous = await readJsonFile(paths.settings);
      const snapshot = new Set(settingsEntry.settingsSourceKeys ?? []);
      const next: Record<string, unknown> = {};
      if (typeof previous === "object" && previous !== null && !Array.isArray(previous)) {
        for (const [key, value] of Object.entries(previous as Record<string, unknown>)) {
          if (key === "model") {
            next["model"] = value; // RLY-owned projection or client-persisted model survives
            continue;
          }
          if (key === "env" && typeof value === "object" && value !== null && !Array.isArray(value)) {
            const keptEnv = Object.fromEntries(
              Object.entries(value as Record<string, unknown>).filter(([envKey]) => !snapshot.has(`env.${envKey}`)),
            );
            if (Object.keys(keptEnv).length > 0) next["env"] = keptEnv;
            continue;
          }
          if (!snapshot.has(key)) next[key] = value;
        }
      }
      const rlyModel = rlyOwnedModel(previous);
      if (rlyModel !== undefined) next["model"] = rlyModel;
      await writePrivateText(paths.settings, `${JSON.stringify(next, null, 2)}\n`);
      refreshed.push(SETTINGS_FILE);
      composed = true;
      manifestChanged = true;
      const viewHashValue = await fileHash(paths.settings);
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries: {
          ...manifest?.entries,
          [SETTINGS_FILE]: {
            category: "rly-generated",
            sourceHash: undefined,
            viewHash: viewHashValue,
            ...(settingsEntry.importedAt === undefined ? {} : { importedAt: settingsEntry.importedAt }),
            lastRefreshedAt: reconcileAt,
          },
        },
      };
    }
  }

  // agents/*.md and commands/*.md: one-way refresh copy of native-present
  // files (upserting manifest entries for new imports).
  for (const [directoryName, suffix] of [
    [AGENTS_DIRECTORY, ".md"],
    [COMMANDS_DIRECTORY, ".md"],
  ] as const) {
    for (const file of await listFiles(join(source, directoryName), false)) {
      if (!file.endsWith(suffix)) continue;
      const relativePath = join(directoryName, basename(file));
      const viewPath = join(paths.directory, directoryName, basename(file));
      if (await refreshFileCopy(file, viewPath)) {
        refreshed.push(relativePath);
        manifestChanged = true;
        const entry = manifest?.entries[relativePath];
        const sourceHashValue = await fileHash(file);
        const viewHashValue = await fileHash(viewPath);
        manifest = {
          ...manifest,
          schemaVersion: 1,
          allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
          source,
          ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
          entries: {
            ...manifest?.entries,
            [relativePath]: {
              category: "native-imported",
              source: relativePath,
              sourceHash: sourceHashValue,
              viewHash: viewHashValue,
              ...(entry?.importedAt === undefined ? {} : { importedAt: entry.importedAt }),
              lastRefreshedAt: reconcileAt,
            },
          },
        };
      }
    }
  }

  // skills/** : allowlisted recursive copy of user-authored skills.
  const nativeSkills = join(source, SKILLS_DIRECTORY);
  for (const file of await listFiles(nativeSkills, true)) {
    const relativePath = join(SKILLS_DIRECTORY, relative(nativeSkills, file));
    const viewPath = join(paths.directory, SKILLS_DIRECTORY, relative(nativeSkills, file));
    if (await refreshFileCopy(file, viewPath)) {
      refreshed.push(relativePath);
      manifestChanged = true;
      const entry = manifest?.entries[relativePath];
      const sourceHashValue = await fileHash(file);
      const viewHashValue = await fileHash(viewPath);
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries: {
          ...manifest?.entries,
          [relativePath]: {
            category: "native-imported",
            source: relativePath,
            sourceHash: sourceHashValue,
            viewHash: viewHashValue,
            ...(entry?.importedAt === undefined ? {} : { importedAt: entry.importedAt }),
            lastRefreshedAt: reconcileAt,
          },
        },
      };
    }
  }

  // Deletion/rename reconciliation: manifest-tracked imports whose native
  // source disappeared are deleted (matching hash) or reclassified view-owned
  // (divergent copy); live native sources are never touched. Entries RLY does
  // not own as imports are never touched. The pass runs outside the reconcile
  // lock too: it is idempotent (unlink/rename are safe to repeat) and the
  // manifest write below is atomic, so a busy sibling never corrupts state.
  for (const [relativePath, entry] of Object.entries(manifest?.entries ?? {})) {
    if (entry.category !== "native-imported") continue;
    if (relativePath === SETTINGS_FILE || relativePath === PLUGIN_CONFIG_RELATIVE) continue;
    if (!(relativePath.startsWith(`${AGENTS_DIRECTORY}/`) || relativePath.startsWith(`${COMMANDS_DIRECTORY}/`) || relativePath.startsWith(`${SKILLS_DIRECTORY}/`))) {
      continue;
    }
    const viewPath = join(paths.directory, relativePath);
    // Manifest keys for these surfaces are native-root-relative paths.
    const outcome = await reconcileMissingImport(viewPath, join(source, relativePath), entry);
    if (outcome.deleted) {
      reconciledDeletions.push(relativePath);
      manifestChanged = true;
      const entries = withoutEntry(manifest?.entries ?? {}, relativePath);
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries,
      };
    } else if (outcome.reclassified) {
      reclassified.push(relativePath);
      manifestChanged = true;
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries: {
          ...manifest?.entries,
          [relativePath]: {
            category: "view-owned",
            sourceHash: undefined,
            viewHash: await fileHash(viewPath),
            lastRefreshedAt: reconcileAt,
          },
        },
      };
    }
  }

  // plugins/config.json: allowlisted keys only; credential-bearing keys dropped.
  const nativePluginConfig = join(source, PLUGIN_CONFIG_RELATIVE);
  const pluginConfig = await readJsonFile(nativePluginConfig);
  const pluginEntry = manifest?.entries[PLUGIN_CONFIG_RELATIVE];
  const pluginSourcePresent = await isRegularFile(nativePluginConfig);
  if (pluginSourcePresent && pluginConfig !== undefined && await needsRefresh(nativePluginConfig, paths.pluginConfig)) {
    const carried = composeOverlayPluginConfig(pluginConfig);
    if (carried !== undefined) {
      await writePrivateText(paths.pluginConfig, `${JSON.stringify(carried, null, 2)}\n`);
      refreshed.push(PLUGIN_CONFIG_RELATIVE);
      composed = true;
      manifestChanged = true;
      const sourceHashValue = await fileHash(nativePluginConfig);
      const viewHashValue = await fileHash(paths.pluginConfig);
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries: {
          ...manifest?.entries,
          [PLUGIN_CONFIG_RELATIVE]: {
            category: "native-imported",
            source: PLUGIN_CONFIG_RELATIVE,
            sourceHash: sourceHashValue,
            viewHash: viewHashValue,
            ...(pluginEntry?.importedAt === undefined ? {} : { importedAt: pluginEntry.importedAt }),
            lastRefreshedAt: reconcileAt,
          },
        },
      };
    }
  } else if (!pluginSourcePresent && pluginEntry !== undefined && pluginEntry.sourceHash !== undefined) {
    // Native plugin config removed: delete only the owned allowlist projection
    // when it still matches what we imported; otherwise view-owned.
    const outcome = await reconcileMissingImport(paths.pluginConfig, join(source, PLUGIN_CONFIG_RELATIVE), pluginEntry);
    if (outcome.deleted) {
      reconciledDeletions.push(PLUGIN_CONFIG_RELATIVE);
      manifestChanged = true;
      const entries = withoutEntry(manifest?.entries ?? {}, PLUGIN_CONFIG_RELATIVE);
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries,
      };
    } else if (outcome.reclassified) {
      reclassified.push(PLUGIN_CONFIG_RELATIVE);
      manifestChanged = true;
      manifest = {
        ...manifest,
        schemaVersion: 1,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
        source,
        ...(lock === undefined ? {} : { lastReconciledAt: reconcileAt }),
        entries: {
          ...manifest?.entries,
          [PLUGIN_CONFIG_RELATIVE]: {
            category: "view-owned",
            sourceHash: undefined,
            viewHash: await fileHash(paths.pluginConfig),
            lastRefreshedAt: reconcileAt,
          },
        },
      };
    }
  }

  // Persist the manifest (metadata only) when anything changed or it is new.
  if (manifestChanged || !hadManifest) {
    if (manifest === undefined) {
      manifest = { schemaVersion: 1, allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION, source, entries: {} };
    }
    await writeManifest(paths.manifest, manifest);
    await chmod(paths.manifest, 0o600).catch(() => undefined);
  }

  if (lock !== undefined) await lock.release();

  if (composed || refreshed.length > 0 || reconciledDeletions.length > 0 || marker === undefined) {
    await writeMarker(paths.marker, {
      allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
      source,
      lastComposedAt: reconcileAt,
      ...(migratedFromShared ? { migratedFromShared: true } : {}),
      ...(explicitFingerprint === undefined ? {} : { explicitPolicyFingerprint: explicitFingerprint }),
    });
  }
  return {
    viewId,
    directory: paths.directory,
    source,
    composed,
    refreshed,
    reconciledDeletions,
    reclassified,
    migratedFromShared,
  };
}

/** Secret-free default-view overlay summary for diagnostics (legacy status shape). */
export async function readClaudeOverlayStatus(controlPlaneDirectory: string): Promise<ClaudeOverlayStatus | undefined> {
  const paths = claudeOverlayPaths(controlPlaneDirectory, DEFAULT_CLAUDE_VIEW_ID);
  const marker = await readMarker(paths.marker);
  if (marker === undefined) return undefined;
  return {
    viewId: DEFAULT_CLAUDE_VIEW_ID,
    directory: paths.directory,
    source: marker.source ?? nativeClaudeConfigDirectory(),
    allowlistVersion: marker.allowlistVersion ?? CLAUDE_OVERLAY_ALLOWLIST_VERSION,
    ...(marker.lastComposedAt === undefined ? {} : { lastComposedAt: marker.lastComposedAt }),
    ...(marker.migratedFromShared === undefined ? {} : { migratedFromShared: marker.migratedFromShared }),
  };
}

/**
 * Secret-free per-view diagnostics: view id/path, composition version,
 * ownership/reconciliation status, conflicting key categories, and last
 * refresh metadata. Never settings content, prompts, transcripts, skills/
 * agents text, credentials, or account identity.
 */
export async function readClaudeViewStatuses(controlPlaneDirectory: string): Promise<readonly ClaudeViewStatus[]> {
  const viewsRoot = join(controlPlaneDirectory, CLAUDE_OVERLAY_DIRECTORY_NAME, CLAUDE_VIEWS_DIRECTORY_NAME);
  const viewIds = (await readdir(viewsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const statuses: ClaudeViewStatus[] = [];
  for (const viewId of viewIds) {
    const paths = claudeOverlayPaths(controlPlaneDirectory, viewId);
    const [marker, manifest] = await Promise.all([readMarker(paths.marker), readManifest(paths.manifest)]);
    if (marker === undefined) continue;
    const entries = manifest?.entries ?? {};
    let nativeImported = 0;
    let rlyGenerated = 0;
    let viewOwned = 0;
    let reclassifiedToViewOwned = 0;
    for (const entry of Object.values(entries)) {
      if (entry.category === "native-imported") nativeImported += 1;
      else if (entry.category === "rly-generated") rlyGenerated += 1;
      else viewOwned += 1;
    }
    const settingsEntry = entries[SETTINGS_FILE];
    if (settingsEntry?.category === "rly-generated") reclassifiedToViewOwned = 1;
    statuses.push({
      viewId,
      directory: paths.directory,
      source: marker.source ?? nativeClaudeConfigDirectory(),
      allowlistVersion: marker.allowlistVersion ?? CLAUDE_OVERLAY_ALLOWLIST_VERSION,
      ...(marker.lastComposedAt === undefined ? {} : { lastComposedAt: marker.lastComposedAt }),
      ...(manifest?.lastReconciledAt === undefined ? {} : { lastReconciledAt: manifest.lastReconciledAt }),
      ...(marker.migratedFromShared === undefined ? {} : { migratedFromShared: marker.migratedFromShared }),
      ownership: { nativeImported, rlyGenerated, viewOwned, reclassifiedToViewOwned },
      settings: settingsOwnershipSummary(await readJsonFile(paths.settings).catch(() => undefined)),
    });
  }
  return statuses;
}
