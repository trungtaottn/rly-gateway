import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readInstallation, readInstallationPointer } from "../storage/installation.js";
import { RLY_STATE_DIRECTORY_NAME } from "../storage/paths.js";
import { loadConfig } from "./load-config.js";
import { gatewayConfigSchema, type GatewayConfig } from "./schema.js";

export type UserConfigSource = "explicit" | "installation" | "defaults" | "cwd";

export type ResolvedUserConfig = Readonly<{
  config: GatewayConfig;
  /** Path the config was loaded from; undefined when schema defaults are used. */
  configPath: string | undefined;
  source: UserConfigSource;
  /** True when a `~/.rly/installation.json` record exists (post-`rly init`). */
  initialized: boolean;
  home: string;
}>;

const DEFAULT_DEV_CONFIG = "gateway.config.toml";

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultUserConfig(): GatewayConfig {
  return gatewayConfigSchema.parse({ schemaVersion: 1, gateway: {} });
}

/**
 * Resolves the configuration for the user-facing control plane. The normal
 * installed path is the durable `~/.rly/installation.json` record written by
 * `rly init` (a full record, or a pointer to a custom dataDirectory). Explicit
 * `--config` and the CWD file remain explicit dev/operator paths only.
 */
export async function resolveUserConfig(options: Readonly<{
  home?: string;
  cwd?: string;
  explicit?: string;
}>): Promise<ResolvedUserConfig> {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  if (options.explicit !== undefined) {
    const path = resolve(options.explicit);
    return { config: await loadConfig(path), configPath: path, source: "explicit", initialized: false, home };
  }
  const pointer = await readInstallationPointer(home);
  const installation = await readInstallation(join(home, RLY_STATE_DIRECTORY_NAME));
  if (pointer !== undefined && installation === undefined) {
    throw new Error("RLY installation pointer at ~/.rly refers to a missing data directory; restore the control plane or re-run `rly init`");
  }
  if (installation !== undefined) {
    const recorded = installation.configPath;
    if (await isReadableFile(recorded)) {
      return { config: await loadConfig(recorded), configPath: recorded, source: "installation", initialized: true, home };
    }
    // The recorded file is gone; the schema defaults are the normal contract.
    // If the runtime used custom ports, inspection surfaces an actionable error.
    return { config: defaultUserConfig(), configPath: undefined, source: "defaults", initialized: true, home };
  }
  const devPath = resolve(cwd, DEFAULT_DEV_CONFIG);
  if (await isReadableFile(devPath)) {
    return { config: await loadConfig(devPath), configPath: devPath, source: "cwd", initialized: false, home };
  }
  throw new Error("RLY is not initialized; run `rly init` first, or pass --config <path> to use an explicit configuration");
}
