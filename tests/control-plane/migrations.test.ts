import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { DEFAULT_MIGRATIONS, openMigratedDatabase } from "../../src/storage/migrations.js";
import { controlPlanePaths } from "../../src/storage/paths.js";
import { SCHEMA_V1_CHECKSUM, SCHEMA_V1_SQL } from "../../src/storage/schema-v1.js";
import { SCHEMA_V2_CHECKSUM } from "../../src/storage/schema-v2.js";
import { writePrivateTextAtomically } from "../../src/storage/private-files.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane migrations", () => {
  it("applies version 1 and refuses a failing follow-on migration by restoring the prior schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-migrate-"));
    directories.push(directory);
    const created = await ControlPlaneStore.open(directory);
    created.createProvider({ name: "kept", integrationMode: "direct" }, "system");
    created.close();

    await expect(openMigratedDatabase(directory, [
      ...DEFAULT_MIGRATIONS,
      { version: 99, checksum: "deadbeef", sql: "CREATE TABLE broken (id TEXT PRIMARY KEY);\nNOT VALID SQL" },
    ])).rejects.toThrow("prior schema restored");

    const restored = await ControlPlaneStore.open(directory);
    try {
      expect(restored.listProviders().map((item) => item.name)).toEqual(["kept"]);
      expect(restored.database.prepare("SELECT name FROM sqlite_master WHERE name = 'broken'").get()).toBeUndefined();
    } finally {
      restored.close();
    }
  });

  it("recovers an interrupted migration from a verified backup marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-recover-"));
    directories.push(directory);
    const created = await ControlPlaneStore.open(directory);
    created.createProvider({ name: "prior", integrationMode: "direct" }, "system");
    created.close();

    const paths = controlPlanePaths(directory);
    const backupPath = join(paths.backups, "prior.sqlite");
    const { copyFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    await copyFile(paths.database, backupPath);
    const backupHash = createHash("sha256").update(await readFile(backupPath)).digest("hex");
    await writeFile(paths.database, "corrupt-partial-migration", "utf8");
    await writePrivateTextAtomically(paths.marker, `${JSON.stringify({
      fromVersion: 1,
      toVersion: 2,
      backupPath,
      backupHash,
    })}\n`);

    const recovered = await ControlPlaneStore.open(directory);
    try {
      expect(recovered.listProviders().map((item) => item.name)).toEqual(["prior"]);
    } finally {
      recovered.close();
    }
  });

  it("takes a stale migration lock and still restores an interrupted marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-stale-lock-"));
    directories.push(directory);
    const created = await ControlPlaneStore.open(directory);
    created.createProvider({ name: "prior", integrationMode: "direct" }, "system");
    created.close();

    const paths = controlPlanePaths(directory);
    const { copyFile, readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const backupPath = join(paths.backups, "prior.sqlite");
    await copyFile(paths.database, backupPath);
    const backupHash = createHash("sha256").update(await readFile(backupPath)).digest("hex");
    await writeFile(paths.database, "corrupt-partial-migration", "utf8");
    await writePrivateTextAtomically(paths.marker, `${JSON.stringify({
      fromVersion: 1,
      toVersion: 2,
      backupPath,
      backupHash,
    })}\n`);
    await writePrivateTextAtomically(paths.lock, `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000099",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner: { pid: 999_999, processStartedAt: "2026-08-13T00:00:00.000Z" },
    })}\n`);

    const recovered = await ControlPlaneStore.open(directory);
    try {
      expect(recovered.listProviders().map((item) => item.name)).toEqual(["prior"]);
    } finally {
      recovered.close();
    }
  });

  it("records the schema checksum for the applied revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-checksum-"));
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    try {
      const v1 = store.database.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum: string };
      const v2 = store.database.prepare("SELECT checksum FROM schema_migrations WHERE version = 2").get() as { checksum: string };
      expect(v1.checksum).toBe(SCHEMA_V1_CHECKSUM);
      expect(v2.checksum).toBe(SCHEMA_V2_CHECKSUM);
    } finally {
      store.close();
    }
  });

  it("rebuilds global account uniqueness into provider-scoped uniqueness and keeps valid accounts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-account-unique-"));
    directories.push(directory);
    const legacySql = SCHEMA_V1_SQL
      .replace(",\n  UNIQUE (provider_id, pseudonym)\n", "\n")
      .replace("  pseudonym TEXT NOT NULL,\n", "  pseudonym TEXT NOT NULL UNIQUE,\n");
    const { createHash } = await import("node:crypto");
    const database = await openMigratedDatabase(directory, [{
      version: 1,
      checksum: createHash("sha256").update(legacySql).digest("hex"),
      sql: legacySql,
    }]);
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      "INSERT INTO providers (id, name, integration_mode, enabled, version, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)",
    ).run("11111111-1111-4111-8111-111111111111", "codex", "oauth", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    database.prepare(
      "INSERT INTO providers (id, name, integration_mode, enabled, version, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)",
    ).run("22222222-2222-4222-8222-222222222222", "claude", "oauth", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    database.prepare(
      "INSERT INTO accounts (id, pseudonym, provider_id, credential_handle, credential_generation, state, quota_class, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'ready', 'healthy', 1, ?, ?)",
    ).run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "acct-kept", "11111111-1111-4111-8111-111111111111", "cred-kept", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    database.exec("COMMIT");
    database.close();

    const upgraded = await ControlPlaneStore.open(directory);
    try {
      const kept = upgraded.listAccounts().find((account) => account.pseudonym === "acct-kept");
      expect(kept?.providerId).toBe("11111111-1111-4111-8111-111111111111");
      const cloned = upgraded.createAccount({
        pseudonym: "acct-kept",
        providerId: "22222222-2222-4222-8222-222222222222",
        credentialHandle: "cred-claude",
      }, "cli");
      expect(cloned.pseudonym).toBe("acct-kept");
      expect(cloned.providerId).toBe("22222222-2222-4222-8222-222222222222");
      expect(() => upgraded.createAccount({
        pseudonym: "acct-kept",
        providerId: "11111111-1111-4111-8111-111111111111",
        credentialHandle: "cred-dup",
      }, "cli")).toThrow("account already exists for this provider");
    } finally {
      upgraded.close();
    }
  });
});
