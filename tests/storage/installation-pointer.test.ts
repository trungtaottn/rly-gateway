import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import {
  InstallationPointerError,
  persistUserInstallation,
  readInstallation,
  readInstallationPointer,
  resolveControlPlaneDirectory,
  writeInstallation,
  writeInstallationPointer,
} from "../../src/storage/installation.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-pointer-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(configPath: string, extra: { bootstrapPath?: string; definitionRevision?: string } = {}) {
  return {
    schemaVersion: 1 as const,
    version: RUNTIME_VERSION,
    configPath,
    platform: "linux" as const,
    serviceName: "rly-gateway",
    registeredAt: new Date().toISOString(),
    ...extra,
  };
}

describe("custom dataDirectory installation pointer", () => {
  it("persists a full record at the custom root and a minimal pointer at ~/.rly", async () => {
    const home = await directory();
    const custom = await directory();
    const configPath = join(home, "gateway.toml");
    const bootstrapPath = join(custom, "bootstrap", "rly-gateway");
    const definitionRevision = "a".repeat(64);
    await persistUserInstallation(home, custom, record(configPath, { bootstrapPath, definitionRevision }));

    const pointerRaw = JSON.parse(await readFile(join(home, ".rly", "installation.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(pointerRaw).sort()).toEqual(["bootstrapPath", "configPath", "dataDirectory", "definitionRevision"]);
    expect(pointerRaw.dataDirectory).toBe(custom);
    expect(pointerRaw.configPath).toBe(configPath);
    expect(pointerRaw.bootstrapPath).toBe(bootstrapPath);
    expect(pointerRaw.definitionRevision).toBe(definitionRevision);

    const full = JSON.parse(await readFile(join(custom, "installation.json"), "utf8")) as { schemaVersion: number; configPath: string };
    expect(full.schemaVersion).toBe(1);
    expect(full.configPath).toBe(configPath);
  });

  it("does not write a pointer when the control plane is ~/.rly", async () => {
    const home = await directory();
    const defaultDir = join(home, ".rly");
    const configPath = join(defaultDir, "gateway.config.toml");
    await persistUserInstallation(home, defaultDir, record(configPath));
    const stored = JSON.parse(await readFile(join(defaultDir, "installation.json"), "utf8")) as { schemaVersion: number; dataDirectory?: string };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.dataDirectory).toBeUndefined();
    expect(await readInstallationPointer(home)).toBeUndefined();
    expect(await resolveControlPlaneDirectory(home)).toBe(defaultDir);
  });

  it("follows the pointer for readInstallation and resolveControlPlaneDirectory", async () => {
    const home = await directory();
    const custom = await directory();
    const configPath = join(home, "gateway.toml");
    await persistUserInstallation(home, custom, record(configPath));
    expect(await resolveControlPlaneDirectory(home)).toBe(custom);
    const followed = await readInstallation(join(home, ".rly"));
    expect(followed?.configPath).toBe(configPath);
    expect(followed?.schemaVersion).toBe(1);
  });

  it("refuses a relative dataDirectory", async () => {
    const home = await directory();
    await expect(writeInstallationPointer(home, {
      dataDirectory: "relative-plane",
      configPath: join(home, "gateway.toml"),
    })).rejects.toBeInstanceOf(InstallationPointerError);
  });

  it("refuses to overwrite a full ~/.rly record with a pointer", async () => {
    const home = await directory();
    const defaultDir = join(home, ".rly");
    await writeInstallation(defaultDir, record(join(defaultDir, "gateway.config.toml")));
    await expect(writeInstallationPointer(home, {
      dataDirectory: await directory(),
      configPath: join(home, "other.toml"),
    })).rejects.toThrow(/refusing to overwrite the ~\/\.rly installation record/);
  });

  it("refuses to retarget an existing pointer", async () => {
    const home = await directory();
    const first = await directory();
    const second = await directory();
    await writeInstallationPointer(home, { dataDirectory: first, configPath: join(home, "a.toml") });
    await expect(writeInstallationPointer(home, {
      dataDirectory: second,
      configPath: join(home, "b.toml"),
    })).rejects.toThrow(/different data directory/);
  });

  it("fails closed on a malformed pointer", async () => {
    const home = await directory();
    await mkdir(join(home, ".rly"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".rly", "installation.json"), `${JSON.stringify({ dataDirectory: "not-absolute", configPath: "/tmp/x.toml" })}\n`, { mode: 0o600 });
    await expect(readInstallationPointer(home)).rejects.toBeInstanceOf(InstallationPointerError);
  });
});
