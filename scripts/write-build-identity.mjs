#!/usr/bin/env node
// Generates dist/rly-build.json — the exact build identity (#94) embedded in
// the built tree so /identity, `rly --version`, diagnostics, deployment
// metadata, and update probation all read the SAME build identity. Runs as a
// prebuild step; missing git metadata (release tarballs) falls back to
// explicit unknown markers rather than failing the build.
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const commitRevision = git(["rev-parse", "HEAD"]) ?? "unknown";
const tree = git(["rev-parse", "HEAD^{tree}"]) ?? "unknown";
const releaseChannel = process.env.RLY_RELEASE_CHANNEL ?? "dev";
// Build ID distinguishes rebuilds of the same commit/channel.
const buildId = createHash("sha256")
  .update([commitRevision, tree, releaseChannel, new Date().toISOString()].join("|"))
  .digest("hex")
  .slice(0, 16);

// Canonical version authority (#35): `RLY_RELEASE_VERSION` (release builds,
// e.g. the semantic-release tag) wins over package.json so the built tree's
// semantic version and the release tag/artifact identity never diverge.
const semanticVersion = (process.env.RLY_RELEASE_VERSION ?? "").trim() || packageJson.version;

const meta = {
  semanticVersion,
  commitRevision,
  buildId,
  releaseChannel,
  controlProtocolVersion: 1,
  dataProtocolVersion: 1,
  stateSchemaVersion: await (async () => {
    try {
      const schema = await readFile(join(root, "src/storage/schema-v4.ts"), "utf8");
      const m = schema.match(/SCHEMA_V4_VERSION\s*=\s*(\d+)/);
      return m ? Number(m[1]) : 4;
    } catch { return 4; }
  })(),
};
await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist", "rly-build.json"), `${JSON.stringify(meta, null, 2)}\n`);
