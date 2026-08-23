import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RLY_STATE_DIRECTORY_NAME } from "./paths.js";

export const INSTALLATION_FILE_NAME = "installation.json";

const definitionRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);

const installationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  configPath: z.string().min(1),
  platform: z.enum(["darwin", "linux", "unsupported"]),
  serviceName: z.string().min(1),
  registeredAt: z.iso.datetime(),
  /** #94: stable RLY-owned bootstrap launcher path (never dist/cli/init.js). */
  bootstrapPath: z.string().min(1).optional(),
  /** #94: sha256 revision of the registered service definition. */
  definitionRevision: definitionRevisionSchema.optional(),
});

const installationPointerSchema = z.object({
  dataDirectory: z.string().min(1).refine((value) => isAbsolute(value), "dataDirectory must be an absolute path"),
  configPath: z.string().min(1),
  bootstrapPath: z.string().min(1).optional(),
  definitionRevision: definitionRevisionSchema.optional(),
});

export type InstallationRecord = z.infer<typeof installationRecordSchema>;
export type InstallationPointer = z.infer<typeof installationPointerSchema>;

export class InstallationPointerError extends Error {
  override name = "InstallationPointerError";
}

export function defaultInstallationDirectory(home: string): string {
  return join(home, RLY_STATE_DIRECTORY_NAME);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

/**
 * Writes the secret-free user-installation record atomically inside the
 * durable control-plane home (~/.rly by default). Refuses links and keeps the
 * file at 0600 like every other project-owned artifact.
 */
export async function writeInstallation(directory: string, record: InstallationRecord): Promise<void> {
  installationRecordSchema.parse(record);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const path = join(directory, INSTALLATION_FILE_NAME);
  await writePrivateTextAtomically(path, `${JSON.stringify(record)}\n`);
}

/**
 * Minimal ~/.rly pointer written when the control plane lives elsewhere.
 * Stores only {dataDirectory, configPath, bootstrapPath, definitionRevision}.
 * Refuses to overwrite a full installation record or a pointer to a different root.
 */
export async function writeInstallationPointer(home: string, pointer: InstallationPointer): Promise<void> {
  const parsed = installationPointerSchema.safeParse(pointer);
  if (!parsed.success) {
    throw new InstallationPointerError("installation pointer requires an absolute dataDirectory");
  }
  const defaultDir = defaultInstallationDirectory(home);
  const existingRaw = await readInstallationJson(defaultDir);
  if (existingRaw !== undefined) {
    if (isObjectRecord(existingRaw) && "dataDirectory" in existingRaw) {
      const existing = installationPointerSchema.safeParse(existingRaw);
      if (!existing.success) {
        throw new InstallationPointerError("refusing to overwrite a malformed ~/.rly installation pointer");
      }
      if (!samePath(existing.data.dataDirectory, parsed.data.dataDirectory)) {
        throw new InstallationPointerError("refusing to overwrite ~/.rly installation pointer to a different data directory");
      }
    } else if (installationRecordSchema.safeParse(existingRaw).success) {
      throw new InstallationPointerError("refusing to overwrite the ~/.rly installation record with a pointer");
    } else {
      throw new InstallationPointerError("refusing to overwrite an unreadable ~/.rly installation.json");
    }
  }
  await mkdir(defaultDir, { recursive: true, mode: 0o700 });
  await chmod(defaultDir, 0o700).catch(() => undefined);
  const payload: InstallationPointer = {
    dataDirectory: parsed.data.dataDirectory,
    configPath: parsed.data.configPath,
    ...(parsed.data.bootstrapPath === undefined ? {} : { bootstrapPath: parsed.data.bootstrapPath }),
    ...(parsed.data.definitionRevision === undefined ? {} : { definitionRevision: parsed.data.definitionRevision }),
  };
  await writePrivateTextAtomically(join(defaultDir, INSTALLATION_FILE_NAME), `${JSON.stringify(payload)}\n`);
}

/** Writes the full record at the control-plane root and a ~/.rly pointer when that root is custom. */
export async function persistUserInstallation(
  home: string,
  controlPlaneDirectory: string,
  record: InstallationRecord,
): Promise<void> {
  await writeInstallation(controlPlaneDirectory, record);
  const defaultDir = defaultInstallationDirectory(home);
  if (!samePath(controlPlaneDirectory, defaultDir)) {
    await writeInstallationPointer(home, {
      dataDirectory: resolve(controlPlaneDirectory),
      configPath: record.configPath,
      ...(record.bootstrapPath === undefined ? {} : { bootstrapPath: record.bootstrapPath }),
      ...(record.definitionRevision === undefined ? {} : { definitionRevision: record.definitionRevision }),
    });
  }
}

export async function readInstallationPointer(home: string): Promise<InstallationPointer | undefined> {
  const raw = await readInstallationJson(defaultInstallationDirectory(home));
  if (raw === undefined || !isObjectRecord(raw) || !("dataDirectory" in raw)) return undefined;
  const parsed = installationPointerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InstallationPointerError("malformed ~/.rly installation pointer; dataDirectory must be an absolute path");
  }
  return parsed.data;
}

/** Resolves the durable control-plane directory, following a ~/.rly pointer when present. */
export async function resolveControlPlaneDirectory(home: string): Promise<string> {
  const defaultDir = defaultInstallationDirectory(home);
  const pointer = await readInstallationPointer(home);
  if (pointer === undefined) return defaultDir;
  return resolve(pointer.dataDirectory);
}

export async function readInstallation(directory: string): Promise<InstallationRecord | undefined> {
  const raw = await readInstallationJson(directory);
  if (raw === undefined) return undefined;
  if (isObjectRecord(raw) && "dataDirectory" in raw) {
    const pointer = installationPointerSchema.safeParse(raw);
    if (!pointer.success) {
      throw new InstallationPointerError("malformed installation pointer; dataDirectory must be an absolute path");
    }
    const target = resolve(pointer.data.dataDirectory);
    if (!samePath(target, directory)) {
      // Follow once: the custom root holds the full record, never another pointer.
      return parseInstallationRecord(await readInstallationJson(target));
    }
  }
  return parseInstallationRecord(raw);
}

function parseInstallationRecord(raw: unknown): InstallationRecord | undefined {
  if (raw === undefined) return undefined;
  const parsed = installationRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function readInstallationJson(directory: string): Promise<unknown> {
  const path = join(directory, INSTALLATION_FILE_NAME);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
  try {
    const contents = await handle.readFile({ encoding: "utf8" });
    return JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function writePrivateTextAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${INSTALLATION_FILE_NAME}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    if (isAlreadyExists(error)) throw error;
    throw error;
  }
}
