import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchClaude, type ChildProcessLike, type ChildSpawner, type SignalSource } from "../../src/runtime/child-launcher.js";
import {
  CLAUDE_OVERLAY_ALLOWLIST_VERSION,
  DEFAULT_CLAUDE_VIEW_ID,
  classifySettingsEnvKey,
  classifySettingsKey,
  claudeOverlayPaths,
  composeOverlayPluginConfig,
  composeOverlaySettings,
  deriveClaudeViewId,
  nativeClaudeConfigDirectory,
  prepareClaudeOverlay,
  readClaudeOverlayStatus,
  readClaudeViewStatuses,
  RLY_MODEL_PREFIX,
  rlyOwnedModel,
  settingsOwnershipSummary,
} from "../../src/runtime/claude-overlay.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-overlay-"));
  directories.push(directory);
  return directory;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileMode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

function nativeEnvironment(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: "/bin" };
}

describe("RLY Claude configuration overlay", () => {
  it("composes native settings one-way: unrelated keys preserved, gateway env stripped, model kept", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({
      model: "claude-sonnet-4-5",
      theme: "dark",
      permissions: { allow: ["Bash"] },
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0",
        ANTHROPIC_BASE_URL: "http://native.example",
        ANTHROPIC_AUTH_TOKEN: "native-secret",
        ANTHROPIC_API_KEY: "native-key",
        OPENAI_API_KEY: "native-openai",
      },
    }), "utf8");
    const before = await digest(join(native, "settings.json"));

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });

    expect(resolution.directory).toBe(join(controlPlane, "claude", "views", DEFAULT_CLAUDE_VIEW_ID));
    expect(resolution.source).toBe(native);
    expect(resolution.composed).toBe(true);
    const overlay = JSON.parse(await readFile(resolution.directory + "/settings.json", "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe("claude-sonnet-4-5");
    expect(overlay["theme"]).toBe("dark");
    expect(overlay["permissions"]).toEqual({ allow: ["Bash"] });
    // #72: the gateway model-discovery flag is child-only RLY contract state;
    // a native setting cannot silently disable or override it in RLY sessions.
    expect(overlay["env"]).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    // Native input is never modified.
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("refreshes allowlisted agents, commands, and skills without touching other files", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await mkdir(join(native, "commands"), { recursive: true });
    await mkdir(join(native, "skills", "review"), { recursive: true });
    await mkdir(join(native, "plugins", "cache"), { recursive: true });
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\nreviewer fixture\n", "utf8");
    await writeFile(join(native, "agents", "ignored.txt"), "not an agent\n", "utf8");
    await writeFile(join(native, "commands", "ship.md"), "ship fixture\n", "utf8");
    await writeFile(join(native, "skills", "review", "SKILL.md"), "# skill fixture\n", "utf8");
    await writeFile(join(native, "plugins", "cache", "binary.bin"), "plugin cache must not be copied\n", "utf8");
    await writeFile(join(native, "unknown.json"), "unknown surface\n", "utf8");

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });

    expect(await readFile(join(resolution.directory, "agents", "reviewer.md"), "utf8")).toBe("# reviewer\nreviewer fixture\n");
    expect(await readFile(join(resolution.directory, "commands", "ship.md"), "utf8")).toBe("ship fixture\n");
    expect(await readFile(join(resolution.directory, "skills", "review", "SKILL.md"), "utf8")).toBe("# skill fixture\n");
    // Non-allowlisted surfaces are never copied.
    await expect(stat(join(resolution.directory, "agents", "ignored.txt"))).rejects.toThrow();
    await expect(stat(join(resolution.directory, "plugins", "cache"))).rejects.toThrow();
    await expect(stat(join(resolution.directory, "unknown.json"))).rejects.toThrow();
    expect(resolution.refreshed).toEqual(expect.arrayContaining(["agents/reviewer.md", "commands/ship.md", "skills/review/SKILL.md"]));
    expect(resolution.refreshed).not.toEqual(expect.arrayContaining(["agents/ignored.txt", "plugins/cache/binary.bin"]));
  });

  it("carries only the plugin enablement declaration and drops credential-bearing keys", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "plugins"), { recursive: true });
    await writeFile(join(native, "plugins", "config.json"), JSON.stringify({
      enabledPlugins: ["https://example.com/marketplace"],
      marketplaces: ["https://example.com/marketplace"],
      oauthAccounts: { "example.com": { oauthToken: "fixture-token", refreshToken: "fixture-refresh" } },
      installedPlugins: [{ name: "private" }],
    }), "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    const carried = JSON.parse(await readFile(paths.pluginConfig, "utf8")) as Record<string, unknown>;
    expect(carried).toEqual({
      enabledPlugins: ["https://example.com/marketplace"],
      marketplaces: ["https://example.com/marketplace"],
    });
    expect(JSON.stringify(carried)).not.toMatch(/token|secret|oauthAccount|installedPlugins/i);
  });

  it("uses private permissions for overlay files and directories", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    expect(await fileMode(paths.directory)).toBe(0o700);
    expect(await fileMode(join(paths.agents))).toBe(0o700);
    expect(await fileMode(paths.settings)).toBe(0o600);
    expect(await fileMode(join(paths.agents, "reviewer.md"))).toBe(0o600);
    expect(await fileMode(paths.marker)).toBe(0o600);
  });

  it("is idempotent and preserves a persisted RLY-only model when native input is unchanged", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    const nativeDigest = await digest(join(native, "settings.json"));

    const first = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    expect(first.composed).toBe(true);

    // Claude persists an RLY-only projection model into the overlay (/model Enter).
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0`, theme: "dark" }), "utf8");

    const second = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    // Native unchanged → no recompose → RLY model survives.
    expect(second.composed).toBe(false);
    expect(second.refreshed).toEqual([]);
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe(`${RLY_MODEL_PREFIX}primary-0`);
    expect(await digest(join(native, "settings.json"))).toBe(nativeDigest);
  });

  it("picks up native changes on re-compose while keeping RLY-only model state", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    const nativeSettings = join(native, "settings.json");
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}fast-0`, theme: "dark" }), "utf8");

    // User edits native settings (newer mtime) and adds a new preference.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-haiku-4-5", theme: "light", extra: true }), "utf8");

    const refreshed = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(refreshed.composed).toBe(true);
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["theme"]).toBe("light");
    expect(overlay["extra"]).toBe(true);
    // RLY-owned projection model wins over native model input on re-compose.
    expect(overlay["model"]).toBe(`${RLY_MODEL_PREFIX}fast-0`);
    expect(JSON.parse(await readFile(nativeSettings, "utf8"))).toMatchObject({ theme: "light", extra: true });
  });

  it("keeps a native (non-RLY) model as user input after re-compose", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    const nativeSettings = join(native, "settings.json");
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: "claude-opus-4-8" }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", extra: true }), "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    // A real model persisted in the overlay is not RLY-owned; native input wins.
    expect(overlay["model"]).toBe("claude-sonnet-4-5");
    expect(overlay["extra"]).toBe(true);
  });

  it("converges under concurrent prepares without corrupting state", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    const before = await digest(join(native, "settings.json"));

    const results = await Promise.all([
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) }),
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) }),
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) }),
    ]);

    expect(new Set(results.map((result) => result.directory)).size).toBe(1);
    const paths = claudeOverlayPaths(controlPlane);
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe("claude-sonnet-4-5");
    expect(await readFile(join(paths.agents, "reviewer.md"), "utf8")).toBe("# reviewer\n");
    expect(JSON.parse(await readFile(paths.marker, "utf8"))).toMatchObject({ allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION });
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("creates an empty durable overlay when no native config exists and never touches home files", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    await writeFile(join(home, ".claude.json"), "sentinel\n", "utf8");

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });

    // No native surfaces to compose, but the durable namespace + marker exist.
    expect(resolution.composed).toBe(false);
    expect(resolution.refreshed).toEqual([]);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("sentinel\n");
    expect(await readClaudeOverlayStatus(controlPlane)).toMatchObject({
      directory: join(controlPlane, "claude", "views", DEFAULT_CLAUDE_VIEW_ID),
      source: join(home, ".claude"),
      allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
    });
  });

  it("composes overlay settings from launch policy when native settings are absent", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const first = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-opus-4-8" },
    });
    expect(first.composed).toBe(true);
    const paths = claudeOverlayPaths(controlPlane);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toMatchObject({ model: "claude-opus-4-8" });

    const same = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-opus-4-8" },
    });
    expect(same.composed).toBe(false);

    const changed = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-haiku-4-5" },
    });
    expect(changed.composed).toBe(true);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toMatchObject({ model: "claude-haiku-4-5" });

    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}fast-0` }), "utf8");
    const persisted = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-opus-4-8" },
    });
    expect(persisted.composed).toBe(true);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toMatchObject({ model: `${RLY_MODEL_PREFIX}fast-0` });
  });

  it("recomposes when launch policy changes even if native settings are unchanged", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    const nativeSettings = join(native, "settings.json");
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    const first = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-opus-4-8" },
    });
    expect(first.composed).toBe(true);
    const paths = claudeOverlayPaths(controlPlane);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toMatchObject({
      model: "claude-opus-4-8",
      theme: "dark",
    });

    const same = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-opus-4-8" },
    });
    expect(same.composed).toBe(false);

    const changed = await prepareClaudeOverlay(controlPlane, {
      environment: nativeEnvironment(home),
      explicit: { model: "claude-haiku-4-5" },
    });
    expect(changed.composed).toBe(true);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toMatchObject({
      model: "claude-haiku-4-5",
      theme: "dark",
    });
  });

  it("skips malformed native settings without failing the launch or touching native files", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), "{ not valid json", "utf8");
    const before = await digest(join(native, "settings.json"));
    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(resolution.composed).toBe(false);
    // Malformed native settings are not composed into the overlay.
    await expect(stat(claudeOverlayPaths(controlPlane).settings)).rejects.toThrow();
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("never composes an overlay from itself", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const nested = await prepareClaudeOverlay(controlPlane, {
      environment: { HOME: home, CLAUDE_CONFIG_DIR: resolution.directory, PATH: "/bin" },
    });
    expect(nested.composed).toBe(false);
    expect(nested.directory).toBe(resolution.directory);
  });

  it("reports a secret-free overlay status and no status without a marker", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    expect(await readClaudeOverlayStatus(controlPlane)).toBeUndefined();
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const status = await readClaudeOverlayStatus(controlPlane);
    expect(status).toBeDefined();
    expect(status?.source).toBe(join(home, ".claude"));
    expect(status?.allowlistVersion).toBe(CLAUDE_OVERLAY_ALLOWLIST_VERSION);
    expect(status?.directory).toBe(join(controlPlane, "claude", "views", DEFAULT_CLAUDE_VIEW_ID));
  });

  it("launches Claude with the durable overlay and leaves native config byte-identical after /model activity", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "sentinel\n", "utf8");
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    const protectedFiles = [join(native, "settings.json"), join(native, "agents", "reviewer.md"), join(home, ".claude.json")];
    const before = await Promise.all(protectedFiles.map(digest));

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const child = new TestChild();
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const spawner: ChildSpawner = (_executable, _args, options) => {
      childEnvironment = options.env;
      return child;
    };
    const launched = launchClaude({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient-token",
      args: ["-p", "fixture"],
      environment: nativeEnvironment(home),
      configDirectory: resolution.directory,
      spawner,
      signalSource: new TestSignals(),
    });
    expect(childEnvironment?.["CLAUDE_CONFIG_DIR"]).toBe(resolution.directory);
    expect(childEnvironment?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:17871");
    expect(childEnvironment?.["ANTHROPIC_AUTH_TOKEN"]).toBe("transient-token");
    expect(childEnvironment).not.toHaveProperty("ANTHROPIC_API_KEY");

    // Simulate Claude persisting an RLY-only /model selection into the overlay.
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0`, theme: "dark" }), "utf8");
    child.close(0, null);
    await expect(launched).resolves.toEqual({ code: 0, signal: null });

    // A subsequent RLY launch keeps the RLY model; native files stay byte-identical.
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const overlay = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    expect(overlay["model"]).toBe(`${RLY_MODEL_PREFIX}primary-0`);
    expect(await Promise.all(protectedFiles.map(digest))).toEqual(before);
    // The overlay never carries gateway env or auth material that a plain launch could inherit.
    expect(JSON.stringify(overlay)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|transient-token/);
  });

  it("exposes pure composition helpers", () => {
    expect(composeOverlaySettings(undefined)).toEqual({});
    expect(composeOverlaySettings({ model: "claude-sonnet-4-5", env: { ANTHROPIC_BASE_URL: "x", KEEP: "y" } }))
      .toEqual({ model: "claude-sonnet-4-5", env: { KEEP: "y" } });
    expect(composeOverlaySettings({ model: "a" }, { model: `${RLY_MODEL_PREFIX}x` })).toEqual({ model: `${RLY_MODEL_PREFIX}x` });
    expect(rlyOwnedModel({ model: `${RLY_MODEL_PREFIX}x` })).toBe(`${RLY_MODEL_PREFIX}x`);
    expect(rlyOwnedModel({ model: "claude-sonnet-4-5" })).toBeUndefined();
    expect(composeOverlayPluginConfig({ enabledPlugins: ["a"], oauthAccounts: { x: { token: "t" } } }))
      .toEqual({ enabledPlugins: ["a"] });
    expect(composeOverlayPluginConfig({ oauthAccounts: { x: { token: "t" } } })).toBeUndefined();
    expect(nativeClaudeConfigDirectory({ HOME: "/tmp/u", CLAUDE_CONFIG_DIR: "/custom" })).toBe("/custom");
    expect(nativeClaudeConfigDirectory({ HOME: "/tmp/u" })).toBe("/tmp/u/.claude");
    // Unsupported credential-bearing settings shapes are never composed (#126).
    expect(composeOverlaySettings({ model: "a", oauthAccounts: { x: { token: "t" } } })).toEqual({ model: "a" });
  });

  it("classifies settings ownership with a deterministic typed contract", () => {
    expect(classifySettingsKey("model", `${RLY_MODEL_PREFIX}x`)).toBe("rly-owned");
    expect(classifySettingsKey("model", "claude-sonnet-4-5")).toBe("conflicting");
    expect(classifySettingsKey("theme", "dark")).toBe("safe-pass-through");
    expect(classifySettingsKey("oauthAccounts", {})).toBe("unsupported");
    expect(classifySettingsEnvKey("ANTHROPIC_AUTH_TOKEN")).toBe("rly-owned");
    expect(classifySettingsEnvKey("ANTHROPIC_BASE_URL")).toBe("rly-owned");
    expect(classifySettingsEnvKey("KEEP")).toBe("safe-pass-through");
    const summary = settingsOwnershipSummary({ model: `${RLY_MODEL_PREFIX}x`, theme: "dark", oauthAccounts: {}, env: { ANTHROPIC_AUTH_TOKEN: "s", KEEP: "1" } }, { model: "claude-opus-4-8" });
    expect(summary.rlyOwned).toBe(1);
    expect(summary.safePassThrough).toBeGreaterThanOrEqual(2);
    expect(summary.unsupported).toEqual(["oauthAccounts"]);
    expect(summary.gatewayEnvKeys).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    expect(summary.userOverride).toBe(1);
  });

  it("derives deterministic, collision-safe view ids from immutable profile ids", () => {
    expect(deriveClaudeViewId("profile-a")).toBe(deriveClaudeViewId("profile-a"));
    expect(deriveClaudeViewId("profile-a")).not.toBe(deriveClaudeViewId("profile-b"));
    expect(deriveClaudeViewId("a")).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveClaudeViewId("")).toBe(DEFAULT_CLAUDE_VIEW_ID);
    expect(deriveClaudeViewId(DEFAULT_CLAUDE_VIEW_ID)).toBe(DEFAULT_CLAUDE_VIEW_ID);
  });

  it("gives each profile a distinct durable view and isolates RLY-only model state", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    const nativeDigest = await digest(join(native, "settings.json"));
    const viewA = deriveClaudeViewId("profile-a");
    const viewB = deriveClaudeViewId("profile-b");

    const firstA = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewA });
    const firstB = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewB });
    expect(firstA.directory).not.toBe(firstB.directory);
    expect(firstA.directory.endsWith(join("views", viewA))).toBe(true);
    expect(firstB.directory.endsWith(join("views", viewB))).toBe(true);

    // Claude persists an RLY-only projection model into profile A's view.
    await writeFile(join(firstA.directory, "settings.json"), JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0` }), "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewA });
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewB });
    const settingsA = JSON.parse(await readFile(join(firstA.directory, "settings.json"), "utf8")) as Record<string, unknown>;
    const settingsB = JSON.parse(await readFile(join(firstB.directory, "settings.json"), "utf8")) as Record<string, unknown>;
    // A's RLY-only model never becomes B's default; B keeps the native model.
    expect(settingsA["model"]).toBe(`${RLY_MODEL_PREFIX}primary-0`);
    expect(settingsB["model"]).toBe("claude-sonnet-4-5");
    expect(await digest(join(native, "settings.json"))).toBe(nativeDigest);
  });

  it("records an ownership manifest and reconciles imported deletions", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    await writeFile(join(native, "agents", "gone-soon.md"), "# gone\n", "utf8");

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { entries: Record<string, { category?: string }> };
    expect(manifest["entries"]["agents/reviewer.md"]?.["category"]).toBe("native-imported");
    expect(manifest["entries"]["settings.json"]?.["category"]).toBe("native-imported");
    await expect(stat(join(paths.agents, "gone-soon.md"))).resolves.toBeDefined();

    // Native agent deleted → its owned import is removed on the next prepare.
    await unlink(join(native, "agents", "gone-soon.md"));
    const second = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(second.reconciledDeletions).toContain("agents/gone-soon.md");
    await expect(stat(join(paths.agents, "gone-soon.md"))).rejects.toThrow();
    // Unrelated imports and RLY/view state survive.
    expect(await readFile(join(paths.agents, "reviewer.md"), "utf8")).toBe("# reviewer\n");
    const after = JSON.parse(await readFile(paths.manifest, "utf8")) as { entries: Record<string, { category?: string }> };
    expect(after["entries"]["agents/gone-soon.md"]).toBeUndefined();
    expect(after["entries"]["agents/reviewer.md"]?.["category"]).toBe("native-imported");
  });

  it("reclassifies a divergent imported copy as view-owned instead of deleting it", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);

    // Claude edits the view copy (diverges from the import); native source disappears.
    await writeFile(join(paths.agents, "reviewer.md"), "# edited by Claude\n", "utf8");
    await unlink(join(native, "agents", "reviewer.md"));

    const second = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(second.reclassified).toContain("agents/reviewer.md");
    expect(second.reconciledDeletions).not.toContain("agents/reviewer.md");
    expect(await readFile(join(paths.agents, "reviewer.md"), "utf8")).toBe("# edited by Claude\n");
    const after = JSON.parse(await readFile(paths.manifest, "utf8")) as { entries: Record<string, { category?: string }> };
    expect(after["entries"]["agents/reviewer.md"]?.["category"]).toBe("view-owned");
  });

  it("applies explicit RLY/profile settings above native input but below persisted RLY state", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    const nativeSettings = join(native, "settings.json");
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    const explicit = { model: "claude-opus-4-8", env: { RLY_PROFILE_ENV: "1" } };

    const first = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), explicit });
    const paths = claudeOverlayPaths(controlPlane, first.viewId);
    expect(JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>).toMatchObject({
      model: "claude-opus-4-8",
      theme: "dark",
    });

    // Persisted RLY-owned projection (Claude /model write) beats the explicit policy on re-compose.
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}fast-0` }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(nativeSettings, JSON.stringify({ model: "claude-sonnet-4-5", theme: "light" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), explicit });
    expect(JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>).toMatchObject({
      model: `${RLY_MODEL_PREFIX}fast-0`,
      theme: "light",
    });
  });

  it("recomposes settings as rly-generated when native settings are removed", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark", env: { KEEP: "1" } }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    await writeFile(paths.settings, JSON.stringify({ model: `${RLY_MODEL_PREFIX}fast-0`, theme: "dark", env: { KEEP: "1" } }), "utf8");

    await unlink(join(native, "settings.json"));
    const second = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(second.composed).toBe(true);
    const after = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    // RLY-owned model survives; keys imported from native are dropped.
    expect(after["model"]).toBe(`${RLY_MODEL_PREFIX}fast-0`);
    expect(after["theme"]).toBeUndefined();
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { entries: Record<string, { category?: string }> };
    expect(manifest["entries"]["settings.json"]?.["category"]).toBe("rly-generated");
  });

  it("migrates the legacy shared overlay into the default view without touching native config", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    const nativeBefore = await digest(join(native, "settings.json"));

    // Simulate the #74 shared overlay at <cp>/claude with a v2 marker.
    const legacy = join(controlPlane, "claude");
    await mkdir(join(legacy, "agents"), { recursive: true });
    await writeFile(join(legacy, "settings.json"), JSON.stringify({ model: `${RLY_MODEL_PREFIX}old-0`, theme: "dark" }), "utf8");
    await writeFile(join(legacy, ".rly-overlay.json"), JSON.stringify({ allowlistVersion: 2, source: native }), "utf8");

    const resolution = await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    expect(resolution.migratedFromShared).toBe(true);
    expect(resolution.directory).toBe(join(controlPlane, "claude", "views", DEFAULT_CLAUDE_VIEW_ID));
    // Ambiguous shared RLY state stays in the unprofiled default view; the
    // legacy marker/settings moved out of the container root and the staging
    // directory is gone.
    const migrated = JSON.parse(await readFile(join(controlPlane, "claude", "views", "default", "settings.json"), "utf8")) as Record<string, unknown>;
    expect(migrated["model"]).toBe(`${RLY_MODEL_PREFIX}old-0`);
    await expect(stat(join(legacy, ".rly-overlay.json"))).rejects.toThrow();
    await expect(stat(join(controlPlane, "claude.legacy"))).rejects.toThrow();
    expect(await digest(join(native, "settings.json"))).toBe(nativeBefore);
  });

  it("converges under concurrent prepares across distinct profile views", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    const before = await digest(join(native, "settings.json"));
    const viewA = deriveClaudeViewId("profile-a");
    const viewB = deriveClaudeViewId("profile-b");

    const results = await Promise.all([
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewA }),
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewB }),
      prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewA }),
    ]);
    expect(new Set(results.map((result) => result.directory)).size).toBe(2);
    const pathsA = claudeOverlayPaths(controlPlane, viewA);
    const pathsB = claudeOverlayPaths(controlPlane, viewB);
    expect(JSON.parse(await readFile(pathsA.settings, "utf8")) as Record<string, unknown>).toMatchObject({ model: "claude-sonnet-4-5" });
    expect(JSON.parse(await readFile(pathsB.settings, "utf8")) as Record<string, unknown>).toMatchObject({ model: "claude-sonnet-4-5" });
    expect(await readFile(join(pathsA.agents, "reviewer.md"), "utf8")).toBe("# reviewer\n");
    expect(await readFile(join(pathsB.agents, "reviewer.md"), "utf8")).toBe("# reviewer\n");
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("never persists credentials or settings content into the view or manifest", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({
      model: "claude-sonnet-4-5",
      env: { ANTHROPIC_AUTH_TOKEN: "native-secret", ANTHROPIC_BASE_URL: "http://native.example", KEEP: "1" },
      oauthAccounts: { x: { oauthToken: "native-token" } },
    }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer fixture\n", "utf8");
    const before = await digest(join(native, "settings.json"));

    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home) });
    const paths = claudeOverlayPaths(controlPlane);
    const viewContents = [
      await readFile(paths.settings, "utf8"),
      await readFile(paths.marker, "utf8"),
      await readFile(paths.manifest, "utf8"),
      await readFile(join(paths.agents, "reviewer.md"), "utf8"),
    ];
    for (const contents of viewContents) {
      expect(contents).not.toMatch(/native-secret|native-token|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL/);
    }
    // Manifest records only composed-visible key names as reconciliation metadata.
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { entries: Record<string, { settingsSourceKeys?: readonly string[] }> };
    expect(manifest["entries"]["settings.json"]?.["settingsSourceKeys"]).toEqual(["model", "env", "env.KEEP"]);
    // View settings keep only safe env; native input is byte-identical.
    expect(JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>).toMatchObject({ env: { KEEP: "1" } });
    expect(await digest(join(native, "settings.json"))).toBe(before);
  });

  it("reports secret-free per-view statuses with ownership summaries", async () => {
    const home = await temporaryHome();
    const controlPlane = join(home, ".rly");
    const native = join(home, ".claude");
    await mkdir(join(native, "agents"), { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: `${RLY_MODEL_PREFIX}primary-0`, theme: "dark" }), "utf8");
    await writeFile(join(native, "agents", "reviewer.md"), "# reviewer\n", "utf8");
    const viewA = deriveClaudeViewId("profile-a");
    await prepareClaudeOverlay(controlPlane, { environment: nativeEnvironment(home), viewId: viewA });

    const statuses = await readClaudeViewStatuses(controlPlane);
    const status = statuses.find((item) => item.viewId === viewA);
    expect(status).toBeDefined();
    expect(status?.directory).toContain(join("views", viewA));
    expect(status?.allowlistVersion).toBe(CLAUDE_OVERLAY_ALLOWLIST_VERSION);
    expect(status?.ownership.nativeImported).toBeGreaterThanOrEqual(2);
    expect(status?.settings.rlyOwned).toBeGreaterThanOrEqual(1);
    expect(status?.settings.conflicting).toEqual([]);
    // Metadata only: never settings content, prompts, or credentials.
    expect(JSON.stringify(status)).not.toMatch(/reviewer fixture|# reviewer/);
  });
});

class TestChild implements ChildProcessLike {
  private closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  public once(event: "close" | "error", listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): unknown {
    if (event === "close") this.closeListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
    return this;
  }

  public kill(): boolean {
    return true;
  }

  public close(code: number | null, signal: NodeJS.Signals | null): void {
    this.closeListener?.(code, signal);
  }
}

class TestSignals implements SignalSource {
  private readonly listeners = new Map<NodeJS.Signals, () => void>();

  public once(signal: NodeJS.Signals, listener: () => void): unknown {
    this.listeners.set(signal, listener);
    return this;
  }

  public removeListener(signal: NodeJS.Signals, listener: () => void): unknown {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
    return this;
  }
}
