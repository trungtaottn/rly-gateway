import { RUNTIME_VERSION } from "./gateway-attestation.js";
import {
  acquireGateway,
  inspectRuntimeGateway,
  runtimeDirectory,
  type AcquireGatewayOptions,
  type RuntimeInspection,
} from "./gateway-lifecycle.js";
import { RuntimeStore } from "./runtime-store.js";

export type ResidentRuntimeHandle = Readonly<{
  baseUrl: string;
  instanceId: string;
  runtimeVersion: string;
  /** True when a compatible resident runtime was already running (no-op start). */
  alreadyRunning: boolean;
  /** Closes both the gateway and management listeners owned by this process. */
  shutdown: () => Promise<void>;
  stopped: Promise<void>;
}>;

const LAUNCHER_DRAIN_WAIT_MS = 10_000;
const LAUNCHER_DRAIN_POLL_MS = 250;

/**
 * Starts (or idempotently confirms) the per-user resident runtime.
 *
 * A launcher-owned gateway dies when its launcher exits because the servers
 * live inside the launcher process. The resident service therefore only reuses
 * an attested RESIDENT instance; a compatible launcher-owned instance is
 * bounded-waited so the service can take ownership with fresh artifacts, and a
 * foreign listener always fails closed.
 */
export type ResidentRuntimeStartOptions = Readonly<{
  drainTimeoutMs?: number;
}>;

export async function startResidentRuntime(
  options: AcquireGatewayOptions,
  startOptions: ResidentRuntimeStartOptions = {},
): Promise<ResidentRuntimeHandle> {
  const request = options.fetch ?? fetch;
  const deadline = Date.now() + (startOptions.drainTimeoutMs ?? LAUNCHER_DRAIN_WAIT_MS);
  for (;;) {
    const state = await inspectRuntimeGateway(options.config, options.runtimeDirectory, request);
    if (state.state === "attested-compatible" && state.resident) {
      return {
        baseUrl: `http://${options.config.gateway.host}:${String(options.config.gateway.port)}`,
        instanceId: state.instanceId,
        runtimeVersion: state.runtimeVersion ?? RUNTIME_VERSION,
        alreadyRunning: true,
        shutdown: () => Promise.resolve(),
        stopped: Promise.resolve(),
      };
    }
    if (state.state === "attested-compatible") {
      if (Date.now() >= deadline) {
        throw new Error("An active non-resident launcher session holds the gateway; wait for it to exit and run init again");
      }
      await new Promise((resolve) => setTimeout(resolve, LAUNCHER_DRAIN_POLL_MS));
      continue;
    }
    if (state.state === "occupied-foreign") {
      throw new Error("Configured gateway or management port is occupied by a foreign listener; refusing to start the resident service");
    }
    if (state.state === "attested-incompatible") {
      throw new Error("Configured gateway listener is attested but incompatible; align the configuration before starting the resident service");
    }
    // not-running or stale-record: acquire starts fresh and recovers stale artifacts.
    const handle = await acquireGateway({ ...options, resident: true });
    if (handle.shutdown === undefined || handle.stopped === undefined) {
      // Raced with a launcher taking ownership: drop our lease and drain again.
      await handle.release().catch(() => undefined);
      continue;
    }
    return {
      baseUrl: handle.baseUrl,
      instanceId: handle.instanceId,
      runtimeVersion: handle.runtimeVersion ?? RUNTIME_VERSION,
      alreadyRunning: false,
      shutdown: handle.shutdown,
      stopped: handle.stopped,
    };
  }
}

export type StopResidentRuntimeResult = Readonly<{ state: "stopped" | "not-running" }>;

export type StopResidentRuntimeOptions = Readonly<{
  directory?: string;
  request?: typeof fetch;
  timeoutMs?: number;
}>;

const STOP_POLL_MS = 200;

/**
 * Explicit service stop: verifies the instance is attested (never sends the
 * instance secret to a foreign listener), requests the authenticated in-process
 * shutdown, then bounded-waits for the listener to disappear. No process is
 * signaled from port occupancy alone.
 */
export async function stopResidentRuntime(
  config: AcquireGatewayOptions["config"],
  options: StopResidentRuntimeOptions = {},
): Promise<StopResidentRuntimeResult> {
  const request = options.request ?? fetch;
  const state = await inspectRuntimeGateway(config, options.directory, request);
  if (state.state === "not-running" || state.state === "stale-record") return { state: "not-running" };
  if (state.state !== "attested-compatible") {
    throw new Error("Configured gateway or management port is not owned by an attested RLY runtime; refusing to stop it");
  }
  if (!state.resident) {
    throw new Error("The resident service is not running; an active launcher session holds the gateway, so it is left untouched");
  }
  const store = new RuntimeStore(options.directory ?? runtimeDirectory(config.gateway.port));
  const secret = await store.readInstanceSecret();
  if (secret === undefined) {
    throw new Error("Instance secret is unavailable; refusing to stop an unattested listener");
  }
  const baseUrl = `http://${config.gateway.host}:${String(config.gateway.port)}`;
  const response = await request(`${baseUrl}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(750),
  });
  if (!response.ok) throw new Error(`Gateway shutdown request failed (${String(response.status)})`);
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    // Shutdown removes instance artifacts while we poll; a half-removed store
    // read is a transient race, not a foreign listener.
    let current: RuntimeInspection;
    try {
      current = await inspectRuntimeGateway(config, options.directory, request);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
      continue;
    }
    if (current.state === "not-running" || current.state === "stale-record") return { state: "stopped" };
    if (Date.now() >= deadline) {
      throw new Error("Gateway did not stop within the bounded shutdown window");
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
}
