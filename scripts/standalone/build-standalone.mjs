#!/usr/bin/env node
// RLY standalone runtime artifact builder (#35).
//
// Produces the RLY-owned primary distribution artifact for one or more
// supported/experimental targets: compiled runtime (dist) + bundled runtime
// dependencies (prod node_modules, symlinks dereferenced) + bundled pinned
// Node runtime + LICENSE + exact build identity (#94) + artifact
// metadata, enforced by the positive allowlist. Output is a deterministic
// tarball plus sha256 and a manifest; nothing is ever committed to git.
//
// Usage:
//   node scripts/standalone/build-standalone.mjs [--target <t>]... [--targets all]
//     [--out <dir>] [--build] [--download | --local-node | --node-path <path>]
//     [--no-smoke] [--source-date-epoch <ts>] [--release-version <v>] [--verbose]
//
//   --build            run `pnpm build` first (default: require dist exists)
//   --download         acquire the pinned Node runtime from nodejs.org (default)
//   --local-node       bundle the local node binary (dev/smoke; records its real version)
//   --node-path <p>    bundle a specific node binary
//   --no-smoke         skip `rly --version` smoke (always skipped when the host
//                      cannot execute the target's binary)
//   --source-date-epoch <ts>  fixed mtime for deterministic tarballs (default 0)
//   --release-version <v>     same as RLY_RELEASE_VERSION (canonical version input)

import process from "node:process";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  ALL_TARGETS,
  assembleStandaloneArtifact,
  copyEntryDeref,
  exactGitTag,
  hostTarget,
  resolveNodeDistributionRoot,
  pinnedNodeVersion,
  readJson,
  resolveReleaseVersion,
  sha256Of,
  smokeRun,
  tarballForTree,
  targetStatus,
  verifyArtifactDirectory,
  writeJson,
} from "./pack.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE_DIST_BASE = "https://nodejs.org/dist";
const PINNED = await pinnedNodeVersion();

function parseArgs(argv) {
  const options = {
    targets: [],
    out: join(ROOT, "out", "standalone"),
    build: false,
    nodeMode: "download",
    nodePath: undefined,
    smoke: true,
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH ?? 0),
    releaseVersion: process.env.RLY_RELEASE_VERSION ?? process.env.RELEASE_VERSION,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--target": options.targets.push(value()); break;
      case "--targets": {
        const targets = value();
        if (targets === "all") options.targets = [...ALL_TARGETS];
        else options.targets = targets.split(",").map((item) => item.trim()).filter(Boolean);
        break;
      }
      case "--out": options.out = value(); break;
      case "--build": options.build = true; break;
      case "--download": options.nodeMode = "download"; break;
      case "--local-node": options.nodeMode = "local"; break;
      case "--node-path": options.nodeMode = "path"; options.nodePath = value(); break;
      case "--no-smoke": options.smoke = false; break;
      case "--source-date-epoch": options.sourceDateEpoch = Number(value()); break;
      case "--release-version": options.releaseVersion = value(); break;
      case "--verbose": options.verbose = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.targets.length === 0) options.targets = [hostTarget() ?? "linux-x64"];
  for (const target of options.targets) targetStatus(target);
  return options;
}

function run(command, args, { cwd = ROOT, stdio = "inherit" } = {}) {
  return execFileSync(command, args, { cwd, stdio, encoding: "utf8" });
}

async function requireBuild() {
  const entrypoint = join(ROOT, "dist", "cli", "main.js");
  try {
    await readFile(entrypoint);
  } catch {
    throw new Error(
      `dist/cli/main.js is missing; run \`pnpm build\` first (or pass --build). A standalone artifact must be built from a clean compiled tree.`,
    );
  }
}

async function installProdDependencies(staging) {
  // Deterministic prod install from the frozen lockfile into a scratch dir,
  // then copy the real dependency tree (symlinks dereferenced, pnpm metadata
  // dropped) into staging so no store path ever reaches the artifact.
  const scratch = await mkdtemp(join(tmpdir(), "rly-prod-deps-"));
  try {
    await cp(join(ROOT, "package.json"), join(scratch, "package.json"));
    await cp(join(ROOT, "pnpm-lock.yaml"), join(scratch, "pnpm-lock.yaml"));
    run("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], { cwd: scratch });
    await copyEntryDeref(join(scratch, "node_modules"), join(staging, "node_modules"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function prepareRuntimeStaging() {
  const staging = await mkdtemp(join(tmpdir(), "rly-runtime-staging-"));
  await cp(join(ROOT, "package.json"), join(staging, "package.json"));
  await cp(join(ROOT, "LICENSE"), join(staging, "LICENSE"));
  await cp(join(ROOT, "dist"), join(staging, "dist"), { recursive: true });
  await installProdDependencies(staging);
  return staging;
}
async function downloadNode(target) {
  const { nodeDistFor } = targetStatus(target);
  const distName = nodeDistFor(PINNED);
  const url = `${NODE_DIST_BASE}/v${PINNED}/${distName}`;
  const shasumsUrl = `${NODE_DIST_BASE}/v${PINNED}/SHASUMS256.txt`;
  const scratch = await mkdtemp(join(tmpdir(), "rly-node-download-"));
  try {
    const [tarball, shasums] = await Promise.all([
      globalThis.fetch(url).then((response) => {
        if (!response.ok) throw new Error(`node download failed: ${response.status} ${response.statusText} for ${url}`);
        return response.arrayBuffer();
      }),
      globalThis.fetch(shasumsUrl).then((response) => {
        if (!response.ok) throw new Error(`node SHASUMS download failed: ${response.status} for ${shasumsUrl}`);
        return response.text();
      }),
    ]);
    const expected = shasums.split("\n").find((line) => line.includes(distName))?.split(/\s+/)[0];
    if (expected === undefined) throw new Error(`no SHASUMS256 entry for ${distName}`);
    const actual = sha256Of(Buffer.from(tarball));
    if (actual !== expected) {
      throw new Error(`node dist sha256 mismatch for ${distName}: expected ${expected}, got ${actual}`);
    }
    const archive = join(scratch, distName);
    await writeFile(archive, Buffer.from(tarball));
    const extract = join(scratch, "extracted");
    await mkdir(extract);
    run("tar", ["-xzf", archive, "-C", extract]);
    const distributionRoot = await resolveNodeDistributionRoot(extract);
    const nodeBin = join(distributionRoot, "bin", "node");
    const actualVersion = run(nodeBin, ["--version"], { stdio: "pipe" }).trim();
    if (actualVersion !== `v${PINNED}`) {
      throw new Error(`extracted node version ${actualVersion} != pinned v${PINNED}`);
    }
    return {
      bin: nodeBin,
      license: join(distributionRoot, "LICENSE"),
      version: PINNED,
      cleanup: () => rm(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

async function acquireNode(options, target) {
  if (options.nodeMode === "local" || options.nodeMode === "path") {
    const source = options.nodeMode === "path" ? options.nodePath : process.execPath;
    const version = run(source, ["--version"], { stdio: "pipe" }).trim().replace(/^v/, "");
    return { bin: source, license: undefined, version, source: options.nodeMode, cleanup: undefined };
  }
  const downloaded = await downloadNode(target);
  return { ...downloaded, source: "download" };
}

async function assembleArtifact({ staging, target, node, identityMeta, releaseVersion, outDir, sourceDateEpoch, verbose }) {
  const assembled = await assembleStandaloneArtifact({
    runtimeRoot: staging,
    outDir,
    target,
    node,
    identityMeta,
    releaseVersion,
    sourceDateEpoch,
  });
  const { artifactDir, metadata } = assembled;

  const tarName = `rly-${releaseVersion}-${target}.tar.gz`;
  const tarBytes = await tarballForTree(artifactDir, sourceDateEpoch);
  const tarPath = join(outDir, tarName);
  await writeFile(tarPath, tarBytes);
  await writeFile(join(outDir, `${tarName}.sha256`), `${sha256Of(tarBytes)}  ${tarName}\n`);

  if (verbose) process.stdout.write(`built ${tarName} (${metadata.fileCount} files, digest ${metadata.artifactDigest.slice(0, 16)}…)\n`);
  return { name: tarName, sha256: sha256Of(tarBytes), ...metadata };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) {
    run("pnpm", ["build"]);
  }
  await requireBuild();

  const gitTag = exactGitTag(ROOT);
  const packageJson = await readJson(join(ROOT, "package.json"));
  const releaseVersion = resolveReleaseVersion({
    env: { ...process.env, RLY_RELEASE_VERSION: options.releaseVersion },
    gitTag,
    packageVersion: packageJson.version,
  });

  const distBuildMeta = await readJson(join(ROOT, "dist", "rly-build.json")).catch(() => undefined);
  if (distBuildMeta === undefined) {
    throw new Error("dist/rly-build.json is missing; run `pnpm build` so the artifact consumes the #94 exact build identity");
  }
  if (distBuildMeta.semanticVersion !== releaseVersion) {
    throw new Error(
      `build identity split: dist/rly-build.json semanticVersion ${distBuildMeta.semanticVersion} != resolved release version ${releaseVersion}; ` +
        `rebuild with the same version input (RLY_RELEASE_VERSION) so package.json/tag/runtime identity never diverge`,
    );
  }

  const staging = await prepareRuntimeStaging();
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const host = hostTarget();
  const results = [];
  try {
    for (const target of options.targets) {
      const node = await acquireNode(options, target);
      let result;
      try {
        result = await assembleArtifact({
          staging,
          target,
          node,
          identityMeta: distBuildMeta,
          releaseVersion,
          outDir,
          sourceDateEpoch: options.sourceDateEpoch,
          verbose: options.verbose,
        });
      } finally {
        await node.cleanup?.();
      }
      const verification = await verifyArtifactDirectory(join(outDir, `rly-${releaseVersion}-${target}`), {
        target,
        expectedVersion: releaseVersion,
      });
      if (!verification.ok) {
        throw new Error(`verification failed for ${target}:\n${verification.errors.join("\n")}`);
      }
      if (options.smoke && host === target) {
        const identity = await smokeRun(join(outDir, `rly-${releaseVersion}-${target}`));
        if (identity.version !== releaseVersion) {
          throw new Error(`smoke identity version ${identity.version} != ${releaseVersion} for ${target}`);
        }
        result.smoke = { status: "passed", command: "rly --version" };
      } else if (options.smoke && host !== target) {
        result.smoke = { status: "skipped", reason: `host ${host} cannot execute ${target} binaries` };
      }
      results.push(result);
    }
    const commitRevision = distBuildMeta.commitRevision;
    const manifest = {
      artifactSchemaVersion: 1,
      releaseVersion,
      commitRevision,
      buildId: distBuildMeta.buildId,
      releaseChannel: distBuildMeta.releaseChannel,
      sourceDateEpoch: options.sourceDateEpoch,
      allowlistVersion: 1,
      artifacts: results,
    };
    await writeJson(join(outDir, "artifacts.json"), manifest);
    process.stdout.write(`Standalone artifacts built: ${results.map((result) => result.name).join(", ") || "none"}\n`);
    if (options.verbose) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`standalone artifact build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
