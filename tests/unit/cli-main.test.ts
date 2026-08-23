import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { childExitCode, parseCliArgs, runCli } from "../../src/cli/main.js";
import { ProfileActivationError } from "../../src/profiles/errors.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { ClaudeOverlayResolution } from "../../src/runtime/claude-overlay.js";

const cliOverlayDirectory = join(tmpdir(), "rly-gateway-cli-overlay");

function overlayDependency(): { prepareClaudeOverlay: (controlPlaneDirectory: string, options?: { environment?: Readonly<NodeJS.ProcessEnv>; viewId?: string; explicit?: { model?: string; env?: Readonly<Record<string, string>> } }) => Promise<ClaudeOverlayResolution> } {
  return {
    prepareClaudeOverlay: vi.fn().mockResolvedValue({
      viewId: "default",
      directory: cliOverlayDirectory,
      source: cliOverlayDirectory,
      composed: false,
      refreshed: [],
      reconciledDeletions: [],
      reclassified: [],
      migratedFromShared: false,
    }),
  };
}

describe("CLI parsing", () => {
  it("parses version and --version as the version command", () => {
    expect(parseCliArgs(["version"])).toEqual({ command: "version" });
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
    expect(() => parseCliArgs(["--version", "extra"])).toThrow("version accepts no arguments");
  });

  it("parses quota and route-trace diagnostic commands", () => {
    expect(parseCliArgs(["quota", "--config", "custom.toml"], "/work")).toEqual({
      command: "quota",
      configPath: "/work/custom.toml",
    });
    expect(parseCliArgs(["route-trace"], "/work")).toEqual({
      command: "route-trace",
      configPath: "/work/gateway.config.toml",
    });
  });

  it("parses run codex with the same separator contract", () => {
    expect(parseCliArgs(["run", "codex", "--config", "custom.toml", "--", "exec", "fixture"], "/work")).toEqual({
      command: "run-codex",
      configPath: "/work/custom.toml",
      claudeArgs: ["exec", "fixture"],
    });
  });

  it("forwards only arguments after the run separator to Claude", () => {
    expect(parseCliArgs([
      "run", "claude", "--config", "custom.toml", "--", "--model", "name with spaces", "--dangerously-skip-permissions",
    ], "/work")).toEqual({
      command: "run-claude",
      configPath: "/work/custom.toml",
      claudeArgs: ["--model", "name with spaces", "--dangerously-skip-permissions"],
    });
  });

  it("requires an explicit separator for Claude arguments", () => {
    expect(() => parseCliArgs(["run", "claude", "--model", "model"])).toThrow("requires `--`");
  });

  it("pins a configured exact provider/model route through its explicit role", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-route-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n[routes.primary]\nprovider = \"openrouter\"\nmodel = \"provider/model\"\ncredential = \"env:OPENROUTER_API_KEY\"\n", "utf8");
    expect(parseCliArgs(["run", "claude", "--config", configPath, "--route", "openrouter/provider/model", "--", "-p", "fixture"])).toMatchObject({ route: "openrouter/provider/model" });
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    await expect(runCli(
      ["run", "claude", "--config", configPath, "--route", "openrouter/provider/model", "--", "-p", "fixture"],
      { environment: { PATH: "/bin" }, ...overlayDependency(), acquireGateway: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:17871", authToken: "transient", instanceId: "00000000-0000-4000-8000-000000000001", leaseId: "00000000-0000-4000-8000-000000000011", reused: false, release }), launchClaude: launch },
    )).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ args: ["--model", "primary", "-p", "fixture"] }));
  });

  it("rejects unconfigured or conflicting route selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-route-error-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    await expect(runCli(["run", "claude", "--config", configPath, "--route", "openrouter/missing", "--"], { environment: {} })).rejects.toThrow("not configured");
    expect(() => parseCliArgs(["run", "claude", "--route", "openrouter/model", "--", "--model", "primary"])).not.toThrow();
  });

  it("parses --profile and rejects combining it with --route", () => {
    expect(parseCliArgs(["run", "claude", "--profile", "work", "--", "-p", "fixture"])).toMatchObject({
      command: "run-claude",
      profile: "work",
    });
    expect(() => parseCliArgs(["run", "claude", "--profile", "work", "--route", "openrouter/model", "--"])).toThrow("cannot be combined");
  });

  it("launches Claude with a profile child token instead of the instance secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-profile-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    await expect(runCli(
      ["run", "claude", "--config", configPath, "--profile", "work", "--", "-p", "fixture"],
      {
        environment: { PATH: "/bin" },
        ...overlayDependency(),
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "instance-secret",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude: launch,
        issueProfileLaunch: vi.fn().mockResolvedValue({ token: "child-token", args: ["-p", "fixture"], executable: "claude", profileId: "p-1", explicit: undefined }),
      },
    )).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ authToken: "child-token", args: ["-p", "fixture"] }));
    expect(release).toHaveBeenCalledOnce();
  });

  it("parses a bare profile as Claude Code launch, not Codex CLI", () => {
    expect(parseCliArgs(["codex"], "/work")).toEqual({
      command: "run-claude",
      configPath: "/work/gateway.config.toml",
      claudeArgs: [],
      profile: "codex",
    });
    expect(parseCliArgs(["clinepass", "--config", "custom.toml", "--", "-p", "fixture"], "/work")).toEqual({
      command: "run-claude",
      configPath: "/work/custom.toml",
      claudeArgs: ["-p", "fixture"],
      profile: "clinepass",
    });
    expect(parseCliArgs(["deepseek"])).not.toMatchObject({ command: "run-codex" });
  });

  it("keeps reserved commands from colliding with profile names", () => {
    expect(parseCliArgs(["status"], "/work")).toMatchObject({ command: "status" });
    expect(parseCliArgs(["doctor"], "/work")).toMatchObject({ command: "doctor" });
    expect(parseCliArgs(["quota"], "/work")).toMatchObject({ command: "quota" });
    expect(parseCliArgs(["route-trace"], "/work")).toMatchObject({ command: "route-trace" });
    expect(parseCliArgs(["admin", "ui"], "/work")).toMatchObject({ command: "admin", resource: "ui" });
    expect(parseCliArgs(["run", "codex", "--"], "/work")).toMatchObject({ command: "run-codex", claudeArgs: [] });
    expect(parseCliArgs(["run", "claude", "--profile", "codex", "--"], "/work")).toMatchObject({
      command: "run-claude",
      profile: "codex",
    });
    expect(parseCliArgs(["init"], "/work")).toMatchObject({ command: "init", configPath: "/work/gateway.config.toml" });
    expect(parseCliArgs(["install", "--channel", "stable"], "/work")).toMatchObject({ command: "install" });
    expect(parseCliArgs(["uninstall", "--purge"], "/work")).toMatchObject({ command: "uninstall" });
    expect(parseCliArgs(["update", "--channel", "beta"], "/work")).toMatchObject({ command: "update" });
    expect(parseCliArgs(["init", "--config", "custom.toml"], "/work")).toMatchObject({
      command: "init",
      configPath: "/work/custom.toml",
    });
    expect(parseCliArgs(["config"], "/work")).toMatchObject({ command: "config" });
    expect(parseCliArgs(["config", "status", "--config", "custom.toml"], "/work")).toMatchObject({
      command: "config",
      focus: { kind: "status" },
      configPath: "/work/custom.toml",
    });
    expect(parseCliArgs(["gateway", "start"], "/work")).toMatchObject({ command: "gateway", action: "start" });
    expect(parseCliArgs(["gateway", "stop"], "/work")).toMatchObject({ command: "gateway", action: "stop" });
    expect(parseCliArgs(["gateway", "status", "--config", "custom.toml"], "/work")).toMatchObject({
      command: "gateway",
      action: "status",
      configPath: "/work/custom.toml",
    });
    expect(() => parseCliArgs(["gateway"], "/work")).toThrow("gateway requires start, stop, or status");
    expect(() => parseCliArgs(["gateway", "start", "extra"], "/work")).toThrow("unknown option");
    expect(() => parseCliArgs(["init", "extra"], "/work")).toThrow("init accepts only --config");
  });

  it("rejects --profile or leftover tokens on a bare profile", () => {
    expect(() => parseCliArgs(["codex", "--profile", "work"])).toThrow("cannot be combined with a bare profile name");
    expect(() => parseCliArgs(["codex", "--route", "openrouter/model"])).toThrow("cannot be combined");
    expect(() => parseCliArgs(["codex", "-p", "fixture"])).toThrow("unknown option");
    expect(() => parseCliArgs(["codex", "extra"])).toThrow("requires `--`");
  });

  it("launches Claude Code for a bare profile with a child token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-bare-profile-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launchClaude = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const launchCodex = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const issueProfileLaunch = vi.fn().mockResolvedValue({ token: "child-token", args: ["-p", "fixture"], executable: "claude", profileId: "p-1", explicit: undefined });
    await expect(runCli(
      ["codex", "--config", configPath, "--", "-p", "fixture"],
      {
        environment: { PATH: "/bin" },
        ...overlayDependency(),
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "instance-secret",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude,
        launchCodex,
        issueProfileLaunch,
      },
    )).resolves.toBe(0);
    expect(issueProfileLaunch).toHaveBeenCalledWith(expect.anything(), "codex", ["-p", "fixture"], expect.anything(), "claude");
    expect(launchClaude).toHaveBeenCalledWith(expect.objectContaining({ authToken: "child-token", args: ["-p", "fixture"] }));
    expect(launchCodex).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed on an unknown bare profile and does not launch Codex CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-unknown-profile-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launchCodex = vi.fn();
    await expect(runCli(
      ["missing", "--config", configPath],
      {
        environment: { PATH: "/bin" },
        ...overlayDependency(),
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "instance-secret",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude: vi.fn(),
        launchCodex,
        issueProfileLaunch: vi.fn().mockRejectedValue(new ProfileActivationError("profile-not-found", "Unknown profile")),
      },
    )).rejects.toThrow(ProfileActivationError);
    expect(launchCodex).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not expose an ownership-bypassing serve command", () => {
    expect(parseCliArgs(["serve"])).toMatchObject({ command: "run-claude", profile: "serve" });
    expect(parseCliArgs(["serve"])).not.toMatchObject({ command: "admin" });
  });

  it("prints the canonical rly executable in usage output", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runCli([], { environment: {} })).resolves.toBe(2);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: rly "));
    output.mockRestore();
  });

  it("prints the exact build identity for --version", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runCli(["--version"], { environment: {} })).resolves.toBe(0);
      const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      expect(payload.product).toBe("rly-gateway");
      expect(payload.version).toBe(RUNTIME_VERSION);
      expect(typeof payload.commitRevision).toBe("string");
      expect(typeof payload.buildId).toBe("string");
      expect(payload.releaseChannel).toBe("dev");
      expect(payload.controlProtocolVersion).toBe(1);
      expect(payload.dataProtocolVersion).toBe(1);
      expect(payload.stateSchemaVersion).toBe(4);
      expect(payload.identitySchemaVersion).toBe(1);
    } finally {
      output.mockRestore();
    }
  });

  it("preserves regular child exits and converts signal exits", () => {
    expect(childExitCode({ code: 7, signal: null })).toBe(7);
    expect(childExitCode({ code: null, signal: "SIGINT" })).toBe(130);
  });

  it("prints a secret-free planned receipt after issuing a launch session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-planned-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const planned = {
      providerId: "openrouter",
      providerName: "openrouter",
      poolId: "pool-1",
      poolName: "default",
      modelRoles: { primary: "deepseek/deepseek-v4-flash" },
      policyRevision: 3,
      launchPolicyModel: "primary",
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      profileName: "work",
      profileId: "p-1",
      harness: "claude",
      launchPolicy: { model: "primary" },
      planned,
      token: "child-token-must-not-print",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    try {
      await expect(runCli(
        ["work", "--config", configPath],
        {
          environment: { PATH: "/bin" },
          ...overlayDependency(),
          acquireGateway: vi.fn().mockResolvedValue({
            baseUrl: "http://127.0.0.1:17871",
            authToken: "instance-secret",
            instanceId: "00000000-0000-4000-8000-000000000001",
            leaseId: "00000000-0000-4000-8000-000000000011",
            reused: false,
            release,
          }),
          launchClaude: launch,
        },
      )).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(JSON.stringify({ planned }));
      expect(output.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("child-token-must-not-print");
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ authToken: "child-token-must-not-print" }));
      expect(release).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("acquires and releases a gateway around the Claude child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const acquire = vi.fn().mockResolvedValue({
      baseUrl: "http://127.0.0.1:17871",
      authToken: "transient",
      instanceId: "00000000-0000-4000-8000-000000000001",
      leaseId: "00000000-0000-4000-8000-000000000011",
      reused: false,
      release,
    });
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    await expect(runCli(
      ["run", "claude", "--config", configPath, "--", "--model", "test"],
      { environment: { PATH: "/bin" }, ...overlayDependency(), acquireGateway: acquire, launchClaude: launch },
    )).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient",
      args: ["--model", "test"],
    }));
    expect(release).toHaveBeenCalledOnce();
  });
});
