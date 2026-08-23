import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ControlPlaneStore } from "../control-plane/store.js";
import { loadConfig } from "../config/load-config.js";
import type { GatewayConfig } from "../config/schema.js";
import { RUNTIME_VERSION } from "../runtime/gateway-attestation.js";
import {
  bootstrapServiceDefinition,
  ensureInitialActiveDeployment,
  resolveActiveDeployment,
  writeBootstrapScript,
  type EnsureInitialDeploymentOptions,
} from "../runtime/bootstrap.js";
import { inspectRuntimeGateway, type RuntimeInspection } from "../runtime/gateway-lifecycle.js";
import { createServiceManager } from "../service-manager/index.js";
import {
  reconcileDefinition,
  type DefinitionReconciliation,
} from "../service-manager/reconcile.js";
import type { ServiceManagerAdapter, ServiceDefinitionInput } from "../service-manager/types.js";
import { persistUserInstallation, readInstallation } from "../storage/installation.js";
import { LOG_DIRECTORY, resolveDefaultControlPlaneDirectory, SERVICE_LOG_NAME } from "../storage/paths.js";

export type InitDependencies = Readonly<{
  loadConfig?: typeof loadConfig;
  createServiceManager?: (input: Parameters<typeof createServiceManager>[0]) => ServiceManagerAdapter;
  openControlPlane?: (directory: string) => Promise<unknown>;
  waitForReadiness?: (config: GatewayConfig, directory?: string) => Promise<RuntimeInspection>;
  home?: string;
  /** Test seam: package root whose tree becomes the initial active deployment. */
  packageRoot?: string;
  ensureInitialActiveDeployment?: (controlPlaneDirectory: string, options?: EnsureInitialDeploymentOptions) => Promise<{ created: boolean; artifactId: string }>;
}>;

const READINESS_POLL_MS = 250;
const READINESS_TIMEOUT_MS = 15_000;

async function defaultOpenControlPlane(directory: string): Promise<unknown> {
  await ControlPlaneStore.open(directory);
  return undefined;
}

async function defaultWaitForReadiness(config: GatewayConfig, directory?: string): Promise<RuntimeInspection> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    const state = await inspectRuntimeGateway(config, directory);
    if (state.state === "attested-compatible" && state.resident) return state;
    if (state.state === "occupied-foreign") return state;
    if (Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
  }
}

/**
 * `rly init` bootstraps the per-user installation on the stable #94 contract:
 * it settles the durable ~/.rly home, installs the RLY-owned bootstrap
 * launcher, establishes the initial committed `active` deployment from the
 * installed runtime tree (idempotent — a valid committed deployment is never
 * rewritten), registers/repairs the per-user service against the bootstrap
 * (never `dist/cli/init.js`, never an incidental Node path), starts it, and
 * waits for the resident runtime to come up attested and compatible. Running
 * it again repairs/validates rather than creating duplicate services or
 * touching provider/account configuration.
 */
export async function runInit(configPath: string, dependencies: InitDependencies = {}): Promise<number> {
  const home = dependencies.home ?? homedir();
  const config = await (dependencies.loadConfig ?? loadConfig)(configPath);
  const resolution = await resolveDefaultControlPlaneDirectory(home);
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? resolution.directory;
  try {
    await (dependencies.openControlPlane ?? defaultOpenControlPlane)(controlPlaneDirectory);
    await resolution.commit();
  } catch (error) {
    await resolution.rollback();
    throw error;
  }

  const manager = (dependencies.createServiceManager ?? createServiceManager)({
    home,
    // macOS LaunchAgent: service stdout/stderr land in the durable RLY log
    // directory and the process runs from the durable home. Paths only;
    // never credentials, environment values, or account identity.
    logPath: join(controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    workingDirectory: controlPlaneDirectory,
  });
  const absoluteConfigPath = resolve(configPath);
  const record = {
    schemaVersion: 1 as const,
    version: RUNTIME_VERSION,
    configPath: absoluteConfigPath,
    platform: manager.isSupported() ? manager.platform : "unsupported",
    serviceName: manager.serviceName,
    registeredAt: new Date().toISOString(),
  };

  if (!manager.isSupported()) {
    await persistUserInstallation(home, controlPlaneDirectory, record);
    console.log(JSON.stringify({
      ok: true,
      initialized: true,
      service: { registered: false, platform: manager.platform },
      message: `per-user service registration is not supported on platform ${manager.platform}; the durable home is ready`,
    }));
    return 0;
  }

  // Stable bootstrap contract (#94): install the RLY-owned launcher and make
  // sure a committed `active` deployment exists so the service can never point
  // at dist/cli/init.js or depend on the Node that invoked this init.
  const bootstrapPath = await writeBootstrapScript(controlPlaneDirectory);
  await (dependencies.ensureInitialActiveDeployment ?? ensureInitialActiveDeployment)(
    controlPlaneDirectory,
    { ...(dependencies.packageRoot === undefined ? {} : { packageRoot: dependencies.packageRoot }) },
  );

  const definition: ServiceDefinitionInput = bootstrapServiceDefinition(
    controlPlaneDirectory,
    absoluteConfigPath,
    join(controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
  );
  // Reconciliation: detect missing/stale/path-drifted/legacy definitions and
  // repair them idempotently (never duplicates, never provider config).
  let reconciliation: DefinitionReconciliation;
  try {
    reconciliation = await reconcileDefinition(manager, definition);
  } catch (error) {
    reconciliation = {
      status: "failed",
      expectedRevision: "",
      changed: true,
      message: error instanceof Error ? error.message : "service definition reconciliation failed",
    };
  }
  if (reconciliation.status === "failed") {
    console.log(JSON.stringify({
      ok: false,
      initialized: false,
      service: {
        registered: true,
        platform: manager.platform,
        serviceName: manager.serviceName,
        reconciliation: { status: reconciliation.status, message: reconciliation.message },
      },
      error: "the per-user service definition could not be repaired; inspect the service log",
    }));
    return 1;
  }

  await manager.start();
  await persistUserInstallation(home, controlPlaneDirectory, {
    ...record,
    bootstrapPath,
    ...(reconciliation.revision === undefined ? {} : { definitionRevision: reconciliation.revision }),
  });

  const state = await (dependencies.waitForReadiness ?? defaultWaitForReadiness)(config);
  if (state.state !== "attested-compatible") {
    console.log(JSON.stringify({
      ok: false,
      initialized: false,
      service: {
        registered: true,
        platform: manager.platform,
        serviceName: manager.serviceName,
        reconciliation: { status: reconciliation.status, migrated: reconciliation.migrated === true },
      },
      runtime: { state: state.state },
      error: "resident runtime did not become ready; inspect `rly gateway status` and the service log",
    }));
    return 1;
  }
  const existing = await readInstallation(controlPlaneDirectory);
  const active = await resolveActiveDeployment(controlPlaneDirectory).catch(() => undefined);
  console.log(JSON.stringify({
    ok: true,
    initialized: true,
    service: {
      registered: true,
      platform: manager.platform,
      serviceName: manager.serviceName,
      bootstrap: bootstrapPath,
      reconciliation: {
        status: reconciliation.status,
        ...(reconciliation.revision === undefined ? {} : { revision: reconciliation.revision }),
        ...(reconciliation.migrated === undefined ? {} : { migrated: reconciliation.migrated }),
      },
    },
    runtime: {
      state: state.state,
      resident: true,
      instanceId: state.instanceId,
      runtimeVersion: state.runtimeVersion ?? RUNTIME_VERSION,
      ...(active === undefined ? {} : { artifactId: active.artifactId }),
    },
    home: controlPlaneDirectory,
    reinitialized: existing !== undefined,
  }));
  return 0;
}
