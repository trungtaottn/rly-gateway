#!/usr/bin/env node
// RLY standalone runtime artifact packaging library (#35).
//
// Pure, deterministic, testable building blocks for the RLY-owned standalone
// runtime artifact contract:
//
//   - positive top-level allowlist + forbidden-marker scan (fail packaging on
//     unexpected files; never ship .git/.env/state/tests/reports/credentials),
//   - exact build/artifact identity consumed from the #94 build identity
//     (`dist/rly-build.json`) plus platform/bundled-node/digest inputs,
//   - deterministic tree digest (same content-addressing rules as the #92
//     immutable store: sorted relative paths + file digests, no symlinks),
//   - deterministic PAX tar + gzip writer (fixed mtime, sorted entries,
//     no owner/absolute paths) so identical inputs => identical bytes,
//   - self-locating `rly` launcher that runs the bundled pinned Node,
//   - artifact verification: allowlist/absence, identity consistency
//     (rly-build.json == rly.json == rly-artifact.json fields), digest
//     recompute, and `rly --version` smoke execution.
//
// No credentials, tokens, prompts, responses, or user content ever enter this
// module or its outputs. Artifact bytes are never committed to git.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const ARTIFACT_SCHEMA_VERSION = 1;
export const ALLOWLIST_VERSION = 1;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Canonical pinned Node runtime version for standalone artifacts (release pin). */
export async function pinnedNodeVersion() {
  const pin = await readJson(join(ROOT, "scripts", "standalone", "node-version.json"));
  if (typeof pin?.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
    throw new Error(`invalid pinned node version in scripts/standalone/node-version.json: ${JSON.stringify(pin.version)}`);
  }
  return pin.version;
}

/**
 * Platform matrix (#35). Every target is EXPLICIT: `supported` targets are
 * built AND smoke-tested on a qualified runner; `experimental` targets are
 * built deterministically (assembly is host-independent) but are not
 * smoke-tested because no qualified runner is provisioned. A target never
 * silently reuses another target's artifact or Node bytes — each target maps
 * to its own Node distribution tarball name.
 */
export const TARGET_MATRIX = Object.freeze({
  "darwin-arm64": {
    nodeDistFor: (version) => `node-v${version}-darwin-arm64.tar.gz`,
    status: "experimental",
    reason: "built deterministically on Linux CI; smoke-testing requires a provisioned macOS arm64 runner",
  },
  "darwin-x64": {
    nodeDistFor: (version) => `node-v${version}-darwin-x64.tar.gz`,
    status: "experimental",
    reason: "built deterministically on Linux CI; smoke-testing requires a provisioned macOS x64 runner",
  },
  "linux-x64": {
    nodeDistFor: (version) => `node-v${version}-linux-x64.tar.gz`,
    status: "supported",
    reason: "built and smoke-tested on the repository Linux CI runner",
  },
  "linux-arm64": {
    nodeDistFor: (version) => `node-v${version}-linux-arm64.tar.gz`,
    status: "experimental",
    reason: "exact-byte gates run on ubuntu-24.04-arm; Stable publication stays linux-x64 until systemd user-manager qualification is accepted",
  },
});

export const ALL_TARGETS = Object.freeze(Object.keys(TARGET_MATRIX));

export function targetStatus(target) {
  const entry = TARGET_MATRIX[target];
  if (entry === undefined) throw new Error(`unknown standalone target: ${target}; expected one of ${ALL_TARGETS.join(", ")}`);
  return entry;
}

/** Host target name for the current machine (e.g. "linux-x64"), or null. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  return TARGET_MATRIX[target] === undefined ? null : target;
}

/** Resolves the single extracted Node distribution root that owns bin/node. */
export async function resolveNodeDistributionRoot(extractDirectory) {
  const entries = await readdir(extractDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(extractDirectory, entry.name);
    const node = await lstat(join(root, "bin", "node")).catch(() => undefined);
    if (node?.isFile()) candidates.push(root);
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Node distribution archive must contain exactly one top-level directory with bin/node; found ${String(candidates.length)} among [${entries.map((entry) => entry.name).sort().join(", ")}]`,
    );
  }
  return candidates[0];
}

/**
 * Positive package allowlist (#35). Top-level entries are exact; only the
 * documented bootstrap/runtime/asset files may exist. Everything else fails
 * packaging.
 */
export const TOP_LEVEL_ALLOWLIST = Object.freeze([
  "rly", // self-locating launcher (0755)
  "bin/", // bundled pinned Node runtime (`node` + `node.LICENSE`)
  "dist/", // compiled runtime (from `pnpm build`)
  "node_modules/", // bundled runtime dependencies (prod install, symlinks dereferenced)
  "package.json", // runtime metadata consumed by the #94 initial deployment
  "LICENSE",
  "rly.json", // release-candidate manifest (#73/#93 candidate contract)
  "rly-build.json", // exact build identity (#94), same bytes as dist/rly-build.json
  "rly-artifact.json", // artifact metadata (platform, bundled node, digest, file list)
]);

/** Inside `bin/` only the bundled node binary and its license notice. */
export const BIN_ALLOWLIST = Object.freeze(["node", "node.LICENSE"]);

/**
 * Forbidden path markers (matched case-insensitively against the full
 * relative path). Any match fails packaging/verification. Deliberately
 * structural (dirs/names), NOT the RLY-owned module vocabulary
 * (`dist/credentials` is compiled runtime code, not leaked secrets).
 */
export const FORBIDDEN_PATH_PATTERNS = Object.freeze([
  /(^|\/)\.git($|\/)/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.rly($|\/)/,
  /(^|\/)\.agent-gateway($|\/)/,
  /(^|\/)plans($|\/)/,
  /(^|\/)tests($|\/)/,
  /(^|\/)coverage($|\/)/,
  /(^|\/)reports($|\/)/,
  /(^|\/)__snapshots__($|\/)/,
  /\.snap$/,
  /\.sqlite$/,
  /\.sqlite-wal$/,
  /\.sqlite-shm$/,
  /\.log$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.DS_Store$/,
  // pnpm metadata files may carry store/absolute paths; never shipped.
  // (`.pnpm` itself stays: it holds the real virtual-store files that some
  // packages resolve through hoisted paths.)
  /(^|\/)\.modules\.yaml$/,
  /(^|\/)\.package-map\.json$/,
  /(^|\/)\.pnpm-workspace-state-v1\.json$/,
  /(^|\/)\.pnpm\/lock\.yaml$/,
]);

/** Secret-content markers applied to RLY-owned artifact files (same rules as the repo privacy scan). */
export const SECRET_CONTENT_PATTERNS = Object.freeze([
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "bearer credential", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { name: "JWT-like credential", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
]);

/**
 * Scans RLY-owned artifact files (dist/ + top-level manifests/notices) for
 * secret content. Third-party node_modules are covered by file-shape checks
 * only (their content is not ours). Returns violations.
 */
export async function checkForSecretContent(root) {
  const violations = [];
  const candidates = (await walkTree(root))
    .filter((entry) => entry.type === "file")
    .filter((entry) => entry.path.startsWith("dist/") || !entry.path.includes("/"))
    .map((entry) => entry.path)
    .filter((path) => !/\.(map)$/.test(path));
  for (const path of candidates) {
    let contents;
    try {
      contents = await readFile(join(root, path), "utf8");
    } catch {
      continue; // binary file
    }
    for (const rule of SECRET_CONTENT_PATTERNS) {
      if (rule.pattern.test(contents)) violations.push(`${path}: ${rule.name} content`);
    }
  }
  return violations.sort();
}

/** pnpm metadata that may carry store/absolute paths; never shipped. */
export const PNPM_METADATA_FILES = Object.freeze([
  ".modules.yaml",
  ".package-map.json",
  ".pnpm-workspace-state-v1.json",
  "lock.yaml",
]);

/**
 * Dependency test artifacts never required at runtime (#35: exclude "tests
 * not required at runtime"): `tests`/`__tests__`/`__snapshots__` directories
 * and `*.test.*` / `*.spec.*` files. Pruned when dereferencing bundled
 * dependencies into the artifact.
 */
export function isTestArtifactPath(name) {
  return /(^|\/)(tests|__tests__|__snapshots__)($|\/)/.test(name) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(name);
}

export function forbiddenMatch(path) {
  const normalized = path.replaceAll("\\", "/");
  const lowered = normalized.toLowerCase();
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(lowered)) return pattern.source;
  }
  return undefined;
}

/** Deterministic path ordering (UTF-16 code unit order; locale-independent). */
export function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Walks a tree and returns every entry as { path, type, target? }. */
export async function walkTree(root, relativePrefix = "") {
  const entries = [];
  const names = (await readdir(join(root, relativePrefix))).sort(comparePath);
  for (const name of names) {
    const path = relativePrefix ? `${relativePrefix}/${name}` : name;
    const details = await lstat(join(root, relativePrefix, name));
    if (details.isSymbolicLink()) {
      entries.push({ path, type: "symlink", target: await readlink(join(root, relativePrefix, name)) });
    } else if (details.isDirectory()) {
      entries.push({ path, type: "dir" });
      entries.push(...await walkTree(root, path));
    } else if (details.isFile()) {
      entries.push({ path, type: "file" });
    } else {
      entries.push({ path, type: "special" });
    }
  }
  return entries;
}

/**
 * Positive allowlist + forbidden-marker enforcement. Returns violations; an
 * empty array means the tree is a legal standalone artifact layout.
 */
export async function checkAllowlist(root) {
  const violations = [];
  const entries = await walkTree(root);
  const topLevel = new Set(entries.map((entry) => entry.path.split("/")[0]));
  for (const name of [...topLevel].sort()) {
    const allowed = TOP_LEVEL_ALLOWLIST.some((item) => item.endsWith("/") ? `${name}/` === item : name === item);
    if (!allowed) violations.push(`unexpected top-level entry: ${name}`);
  }
  for (const entry of entries) {
    if (entry.type === "symlink") {
      // pnpm's node_modules layout uses relative in-tree symlinks (the bundled
      // dependency layout must preserve them or transitive resolution breaks).
      // Anything outside node_modules/, absolute, or escaping the artifact is
      // refused (self-contained, no link attacks).
      if (!entry.path.startsWith("node_modules/")) {
        violations.push(`symlink outside node_modules/: ${entry.path}`);
      } else if (!isSafeRelativeSymlink(entry.path, entry.target ?? "")) {
        violations.push(`unsafe symlink target (${entry.target}) for ${entry.path}`);
      }
    }
    if (entry.type === "special") violations.push(`special file in artifact: ${entry.path}`);
    if (entry.path.startsWith("bin/") && entry.path !== "bin" && !BIN_ALLOWLIST.includes(entry.path.slice("bin/".length))) {
      violations.push(`unexpected file under bin/: ${entry.path}`);
    }
    const marker = forbiddenMatch(entry.path);
    if (marker !== undefined) violations.push(`forbidden path marker (${marker}): ${entry.path}`);
  }
  return violations.sort();
}

/** A symlink target is safe when relative and resolving it stays inside the artifact. */
export function isSafeRelativeSymlink(entryPath, target) {
  if (target === "" || target.startsWith("/") || /^[A-Za-z]:/.test(target)) return false;
  const resolved = resolve("/", dirname(entryPath), target);
  const rootPrefix = "/node_modules";
  return resolved === rootPrefix || resolved.startsWith(`${rootPrefix}${sep}`);
}

/**
 * Deterministic content-addressed digest of a tree (same rules as the #92
 * immutable store): sorted relative paths + per-file sha256, symlinks/special
 * files fail. Computed WITHOUT `rly-artifact.json` (the metadata file that
 * carries this digest) so the digest is stable metadata-free identity.
 */
export async function treeDigest(root, options = {}) {
  const hash = createHash("sha256");
  const entries = await treeFileDigests(root, "", options.exclude ?? []);
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}

async function treeFileDigests(root, relativePath, exclude) {
  const directory = relativePath ? join(root, relativePath) : root;
  const names = await readdir(directory);
  const entries = [];
  for (const name of names.sort(comparePath)) {
    const entryPath = relativePath ? `${relativePath}/${name}` : name;
    if (exclude.includes(entryPath)) continue;
    const details = await lstat(join(directory, name));
    if (details.isSymbolicLink()) {
      // Deterministic symlink identity: the relative link target participates
      // in the digest (pnpm layout); the real content is hashed at its real
      // path under node_modules/.pnpm, never double-counted.
      const target = await readlink(join(directory, name));
      entries.push({ path: entryPath, sha256: `link:${target}` });
      continue;
    }
    if (details.isDirectory()) {
      entries.push(...await treeFileDigests(root, entryPath, exclude));
      continue;
    }
    if (!details.isFile()) {
      throw new Error(`cannot digest artifact with special file: ${entryPath}`);
    }
    const contents = await readFile(join(directory, name));
    entries.push({ path: entryPath, sha256: createHash("sha256").update(contents).digest("hex") });
  }
  return entries;
}

export function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Self-locating POSIX-sh launcher: bundled Node + packaged runtime, no CWD/env dependence. */
export function buildRlyLauncher() {
  return `#!/bin/sh
# RLY standalone runtime launcher (#35).
#
# Self-locating: derives its home from its own path and runs the BUNDLED
# pinned Node runtime against the packaged runtime tree. Normal execution
# never depends on the source repository, the pnpm workspace, a user
# Node/npm/pnpm installation, or the invoking working directory.
set -u

RLY_HOME="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE_BIN="$RLY_HOME/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  echo "RLY: bundled runtime node is missing at $NODE_BIN; reinstall the RLY standalone artifact" >&2
  exit 78
fi

export RLY_BUNDLED_NODE=1
exec "$NODE_BIN" "$RLY_HOME/dist/cli/main.js" "$@"
`;
}

/** Release-candidate manifest (`rly.json`) consumed by the #73/#93 candidate contract. */
export function buildRlyManifest(identityMeta) {
  return {
    product: "rly-gateway",
    version: identityMeta.semanticVersion,
    stateVersion: identityMeta.stateSchemaVersion,
    migrationClass: "backward-compatible-expand",
    buildId: identityMeta.buildId,
    commitRevision: identityMeta.commitRevision,
    releaseChannel: identityMeta.releaseChannel,
    controlProtocolVersion: identityMeta.controlProtocolVersion,
    dataProtocolVersion: identityMeta.dataProtocolVersion,
  };
}

/** Artifact metadata (`rly-artifact.json`) — build identity + platform + node + digest inputs. */
export function buildArtifactMetadata({
  identityMeta,
  target,
  bundledNodeVersion,
  bundledNodeVersionSource,
  artifactDigest,
  fileCount,
  sourceDateEpoch,
  matrixStatus,
  matrixReason,
}) {
  return {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    product: "rly-gateway",
    semanticVersion: identityMeta.semanticVersion,
    commitRevision: identityMeta.commitRevision,
    buildId: identityMeta.buildId,
    releaseChannel: identityMeta.releaseChannel,
    controlProtocolVersion: identityMeta.controlProtocolVersion,
    dataProtocolVersion: identityMeta.dataProtocolVersion,
    stateSchemaVersion: identityMeta.stateSchemaVersion,
    targetPlatform: target,
    targetStatus: matrixStatus,
    targetStatusReason: matrixReason,
    bundledNodeVersion,
    bundledNodeVersionSource,
    artifactDigest,
    fileCount,
    sourceDateEpoch,
    allowlistVersion: ALLOWLIST_VERSION,
    // Two artifacts with different bytes cannot claim the same exact identity:
    // the digest is over the exact tree bytes and participates in the #94
    // exact identity comparison when the runtime serves this artifact.
    digestInputs: ["sorted-relative-path", "file-sha256", "rly-artifact.json-excluded"],
  };
}

/**
 * Canonical release version resolution (#35) — removes the package.json
 * `0.1.0` vs release-tag ambiguity. Precedence:
 *   1. `RLY_RELEASE_VERSION` (explicit release build input),
 *   2. `RELEASE_VERSION` (generic CI input),
 *   3. exact git tag on HEAD (strip leading `v`),
 *   4. `package.json` version (dev fallback).
 */
export function resolveReleaseVersion({ env = {}, gitTag, packageVersion }) {
  const explicit = env["RLY_RELEASE_VERSION"] ?? env["RELEASE_VERSION"];
  if (explicit !== undefined && explicit !== "") return explicit.trim();
  if (gitTag !== undefined && gitTag !== "") return gitTag.replace(/^v/, "").trim();
  if (packageVersion === undefined || packageVersion === "") {
    throw new Error("cannot resolve release version: no RLY_RELEASE_VERSION, git tag, or package.json version");
  }
  return packageVersion;
}

export function exactGitTag(cwd = ROOT) {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copies a bundled-dependency tree into the artifact. pnpm's relative in-tree
 * symlinks are PRESERVED (dereferencing them breaks transitive resolution);
 * absolute/escaping symlinks, pnpm metadata files, and dependency test
 * artifacts are refused/skipped. Cycle-safe via a visited-realpath set for
 * the real-file copies under the virtual store.
 */
export async function copyEntryDeref(source, target, visited = new Set()) {
  const details = await lstat(source).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (details === undefined) return;
  if (details.isSymbolicLink()) {
    const targetPath = await readlink(source);
    if (targetPath.startsWith("/") || /^[A-Za-z]:/.test(targetPath)) {
      throw new Error(`refusing absolute dependency symlink in artifact: ${source} -> ${targetPath}`);
    }
    const resolved = await realpath(source);
    const key = `${source}\0${resolved}`;
    if (visited.has(key)) return;
    visited.add(key);
    await mkdir(dirname(target), { recursive: true });
    await symlink(targetPath, target);
    return;
  }
  if (details.isDirectory()) {
    await mkdir(target, { recursive: true });
    const children = await readdir(source);
    for (const child of children.sort(comparePath)) {
      // pnpm metadata, executable shims (.bin embeds absolute store paths),
      // and dependency test artifacts never ship.
      if (PNPM_METADATA_FILES.includes(child) || child === ".bin" || isTestArtifactPath(child)) continue;
      await copyEntryDeref(join(source, child), join(target, child), visited);
    }
    return;
  }
  if (details.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    const contents = await readFile(source);
    await writeFile(target, contents);
    return;
  }
  throw new Error(`cannot copy special file into artifact: ${source}`);
}

/** Deterministic PAX tar writer: sorted entries, fixed mtime, uid/gid 0, no names. */
export function buildTarBytes(entries, sourceDateEpoch) {
  const mtime = Math.floor(sourceDateEpoch);
  const blocks = [];
  const pushHeader = (header) => {
    if (header.length !== 512) throw new Error("tar header must be 512 bytes");
    blocks.push(header);
  };
  for (const entry of entries) {
    const path = entry.path.replaceAll("\\", "/");
    const typeflag = entry.type === "dir" ? "5" : entry.type === "symlink" ? "2" : "0";
    const size = entry.type === "dir" || entry.type === "symlink" ? 0 : entry.size;
    const linkname = entry.type === "symlink" ? (entry.linkname ?? "") : "";
    const truncated = Buffer.from(path, "utf8").subarray(0, 100).toString("utf8");
    const truncatedLink = Buffer.from(linkname, "utf8").subarray(0, 100).toString("utf8");
    if (Buffer.byteLength(path, "utf8") > 100 || truncated !== path ||
        (linkname !== "" && (Buffer.byteLength(linkname, "utf8") > 100 || truncatedLink !== linkname))) {
      let paxBody = paxRecord("path", path);
      if (linkname !== "" && (Buffer.byteLength(linkname, "utf8") > 100 || truncatedLink !== linkname)) {
        paxBody += paxRecord("linkpath", linkname);
      }
      const pax = Buffer.from(paxBody, "utf8");
      pushHeader(makeHeader({
        name: "PaxHeader",
        mode: 0o644,
        uid: 0,
        gid: 0,
        size: pax.length,
        mtime,
        typeflag: "x",
        linkname: "",
        uname: "",
        gname: "",
        devmajor: 0,
        devminor: 0,
        prefix: "",
      }));
      const padded = Buffer.alloc(Math.ceil(pax.length / 512) * 512);
      pax.copy(padded);
      blocks.push(padded);
    }
    pushHeader(makeHeader({
      name: truncated,
      mode: entry.type === "dir" ? 0o755 : (entry.mode ?? 0o644),
      uid: 0,
      gid: 0,
      size,
      mtime,
      typeflag,
      linkname,
      uname: "",
      gname: "",
      devmajor: 0,
      devminor: 0,
      prefix: "",
    }));
    if (entry.type === "file") {
      const padded = Buffer.alloc(Math.ceil(size / 512) * 512);
      entry.content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512));
  return Buffer.concat(blocks);
}

/** PAX extended-header record with the correct total-length prefix. */
export function paxRecord(key, value) {
  let body = `${key}=${value}\n`;
  let record = `${Buffer.byteLength(body) + 1} ${body}`;
  while (Buffer.byteLength(record) !== Number(record.split(" ")[0])) {
    record = `${Buffer.byteLength(record)} ${body}`;
  }
  return record;
}

function makeHeader({ name, mode, uid, gid, size, mtime, typeflag, linkname, uname, gname, devmajor, devminor, prefix }) {
  const header = Buffer.alloc(512);
  const writeField = (offset, length, value) => {
    const encoded = Buffer.from(String(value), "utf8");
    encoded.copy(header, offset, 0, Math.min(encoded.length, length));
  };
  writeField(0, 100, name);
  writeField(100, 8, mode.toString(8).padStart(7, "0"));
  writeField(108, 8, uid.toString(8).padStart(7, "0"));
  writeField(116, 8, gid.toString(8).padStart(7, "0"));
  writeField(124, 12, size.toString(8).padStart(11, "0"));
  writeField(136, 12, mtime.toString(8).padStart(11, "0"));
  // chksum (148..155) left as spaces for now.
  header.write(typeflag, 156, 1, "ascii");
  writeField(157, 100, linkname);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeField(265, 32, uname);
  writeField(297, 32, gname);
  writeField(329, 8, devmajor.toString(8).padStart(7, "0"));
  writeField(337, 8, devminor.toString(8).padStart(7, "0"));
  writeField(345, 155, prefix);
  // POSIX checksum: sum of all header bytes with the checksum field treated
  // as eight spaces (the field is zero-filled at this point).
  header.fill(0x20, 148, 156);
  const checksum = header.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

export function gzipDeterministic(buffer) {
  return gzipSync(buffer, { level: 9 });
}

/** Builds the deterministic tarball bytes for a tree (dirs + files + relative symlinks, sorted). */
export async function tarballForTree(root, sourceDateEpoch) {
  const entries = [];
  for (const entry of await walkTree(root)) {
    if (entry.type === "special") {
      throw new Error(`cannot tar artifact with special file: ${entry.path}`);
    }
    if (entry.type === "symlink") {
      entries.push({ path: entry.path, type: "symlink", size: 0, content: Buffer.alloc(0), linkname: entry.target ?? "" });
    } else if (entry.type === "dir") {
      entries.push({ path: `${entry.path}/`, type: "dir", size: 0, content: Buffer.alloc(0) });
    } else {
      const content = await readFile(join(root, entry.path));
      // Executable artifacts: the launcher and the bundled node binary.
      const executable = entry.path === "rly" || entry.path === "bin/node";
      entries.push({ path: entry.path, type: "file", size: content.length, content, mode: executable ? 0o755 : 0o644 });
    }
  }
  return gzipDeterministic(buildTarBytes(entries, sourceDateEpoch));
}

/**
 * Assembles one standalone artifact directory from a prepared runtime root
 * (package.json + LICENSE + dist + node_modules real files). Adds the bundled
 * node, self-locating launcher, exact build
 * identity (`rly-build.json`), candidate manifest (`rly.json`), artifact
 * metadata (`rly-artifact.json`), enforces the positive allowlist, and
 * returns the content-addressed tree digest. Pure: no network, no installs.
 */
export async function assembleStandaloneArtifact({
  runtimeRoot,
  outDir,
  target,
  node,
  identityMeta,
  releaseVersion,
  sourceDateEpoch,
}) {
  const matrix = TARGET_MATRIX[target];
  if (matrix === undefined) throw new Error(`unknown standalone target: ${target}`);
  const artifactDir = join(outDir, `rly-${releaseVersion}-${target}`);
  await mkdir(artifactDir, { recursive: true });
  await cp(runtimeRoot, artifactDir, { recursive: true, verbatimSymlinks: true });

  await mkdir(join(artifactDir, "bin"), { recursive: true });
  await cp(node.bin, join(artifactDir, "bin", "node"));
  await chmod(join(artifactDir, "bin", "node"), 0o755);
  if (node.license !== undefined) {
    await cp(node.license, join(artifactDir, "bin", "node.LICENSE"));
  } else {
    await writeFile(
      join(artifactDir, "bin", "node.LICENSE"),
      `Bundled Node.js ${node.version}\n\nNode.js is distributed under the MIT License (https://github.com/nodejs/node/blob/main/LICENSE).\n`,
    );
  }

  const launcher = buildRlyLauncher();
  await writeFile(join(artifactDir, "rly"), launcher);
  await chmod(join(artifactDir, "rly"), 0o755);

  await writeFile(join(artifactDir, "rly-build.json"), `${JSON.stringify(identityMeta, null, 2)}\n`);
  await writeFile(join(artifactDir, "rly.json"), `${JSON.stringify(buildRlyManifest(identityMeta), null, 2)}\n`);

  const artifactDigest = await treeDigest(artifactDir, { exclude: ["rly-artifact.json"] });
  const files = (await walkTree(artifactDir)).filter((entry) => entry.type === "file").length;
  const metadata = buildArtifactMetadata({
    identityMeta,
    target,
    bundledNodeVersion: node.version,
    bundledNodeVersionSource: node.source,
    artifactDigest,
    fileCount: files,
    sourceDateEpoch,
    matrixStatus: matrix.status,
    matrixReason: matrix.reason,
  });
  await writeJson(join(artifactDir, "rly-artifact.json"), metadata);

  const violations = await checkAllowlist(artifactDir);
  if (violations.length > 0) {
    throw new Error(`allowlist failed for ${target}:\n  - ${violations.join("\n  - ")}`);
  }
  const secretViolations = await checkForSecretContent(artifactDir);
  if (secretViolations.length > 0) {
    throw new Error(`secret content detected for ${target}:\n  - ${secretViolations.join("\n  - ")}`);
  }
  return { artifactDir, metadata, digest: artifactDigest, fileCount: files };
}

/**
 * Verifies an assembled artifact directory: allowlist/absence, layout,
 * identity consistency across rly-build.json / rly.json / rly-artifact.json,
 * and digest recompute. Returns { ok, errors }.
 */
export async function verifyArtifactDirectory(artifactRoot, { target, expectedVersion } = {}) {
  const errors = [];
  const violations = await checkAllowlist(artifactRoot);
  if (violations.length > 0) errors.push(`allowlist violations:\n  - ${violations.join("\n  - ")}`);
  const secretViolations = await checkForSecretContent(artifactRoot);
  if (secretViolations.length > 0) errors.push(`secret content in RLY-owned files:\n  - ${secretViolations.join("\n  - ")}`);

  const [packageJson, buildMeta, manifest, metadata] = await Promise.all([
    readJsonSafe(join(artifactRoot, "package.json")),
    readJsonSafe(join(artifactRoot, "rly-build.json")),
    readJsonSafe(join(artifactRoot, "rly.json")),
    readJsonSafe(join(artifactRoot, "rly-artifact.json")),
  ]);
  if (packageJson === undefined) errors.push("missing package.json");
  if (buildMeta === undefined) errors.push("missing rly-build.json");
  if (manifest === undefined) errors.push("missing rly.json");
  if (metadata === undefined) errors.push("missing rly-artifact.json");

  if (buildMeta !== undefined && manifest !== undefined && metadata !== undefined) {
    // Field-name mapping: the #73/#93 candidate manifest calls them
    // `version`/`stateVersion`; the #94 build identity uses
    // `semanticVersion`/`stateSchemaVersion`. All carry the same values.
    const fieldAccessors = {
      semanticVersion: [
        (record) => record.semanticVersion,
        (record) => record.version,
        (record) => record.semanticVersion,
      ],
      stateSchemaVersion: [
        (record) => record.stateSchemaVersion,
        (record) => record.stateVersion,
        (record) => record.stateSchemaVersion,
      ],
      commitRevision: [(record) => record.commitRevision, (record) => record.commitRevision, (record) => record.commitRevision],
      buildId: [(record) => record.buildId, (record) => record.buildId, (record) => record.buildId],
      releaseChannel: [(record) => record.releaseChannel, (record) => record.releaseChannel, (record) => record.releaseChannel],
      controlProtocolVersion: [(record) => record.controlProtocolVersion, (record) => record.controlProtocolVersion, (record) => record.controlProtocolVersion],
      dataProtocolVersion: [(record) => record.dataProtocolVersion, (record) => record.dataProtocolVersion, (record) => record.dataProtocolVersion],
    };
    for (const [field, accessors] of Object.entries(fieldAccessors)) {
      const values = [buildMeta, manifest, metadata].map((record, index) => accessors[index](record));
      if (values.some((value) => value === undefined) || new Set(values).size !== 1) {
        errors.push(`identity field ${field} inconsistent across rly-build.json/rly.json/rly-artifact.json: ${values.join(" | ")}`);
      }
    }
    if (expectedVersion !== undefined && metadata.semanticVersion !== expectedVersion) {
      errors.push(`artifact semanticVersion ${metadata.semanticVersion} != expected ${expectedVersion}`);
    }
    const distBuild = await readJsonSafe(join(artifactRoot, "dist", "rly-build.json"));
    if (distBuild !== undefined && JSON.stringify(distBuild) !== JSON.stringify(buildMeta)) {
      errors.push("dist/rly-build.json differs from artifact-root rly-build.json (identity split)");
    }
    if (target !== undefined && metadata.targetPlatform !== target) {
      errors.push(`artifact targetPlatform ${metadata.targetPlatform} != expected ${target}`);
    }
    const digest = await treeDigest(artifactRoot, { exclude: ["rly-artifact.json"] });
    if (metadata.artifactDigest !== digest) {
      errors.push(`artifactDigest ${metadata.artifactDigest} != recomputed tree digest ${digest}`);
    }
  }

  const launcher = await readFileSafe(join(artifactRoot, "rly"));
  if (launcher === undefined) errors.push("missing rly launcher");
  else if (!launcher.startsWith("#!/bin/sh")) errors.push("rly launcher is not a POSIX sh script");

  return { ok: errors.length === 0, errors };
}

/**
 * Clean-artifact smoke: executes `rly --version` from the unpacked artifact
 * using the BUNDLED node, and returns the parsed identity object.
 */
export async function smokeRun(artifactRoot, { timeoutMs = 60_000 } = {}) {
  const root = resolve(artifactRoot);
  const launcher = join(root, "rly");
  const output = execFileSync(launcher, ["--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, RLY_BUNDLED_NODE: "1" },
  }).trim();
  const parsed = JSON.parse(output);
  if (parsed.product !== "rly-gateway" || parsed.version === undefined) {
    throw new Error(`smoke output is not a build identity: ${output}`);
  }
  return parsed;
}

export async function readFileSafe(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readJsonSafe(path) {
  const contents = await readFileSafe(path);
  if (contents === undefined) return undefined;
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
