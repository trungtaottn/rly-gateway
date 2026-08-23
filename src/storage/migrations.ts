import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { acquireOwnershipLock, OwnershipLockError } from "./ownership-lock.js";
import { SCHEMA_V1_CHECKSUM, SCHEMA_V1_SQL, SCHEMA_VERSION, assertSchemaHasNoSecretColumns } from "./schema-v1.js";
import { SCHEMA_V2_CHECKSUM, SCHEMA_V2_SQL, SCHEMA_V2_VERSION } from "./schema-v2.js";
import { SCHEMA_V4_CHECKSUM, SCHEMA_V4_SQL, SCHEMA_V4_VERSION } from "./schema-v4.js";
import { controlPlanePaths } from "./paths.js";
import {
  chmodPrivateFile,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  readPrivateTextIfPresent,
  removePrivateFileIfPresent,
  writePrivateTextAtomically,
} from "./private-files.js";

export type Migration = Readonly<{
  version: number;
  checksum: string;
  sql: string;
}>;
export const DEFAULT_MIGRATIONS: readonly Migration[] = [
  { version: SCHEMA_VERSION, checksum: SCHEMA_V1_CHECKSUM, sql: SCHEMA_V1_SQL },
  { version: SCHEMA_V2_VERSION, checksum: SCHEMA_V2_CHECKSUM, sql: SCHEMA_V2_SQL },
  { version: SCHEMA_V4_VERSION, checksum: SCHEMA_V4_CHECKSUM, sql: SCHEMA_V4_SQL },
];

type MigrationMarker = Readonly<{
  fromVersion: number;
  toVersion: number;
  backupPath: string;
  backupHash: string;
}>;

export class MigrationError extends Error {
  override name = "MigrationError";
}

export async function openMigratedDatabase(
  directory: string,
  migrations: readonly Migration[] = DEFAULT_MIGRATIONS,
): Promise<DatabaseSync> {
  assertSchemaHasNoSecretColumns(migrations.map((item) => item.sql).join("\n"));
  const paths = controlPlanePaths(directory);
  await ensurePrivateDirectory(paths.directory);
  await ensurePrivateDirectory(paths.backups);
  const lock = await acquireMigrationLock(paths.lock);
  try {
    await recoverInterruptedMigration(paths.database, paths.marker);
    const database = openDatabaseFile(paths.database);
    try {
      await migrateOpenDatabase(database, paths, migrations);
      return database;
    } catch (error) {
      if (database.isOpen) database.close();
      throw error;
    }
  } finally {
    await lock.release();
  }
}

export async function restoreVerifiedBackup(databasePath: string, backupPath: string, expectedHash: string): Promise<void> {
  const actualHash = await hashBinaryFile(backupPath);
  if (actualHash !== expectedHash) {
    throw new MigrationError("migration backup failed verification");
  }
  await copyFile(backupPath, databasePath);
  await chmodPrivateFile(databasePath);
  await removePrivateFileIfPresent(`${databasePath}-wal`);
  await removePrivateFileIfPresent(`${databasePath}-shm`);
  const restoredHash = await hashBinaryFile(databasePath);
  if (restoredHash !== expectedHash) {
    throw new MigrationError("restored database failed verification");
  }
}

function openDatabaseFile(path: string): DatabaseSync {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  void chmodPrivateFile(path).catch(() => undefined);
  return database;
}

async function migrateOpenDatabase(
  database: DatabaseSync,
  paths: ReturnType<typeof controlPlanePaths>,
  migrations: readonly Migration[],
): Promise<void> {
  const current = currentSchemaVersion(database);
  const target = migrations.reduce((max, item) => Math.max(max, item.version), 0);
  if (current === target) return;
  if (current > target) throw new MigrationError("database schema is newer than this binary");
  const backupPath = join(paths.backups, `control-plane.${String(current)}.${stamp()}.sqlite`);
  await backup(database, backupPath);
  await chmodPrivateFile(backupPath);
  const backupHash = await hashBinaryFile(backupPath);
  const pending = migrations.filter((item) => item.version > current).sort((left, right) => left.version - right.version);
  await writeMarker(paths.marker, { fromVersion: current, toVersion: target, backupPath, backupHash });
  try {
    for (const migration of pending) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database.prepare(
          "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
        ).run(migration.version, new Date().toISOString(), migration.checksum);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    }
    if (currentSchemaVersion(database) !== target) {
      throw new MigrationError("migration did not reach the expected schema version");
    }
    await removePrivateFileIfPresent(paths.marker);
  } catch (error) {
    if (database.isOpen) database.close();
    await restoreVerifiedBackup(paths.database, backupPath, backupHash);
    await removePrivateFileIfPresent(paths.marker);
    throw new MigrationError(
      error instanceof Error ? `migration failed; prior schema restored: ${error.message}` : "migration failed; prior schema restored",
    );
  }
}

async function recoverInterruptedMigration(databasePath: string, markerPath: string): Promise<void> {
  const raw = await readPrivateTextIfPresent(markerPath);
  if (raw === undefined) return;
  let marker: MigrationMarker;
  try {
    marker = JSON.parse(raw) as MigrationMarker;
  } catch {
    throw new MigrationError("migration marker is corrupt; refuse to open control-plane data");
  }
  await restoreVerifiedBackup(databasePath, marker.backupPath, marker.backupHash);
  await removePrivateFileIfPresent(markerPath);
}

function currentSchemaVersion(database: DatabaseSync): number {
  const tables = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { present: number } | undefined;
  if (!tables) return 0;
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

async function writeMarker(path: string, marker: MigrationMarker): Promise<void> {
  await writePrivateTextAtomically(path, `${JSON.stringify(marker)}\n`);
}

async function acquireMigrationLock(path: string): Promise<{ release: () => Promise<void> }> {
  try {
    return await acquireOwnershipLock(path, {
      attempts: 40,
      waitMs: 25,
      onLive: "wait",
      identityError: () => new MigrationError("unable to read process identity for migration lock"),
      liveError: () => new MigrationError("control-plane migration lock is held"),
    });
  } catch (error) {
    if (error instanceof OwnershipLockError) throw new MigrationError("control-plane migration lock is held");
    throw error;
  }
}

async function hashBinaryFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const contents = await handle.readFile();
    await handle.chmod(PRIVATE_FILE_MODE).catch(() => undefined);
    return createHash("sha256").update(contents).digest("hex");
  } finally {
    await handle.close();
  }
}

function stamp(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}
