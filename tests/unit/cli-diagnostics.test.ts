import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { runDoctor, runQuota, runRouteTrace, runStatus } from "../../src/cli/diagnostics.js";
import { UpdateStateStore } from "../../src/runtime/update/store.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { loadConfig } from "../../src/config/load-config.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { acquireGateway, runtimeDirectory } from "../../src/runtime/gateway-lifecycle.js";
import { prepareClaudeOverlay, CLAUDE_OVERLAY_ALLOWLIST_VERSION, DEFAULT_CLAUDE_VIEW_ID } from "../../src/runtime/claude-overlay.js";
import { CLAUDE_CODE_FIXTURE_BASELINE } from "../../src/canary/client-fixtures.js";
import { seedCodexClaudeProfile, sseFixture } from "../helpers/codex-profile-seed.js";

const directories: string[] = [];
let provider: FastifyInstance | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

describe("CLI diagnostics", () => {
  it("prints secret-free doctor JSON without creating a control-plane store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-doctor-"));
    directories.push(directory);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runDoctor(configPath)).resolves.toBe(0);
      const printed = String(log.mock.calls[0]?.[0]);
      expect(printed).toContain('"ok":true');
      expect(printed).toContain('"claudeTarget"');
      expect(printed).toContain('"codexTarget"');
      expect(printed).not.toMatch(/OPENROUTER_API_KEY|accessToken|authorization|prompt/i);
    } finally {
      log.mockRestore();
    }
  });

  it("reports exact client version metadata and the canary baseline in doctor (#24)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-doctor-version-"));
    directories.push(directory);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runDoctor(configPath)).resolves.toBe(0);
      const printed = String(log.mock.calls[0]?.[0]);
      const doctor = JSON.parse(printed) as {
        claudeTarget: { found: boolean; executable: string; version?: string; versionSource: string };
        codexTarget: { found: boolean; executable: string; version?: string; versionSource: string };
        canary: { testedBaseline: string; liveGateEnv: string };
      };
      // Binary presence and exact version metadata are separate fields; a
      // machine may legitimately have an installed client (versionSource
      // "cli-output") or none ("unknown") — presence never implies baseline.
      expect(doctor.claudeTarget).toHaveProperty("found");
      expect(doctor.claudeTarget).toHaveProperty("executable");
      expect(["cli-output", "unknown"]).toContain(doctor.claudeTarget.versionSource);
      expect(["cli-output", "unknown"]).toContain(doctor.codexTarget.versionSource);
      if (doctor.claudeTarget.versionSource === "cli-output") {
        expect(doctor.claudeTarget["version"]).toEqual(expect.any(String));
      }
      expect(doctor.canary.testedBaseline).toBe(CLAUDE_CODE_FIXTURE_BASELINE);
      expect(doctor.canary.liveGateEnv).toBe("RLY_LIVE_CANARY");
      expect(printed).not.toMatch(/Bearer|accessToken|authorization|prompt/i);
    } finally {
      log.mockRestore();
    }
  });

  it("exposes allowlisted update metadata in status without secrets (#73/#93)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-status-update-"));
    directories.push(directory);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      "logLevel = \"silent\"",
      "[controlPlane]",
      `dataDirectory = ${JSON.stringify(join(directory, "plane"))}`,
    ].join("\n"), "utf8");
    const store = new UpdateStateStore(join(directory, "plane"));
    await store.write({
      schemaVersion: 1,
      state: "pending-activation",
      currentVersion: "0.1.0",
      pendingVersion: "2.0.0",
      previousVersion: "0.1.0",
      updatedAt: new Date().toISOString(),
      transaction: {
        schemaVersion: 1,
        phase: "draining",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        candidateVersion: "2.0.0",
        candidateArtifactId: "a".repeat(64),
        previousVersion: "0.1.0",
        previousArtifactId: "b".repeat(64),
        rollbackAttempts: 0,
      },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runStatus(configPath)).resolves.toBe(1); // runtime not running
      const printed = String(log.mock.calls.at(-1)?.[0]);
      const payload = JSON.parse(printed) as {
        update: {
          state: string;
          pendingVersion?: string;
          phase?: string;
          lock?: { held: boolean; ownerPid?: number; stale?: boolean };
          compatibility: { cli: string; compatible: boolean };
        };
      };
      expect(payload.update.state).toBe("pending-activation");
      expect(payload.update.pendingVersion).toBe("2.0.0");
      // #93: the durable transaction phase is surfaced for diagnostics.
      expect(payload.update.phase).toBe("draining");
      expect(payload.update.lock).toEqual({ held: false });
      expect(payload.update.compatibility.cli).toBe(RUNTIME_VERSION);
      expect(typeof payload.update.compatibility.compatible).toBe("boolean");
      expect(printed).not.toMatch(/Bearer|accessToken|authorization|api[_-]?key|prompt|@/i);
    } finally {
      log.mockRestore();
    }
  });

  it("reports the RLY Claude overlay summary secret-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-overlay-diag-"));
    directories.push(directory);
    const controlPlane = join(directory, "control-plane");
    const native = join(directory, ".claude");
    await mkdir(native);
    await writeFile(join(native, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", theme: "dark" }), "utf8");
    await prepareClaudeOverlay(controlPlane, { environment: { HOME: directory, PATH: "/bin" } });
    const port = await availablePort();
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      `port = ${String(port)}`,
      'logLevel = "silent"',
      "[controlPlane]",
      `dataDirectory = "${controlPlane}"`,
    ].join("\n"), "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // Gateway is not running, but the overlay summary is still reported.
      await expect(runStatus(configPath)).resolves.toBe(1);
      const printed = log.mock.calls.map((call) => String(call[0]));
      const status = JSON.parse(printed.find((line) => line.includes("claudeOverlay")) ?? "{}") as {
        claudeOverlay?: { directory?: string; source?: string; allowlistVersion?: number; lastComposedAt?: string };
      };
      expect(status.claudeOverlay).toMatchObject({
        directory: join(controlPlane, "claude", "views", DEFAULT_CLAUDE_VIEW_ID),
        source: native,
        allowlistVersion: CLAUDE_OVERLAY_ALLOWLIST_VERSION,
      });
      expect(typeof status.claudeOverlay?.lastComposedAt).toBe("string");
      // Ownership metadata only: never settings values, credentials, or tokens.
      expect(printed.join("\n")).not.toMatch(/ANTHROPIC_AUTH_TOKEN|"model"\s*:\s*"|"theme"\s*:\s*"|oauthToken|Bearer|token|secret/i);
    } finally {
      log.mockRestore();
    }
  });

  it("prints only pseudonym, quota class, and decision reason for a Codex profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-diag-"));
    directories.push(directory);
    const controlPlane = join(directory, "control-plane");
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("codex-diag", "CODEX_DIAG_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const store = await ControlPlaneStore.open(controlPlane);
    const broker = await CredentialBroker.open(controlPlane);
    try {
      await seedCodexClaudeProfile(store, broker, controlPlane, { endpoint });
    } finally {
      await broker.close();
      store.close();
    }
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      `port = ${String(port)}`,
      `managementPort = ${String(managementPort)}`,
      'logLevel = "silent"',
      "[controlPlane]",
      `dataDirectory = "${controlPlane}"`,
    ].join("\n"), "utf8");
    const lease = await acquireGateway({
      config: await loadConfig(configPath),
      controlPlaneDirectory: controlPlane,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const issued = await fetch(`${lease.baseUrl}/v1/launch-sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${lease.authToken}`, "content-type": "application/json" },
        body: JSON.stringify({ profileName: "codex", leaseId: lease.leaseId }),
      });
      expect(issued.status).toBe(201);
      const issuedBody = await issued.json() as { token?: string };
      const response = await fetch(`${lease.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${issuedBody.token ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] }),
      });
      expect(response.status).toBe(200);
      await expect(runQuota(configPath)).resolves.toBe(0);
      await expect(runRouteTrace(configPath)).resolves.toBe(0);
      await expect(runStatus(configPath)).resolves.toBe(0);
      const printed = log.mock.calls.map((call) => String(call[0]));
      const quota = JSON.parse(printed.find((line) => line.includes("accounts")) ?? "{}") as {
        accounts?: { pseudonym?: string; quotaClass?: string }[];
      };
      const traces = JSON.parse(printed.find((line) => line.includes("sourceRule")) ?? "{}") as {
        traces?: {
          profileName?: string;
          sourceRule?: string;
          selectedPseudonym?: string;
          effectiveModelDecision?: {
            intent?: { kind?: string; sourceSelector?: string };
            target?: { accessProviderId?: string; physicalModelId?: string };
            compatibility?: { authority?: string };
            poolBinding?: { poolId?: string };
          };
        }[];
      };
      expect(quota.accounts?.[0]?.pseudonym).toBe("acct-codex-a");
      expect(quota.accounts?.[0]?.quotaClass).toBe("healthy");
      expect(quota.accounts?.[0]).toEqual({ pseudonym: "acct-codex-a", quotaClass: "healthy" });
      expect(traces.traces?.[0]?.profileName).toBe("codex");
      expect(traces.traces?.[0]?.sourceRule).toMatch(/^pool:/);
      expect(traces.traces?.[0]?.selectedPseudonym).toBe("acct-codex-a");
      // #127: every routing request produces one secret-free EffectiveModelDecision
      // (intent + frozen target + ECR authority + pool binding) on the trace.
      expect(traces.traces?.[0]?.effectiveModelDecision?.intent?.kind).toBe("EXACT_CLIENT_MODEL");
      expect(traces.traces?.[0]?.effectiveModelDecision?.intent?.sourceSelector).toBe("primary");
      expect(traces.traces?.[0]?.effectiveModelDecision?.target?.accessProviderId).toBe("codex");
      expect(traces.traces?.[0]?.effectiveModelDecision?.target?.physicalModelId).toBe("gpt-5.4");
      expect(traces.traces?.[0]?.effectiveModelDecision?.compatibility?.authority).toBe("ecr");
      expect(traces.traces?.[0]?.effectiveModelDecision?.poolBinding?.poolId).toBeDefined();
      expect(traces.traces?.[0]).toEqual({
        profileName: "codex",
        sourceRule: traces.traces?.[0]?.sourceRule,
        selectedPseudonym: "acct-codex-a",
        modelSelection: {
          source: "exact",
          selectedLogicalId: "codex/gpt-5.4",
          reason: "exact-evidence",
        },
        effectiveModelDecision: traces.traces?.[0]?.effectiveModelDecision,
      });
      expect(printed.join("\n")).not.toMatch(/access-token-fixture|refresh-token|authorization|prompt|@/i);
    } finally {
      log.mockRestore();
      await lease.release();
      await rm(runtimeDirectory(port), { recursive: true, force: true });
    }
  });

  it("exposes bootstrap path, expected/serving build identity, and reconciliation state (#94)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-bootstrap-diag-"));
    directories.push(directory);
    const controlPlane = join(directory, "control-plane");
    const packageRoot = join(directory, "pkg");
    await mkdir(join(packageRoot, "dist", "cli"), { recursive: true, mode: 0o700 });
    await writeFile(join(packageRoot, "dist", "cli", "main.js"), "// runtime\n", "utf8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "rly-gateway", version: "0.1.0" }), "utf8");
    const { ensureInitialActiveDeployment, writeBootstrapScript, resolveActiveDeployment } = await import("../../src/runtime/bootstrap.js");
    await ensureInitialActiveDeployment(controlPlane, { packageRoot });
    const bootstrapPath = await writeBootstrapScript(controlPlane);
    const active = await resolveActiveDeployment(controlPlane);
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      'port = 17901',
      'logLevel = "silent"',
      "[controlPlane]",
      `dataDirectory = "${controlPlane}"`,
    ].join("\n"), "utf8");
    // Installation record (platform linux) so status reports reconciliation.
    await writeFile(join(controlPlane, "installation.json"), JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0",
      configPath,
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
      bootstrapPath,
    }), "utf8");
    // Fake manager confined to the temp dir; its definition is missing.
    const { defaultBuildIdentity } = await import("../../src/runtime/build-identity.js");
    const fakeManager = {
      platform: "linux" as const,
      serviceName: "rly-gateway",
      definitionPath: join(directory, "rly-gateway.service"),
      isSupported: () => true,
      isRegistered: () => Promise.resolve(false),
      register: () => Promise.resolve(undefined),
      renderDefinition: () => "/tmp/.rly/bootstrap/rly-gateway gateway start --config " + configPath,
      unregister: () => Promise.resolve(undefined),
      start: () => Promise.resolve(undefined),
      restart: () => Promise.resolve(undefined),
      stop: () => Promise.resolve(undefined),
      status: () => Promise.resolve("not-registered" as const),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // Status: read-only — reports bootstrap + expected/serving + definition
      // reconciliation state without mutating.
      await expect(runStatus(configPath, { createServiceManager: () => fakeManager })).resolves.toBe(1);
      const status = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      const bootstrap = status["bootstrap"] as Record<string, unknown>;
      expect(bootstrap["path"]).toBe(bootstrapPath);
      expect(bootstrap["installed"]).toBe(true);
      const activeInfo = bootstrap["active"] as Record<string, unknown>;
      expect(activeInfo["artifactId"]).toBe(active.artifactId);
      const expected = bootstrap["expected"] as Record<string, unknown>;
      expect(expected["artifactId"]).toBe(active.artifactId);
      expect(expected["semanticVersion"]).toBe("0.1.0");
      expect(expected["releaseChannel"]).toBe("dev");
      const definition = status["serviceDefinition"] as Record<string, unknown>;
      expect(definition["status"]).toBe("missing");
      expect(String(log.mock.calls.at(-1)?.[0])).not.toMatch(/Bearer|accessToken|authorization|api[_-]?key|prompt|@/i);

      // Doctor: detects AND idempotently repairs the missing definition.
      await expect(runDoctor(configPath, { createServiceManager: () => fakeManager })).resolves.toBe(0);
      const doctor = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      const doctorDefinition = doctor["serviceDefinition"] as Record<string, unknown>;
      expect(doctorDefinition["status"]).toBe("repaired"); // doctor detected AND repaired idempotently
      const doctorUpdate = doctor["update"] as Record<string, unknown>;
      expect(doctorUpdate["buildIdentity"]).toBeDefined();
      expect(doctor["bootstrap"]).toBeDefined();
      expect(defaultBuildIdentity().semanticVersion).toBe(RUNTIME_VERSION);
    } finally {
      log.mockRestore();
    }
  });
});
