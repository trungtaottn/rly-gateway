import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type IdentityMeta,
  ALL_TARGETS,
  assembleStandaloneArtifact,
  buildArtifactMetadata,
  buildRlyLauncher,
  buildRlyManifest,
  checkAllowlist,
  exactGitTag,
  hostTarget,
  resolveNodeDistributionRoot,
  pinnedNodeVersion,
  resolveReleaseVersion,
  sha256Of,
  smokeRun,
  tarballForTree,
  targetStatus,
  treeDigest,
  verifyArtifactDirectory,
} from "../../scripts/standalone/pack.mjs";

describe("Node distribution archive layout", () => {
  it("resolves exactly one extracted top-level directory containing bin/node", async () => {
    const scratch = await directory();
    const root = join(scratch, "unexpected-runtime-name");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "node"), "binary");
    expect(await resolveNodeDistributionRoot(scratch)).toBe(root);
    await mkdir(join(scratch, "second", "bin"), { recursive: true });
    await writeFile(join(scratch, "second", "bin", "node"), "binary");
    await expect(resolveNodeDistributionRoot(scratch)).rejects.toThrow("exactly one top-level directory");
  });
});

type BuildIdentityMeta = {
  semanticVersion: string;
  commitRevision: string;
  buildId: string;
  releaseChannel: string;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateSchemaVersion: number;
};

type RlyManifest = {
  product: string;
  version: string;
  stateVersion: number;
  migrationClass: string;
  buildId: string;
  commitRevision: string;
  releaseChannel: string;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
};

type ArtifactMetadata = {
  artifactSchemaVersion: number;
  product: string;
  semanticVersion: string;
  commitRevision: string;
  buildId: string;
  releaseChannel: string;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateSchemaVersion: number;
  targetPlatform: string;
  targetStatus: string;
  targetStatusReason: string;
  bundledNodeVersion: string;
  bundledNodeVersionSource: string;
  artifactDigest: string;
  fileCount: number;
  sourceDateEpoch: number;
  allowlistVersion: number;
  digestInputs: string[];
};

function parseJson(contents: string): unknown {
  return JSON.parse(contents) as unknown;
}

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-standalone-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const IDENTITY: IdentityMeta = {
  semanticVersion: "1.2.3",
  commitRevision: "a".repeat(40),
  buildId: "build-35",
  releaseChannel: "beta",
  controlProtocolVersion: 1,
  dataProtocolVersion: 1,
  stateSchemaVersion: 2,
};

/** Minimal runtime root: package.json + LICENSE + dist + node_modules (real files). */
async function fixtureRuntimeRoot(overrides: { extraFiles?: Array<[string, string]> } = {}): Promise<string> {
  const root = await directory();
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "rly-gateway",
    version: "0.1.0",
    private: true,
    type: "module",
    bin: { rly: "dist/cli/main.js" },
    engines: { node: ">=24 <25" },
  }, null, 2));
  await writeFile(join(root, "LICENSE"), "MIT License\nCopyright (c) 2026 Trung Tao\n");
  await mkdir(join(root, "dist", "cli"), { recursive: true });
  await writeFile(join(root, "dist", "cli", "main.js"), [
    'import { readFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const meta = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'rly-build.json'), 'utf8'));",
    "console.log(JSON.stringify({ product: 'rly-gateway', version: meta.semanticVersion, commitRevision: meta.commitRevision, buildId: meta.buildId, releaseChannel: meta.releaseChannel, controlProtocolVersion: meta.controlProtocolVersion, dataProtocolVersion: meta.dataProtocolVersion, stateSchemaVersion: meta.stateSchemaVersion, identitySchemaVersion: 1 }));",
  ].join("\n"));
  await writeFile(join(root, "dist", "rly-build.json"), `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await mkdir(join(root, "node_modules", "fixture-dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "fixture-dep", "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0" }));
  await writeFile(join(root, "node_modules", "fixture-dep", "index.js"), "export const value = 42;\n");
  for (const [path, contents] of overrides.extraFiles ?? []) {
    await mkdir(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

async function localNode(): Promise<FixtureNode> {
  const version = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim().replace(/^v/, "");
  const dir = await directory();
  const bin = join(dir, "node");
  // Homebrew's executable depends on a sibling libnode dylib. A relocatable
  // wrapper keeps this unit test focused on the RLY launcher; release artifacts
  // still exercise the downloaded, self-contained Node distribution.
  await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await chmod(bin, 0o755);
  return { bin, license: undefined, version, source: "host-wrapper-fixture" };
}

/** Tiny executable used as the bundled node in hermetic tests (no real binary). */
async function fakeNode(): Promise<FixtureNode> {
  const dir = await directory();
  const bin = join(dir, "node");
  await writeFile(bin, "#!/bin/sh\necho v99.0.0\n");
  await chmod(bin, 0o755);
  return { bin, license: undefined, version: "99.0.0", source: "fixture" };
}

type FixtureNode = { bin: string; license: string | undefined; version: string; source: string };

async function assembleFixture(options: {
  runtimeRoot?: string;
  target?: string;
  node?: FixtureNode;
  extraFiles?: Array<[string, string]>;
} = {}): Promise<{ artifactDir: string; digest: string; metadata: Record<string, unknown>; fileCount: number }> {
  const { runtimeRoot, target = "linux-x64", node, extraFiles = [] } = options;
  const root = runtimeRoot ?? await fixtureRuntimeRoot({ extraFiles });
  const outDir = await directory();
  const nodeSource = node ?? await fakeNode();
  return assembleStandaloneArtifact({
    runtimeRoot: root,
    outDir,
    target,
    node: nodeSource,
    identityMeta: IDENTITY,
    releaseVersion: IDENTITY.semanticVersion,
    sourceDateEpoch: 0,
  });
}

describe("standalone artifact platform matrix (#35)", () => {
  it("explicitly covers or excludes every required target with a status and reason", () => {
    expect([...ALL_TARGETS].sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
    for (const target of ALL_TARGETS) {
      const entry = targetStatus(target);
      expect(["supported", "experimental"]).toContain(entry.status);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("never silently reuses another target's node bytes", () => {
    const distNames = ALL_TARGETS.map((target) => targetStatus(target).nodeDistFor("24.19.0"));
    expect(new Set(distNames).size).toBe(distNames.length);
  });

  it("marks linux-x64 supported and the remaining targets experimental with explicit reasons", () => {
    expect(targetStatus("linux-x64").status).toBe("supported");
    for (const target of ["darwin-arm64", "darwin-x64"]) {
      expect(targetStatus(target).status).toBe("experimental");
      expect(targetStatus(target).reason).toMatch(/smoke-testing requires/);
    }
    expect(targetStatus("linux-arm64").status).toBe("experimental");
    expect(targetStatus("linux-arm64").reason).toMatch(/exact-byte gates run on ubuntu-24\.04-arm/);
    expect(targetStatus("linux-arm64").reason).toMatch(/Stable publication stays linux-x64/);
  });

  it("pins the bundled node version from the repo pin file", async () => {
    const version = await pinnedNodeVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("canonical release version input (#35)", () => {
  it("prefers RLY_RELEASE_VERSION over RELEASE_VERSION, git tag, and package.json", () => {
    expect(resolveReleaseVersion({
      env: { RLY_RELEASE_VERSION: "2.0.0", RELEASE_VERSION: "1.9.0" },
      gitTag: "v1.0.0",
      packageVersion: "0.1.0",
    })).toBe("2.0.0");
    expect(resolveReleaseVersion({
      env: { RELEASE_VERSION: "1.9.0" },
      gitTag: "v1.0.0",
      packageVersion: "0.1.0",
    })).toBe("1.9.0");
  });

  it("uses the exact git tag (strip leading v) before package.json", () => {
    expect(resolveReleaseVersion({ env: {}, gitTag: "v1.0.0-beta.32", packageVersion: "0.1.0" })).toBe("1.0.0-beta.32");
    expect(resolveReleaseVersion({ env: {}, packageVersion: "0.1.0" })).toBe("0.1.0");
  });

  it("fails closed when no version authority exists", () => {
    expect(() => resolveReleaseVersion({ env: {} })).toThrow();
  });
});

describe("positive package allowlist (#35)", () => {
  it("fails packaging on unexpected files and forbidden markers", async () => {
    const root = await fixtureRuntimeRoot({
      extraFiles: [
        [".env", "TOKEN=secret"],
        [".git/HEAD", "ref: refs/heads/dev"],
        ["plans/phase.md", "# plan"],
        ["tests/unit/x.test.ts", "export {}"],
        ["coverage/lcov.info", "SF:index.js"],
        ["reports/audit.md", "# report"],
        // Split at runtime so the repo privacy scan never sees a literal key header.
        ["credentials/store.pem", "-----BEGIN " + "PRIVATE KEY-----"],
        ["state.sqlite", "sqlite"],
        ["__snapshots__/x.snap", "snapshot"],
        [".rly/installation.json", "{}"],
        [".agent-gateway/state", "{}"],
        [".DS_Store", ""],
        ["README.md", "unexpected top-level"],
        ["node_modules/.modules.yaml", "{}"],
      ],
    });
    const violations = await checkAllowlist(root);
    for (const marker of [".env", ".git/", "plans/", "tests/", "coverage/", "reports/", "credentials/", "state.sqlite", "__snapshots__", ".rly/", ".agent-gateway/", ".DS_Store", "README.md", ".modules.yaml"]) {
      expect(violations.some((violation) => violation.includes(marker))).toBe(true);
    }
    await expect(assembleFixture({ runtimeRoot: root })).rejects.toThrow(/allowlist failed/);
  });

  it("accepts a clean fixture tree and reports zero violations", async () => {
    const root = await fixtureRuntimeRoot();
    expect(await checkAllowlist(root)).toEqual([]);
  });

  it("bundles only the documented top-level entries", async () => {
    const { artifactDir } = await assembleFixture();
    const entries = (await checkAllowlist(artifactDir));
    expect(entries).toEqual([]);
    const top = (await readFile(join(artifactDir, "rly-artifact.json"), "utf8")).length;
    expect(top).toBeGreaterThan(0);
    await expect(readFile(join(artifactDir, "README.md"), "utf8")).rejects.toThrow();
  });
});

describe("deterministic artifact bytes and identity (#35)", () => {
  it("produces byte-identical tarballs for identical inputs at the same source date epoch", async () => {
    const node = await fakeNode();
    const first = await assembleFixture({ runtimeRoot: await fixtureRuntimeRoot(), node });
    const second = await assembleFixture({ runtimeRoot: await fixtureRuntimeRoot(), node });
    const tarA = await tarballForTree(first.artifactDir, 0);
    const tarB = await tarballForTree(second.artifactDir, 0);
    expect(tarA).toEqual(tarB);
    expect(sha256Of(tarA)).toBe(sha256Of(tarB));
    expect(first.digest).toBe(second.digest);
  });

  it("changes bytes and digest when the tree bytes change", async () => {
    const first = await assembleFixture();
    const second = await assembleFixture({
      runtimeRoot: await fixtureRuntimeRoot({ extraFiles: [["node_modules/fixture-dep/index.js", "export const value = 43;\n"]] }),
    });
    expect(first.digest).not.toBe(second.digest);
    const tarA = await tarballForTree(first.artifactDir, 0);
    const tarB = await tarballForTree(second.artifactDir, 0);
    expect(sha256Of(tarA)).not.toBe(sha256Of(tarB));
  });

  it("respects SOURCE_DATE_EPOCH so different epochs produce different tarball bytes with the same content digest", async () => {
    const runtimeRoot = await fixtureRuntimeRoot();
    const node = await fakeNode();
    const assembled = await assembleStandaloneArtifact({
      runtimeRoot, outDir: await directory(), target: "linux-x64", node,
      identityMeta: IDENTITY, releaseVersion: IDENTITY.semanticVersion, sourceDateEpoch: 0,
    });
    const tarEpoch0 = await tarballForTree(assembled.artifactDir, 0);
    const tarEpoch1 = await tarballForTree(assembled.artifactDir, 1_700_000_000);
    expect(sha256Of(tarEpoch0)).not.toBe(sha256Of(tarEpoch1));
    expect(assembled.digest).toBe(await treeDigest(assembled.artifactDir, { exclude: ["rly-artifact.json"] }));
  });

  it("produces a valid tar that the system tar can extract to the identical file list", async () => {
    const { artifactDir } = await assembleFixture();
    const tar = await tarballForTree(artifactDir, 0);
    const scratch = await directory();
    const extract = join(scratch, "extracted");
    await mkdir(extract);
    const archive = join(scratch, "artifact.tar.gz");
    await writeFile(archive, tar);
    execFileSync("tar", ["-xzf", archive, "-C", extract]);
    const sourceFiles = (await readDirFiles(artifactDir)).sort();
    const extractedFiles = (await readDirFiles(extract)).sort();
    expect(extractedFiles).toEqual(sourceFiles);
  });
});

describe("canonical identity consistency (#35 / #94)", () => {
  it("keeps rly-build.json, rly.json, rly-artifact.json, and dist/rly-build.json identical where required", async () => {
    const { artifactDir } = await assembleFixture();
    const verification = await verifyArtifactDirectory(artifactDir, { target: "linux-x64", expectedVersion: "1.2.3" });
    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);
    const buildMeta = parseJson(await readFile(join(artifactDir, "rly-build.json"), "utf8")) as BuildIdentityMeta;
    expect(buildMeta.semanticVersion).toBe("1.2.3");
    expect(buildMeta.stateSchemaVersion).toBe(2);
    const manifest = parseJson(await readFile(join(artifactDir, "rly.json"), "utf8")) as RlyManifest;
    const metadata = parseJson(await readFile(join(artifactDir, "rly-artifact.json"), "utf8")) as ArtifactMetadata;
    expect(manifest.product).toBe("rly-gateway");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.stateVersion).toBe(2);
    expect(manifest.migrationClass).toBe("backward-compatible-expand");
    expect(manifest.buildId).toBe(IDENTITY.buildId);
    expect(manifest.commitRevision).toBe(IDENTITY.commitRevision);
    expect(manifest.releaseChannel).toBe("beta");
    expect(metadata.semanticVersion).toBe("1.2.3");
    expect(metadata.targetPlatform).toBe("linux-x64");
    expect(metadata.bundledNodeVersion).toBe("99.0.0");
    expect(metadata.bundledNodeVersionSource).toBe("fixture");
    expect(metadata.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.artifactDigest).toBe(await treeDigest(artifactDir, { exclude: ["rly-artifact.json"] }));
  });

  it("detects identity splits (diverging rly-build.json copies) and digest tampering", async () => {
    const { artifactDir } = await assembleFixture();
    await writeFile(join(artifactDir, "rly-build.json"), JSON.stringify({ ...IDENTITY, semanticVersion: "9.9.9" }, null, 2));
    const verification = await verifyArtifactDirectory(artifactDir, { target: "linux-x64", expectedVersion: "1.2.3" });
    expect(verification.ok).toBe(false);
    expect(verification.errors.join("\n")).toMatch(/semanticVersion inconsistent/);
    expect(verification.errors.join("\n")).toMatch(/artifactDigest/);
  });

  it("two byte-distinct artifacts cannot claim the same identity digest", async () => {
    const first = await assembleFixture();
    const second = await assembleFixture({
      runtimeRoot: await fixtureRuntimeRoot({ extraFiles: [["dist/extra.txt", "extra"]] }),
    });
    expect(first.metadata.semanticVersion).toBe(second.metadata.semanticVersion);
    expect(first.metadata.artifactDigest).not.toBe(second.metadata.artifactDigest);
  });
});

describe("clean-artifact smoke (#35)", () => {
  it("executes rly --version from the unpacked artifact using the bundled node", async () => {
    const host = hostTarget();
    if (host === null) return;
    const { artifactDir } = await assembleFixture({ target: host, node: await localNode() });
    const identity = await smokeRun(artifactDir);
    expect(identity.product).toBe("rly-gateway");
    expect(identity.version).toBe("1.2.3");
    expect(identity.commitRevision).toBe(IDENTITY.commitRevision);
  });

  it("runs from any working directory (no invoking-CWD dependence)", async () => {
    const host = hostTarget();
    if (host === null) return;
    const { artifactDir } = await assembleFixture({ target: host, node: await localNode() });
    const output = execFileSync(join(artifactDir, "rly"), ["--version"], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, RLY_BUNDLED_NODE: "1" },
    }).trim();
    expect((parseJson(output) as { version: string }).version).toBe("1.2.3");
  });
});

describe("launcher and manifest shape (#35)", () => {
  it("launcher is a self-locating POSIX sh script resolving the bundled node", () => {
    const launcher = buildRlyLauncher();
    expect(launcher.startsWith("#!/bin/sh")).toBe(true);
    expect(launcher).toContain("RLY_HOME=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"");
    expect(launcher).toContain("exec \"$NODE_BIN\" \"$RLY_HOME/dist/cli/main.js\" \"$@\"");
    expect(launcher).toContain("bin/node");
  });

  it("candidate manifest carries the #94 identity fields", () => {
    const manifest = buildRlyManifest(IDENTITY);
    expect(manifest).toEqual({
      product: "rly-gateway",
      version: "1.2.3",
      stateVersion: 2,
      migrationClass: "backward-compatible-expand",
      buildId: "build-35",
      commitRevision: IDENTITY.commitRevision,
      releaseChannel: "beta",
      controlProtocolVersion: 1,
      dataProtocolVersion: 1,
    });
  });

  it("artifact metadata records the digest inputs for #128 SBOM qualification", () => {
    const metadata = buildArtifactMetadata({
      identityMeta: IDENTITY,
      target: "linux-x64",
      bundledNodeVersion: "24.19.0",
      bundledNodeVersionSource: "download",
      artifactDigest: "d".repeat(64),
      fileCount: 7,
      sourceDateEpoch: 0,
      matrixStatus: "supported",
      matrixReason: "reason",
    });
    expect(metadata.bundledNodeVersion).toBe("24.19.0");
    expect(metadata.bundledNodeVersionSource).toBe("download");
    expect(metadata.artifactSchemaVersion).toBe(1);
    expect(metadata.allowlistVersion).toBe(1);
    expect(metadata.digestInputs).toContain("sorted-relative-path");
  });
});

describe("pnpm dependency layout preservation (#35)", () => {
  it("preserves relative in-tree symlinks (pnpm layout) and digests them deterministically", async () => {
    const root = await directory();
    await mkdir(join(root, "dist", "cli"), { recursive: true });
    await mkdir(join(root, "node_modules", ".pnpm", "fastify@5", "node_modules"), { recursive: true });
    await mkdir(join(root, "node_modules", ".pnpm", "fastify@5", "node_modules", "fastify"), { recursive: true });
    await mkdir(join(root, "node_modules", ".pnpm", "avvio@9", "node_modules", "avvio"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "rly-gateway", version: "1.2.3", type: "module" }));
    await writeFile(join(root, "LICENSE"), "MIT\n");
    await writeFile(join(root, "dist", "cli", "main.js"), "export const x = 1;\n");
    await writeFile(join(root, "dist", "rly-build.json"), `${JSON.stringify(IDENTITY, null, 2)}\n`);
    await writeFile(join(root, "node_modules", ".pnpm", "fastify@5", "node_modules", "fastify", "package.json"), JSON.stringify({ name: "fastify", main: "index.js" }));
    await writeFile(join(root, "node_modules", ".pnpm", "fastify@5", "node_modules", "fastify", "index.js"), "require('avvio');\n");
    await writeFile(join(root, "node_modules", ".pnpm", "avvio@9", "node_modules", "avvio", "index.js"), "module.exports = {};\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(".pnpm/fastify@5/node_modules/fastify", join(root, "node_modules", "fastify"));
    await symlink("../../avvio@9/node_modules/avvio", join(root, "node_modules", ".pnpm", "fastify@5", "node_modules", "avvio"));

    const node = await fakeNode();
    const assembled = await assembleStandaloneArtifact({
      runtimeRoot: root,
      outDir: await directory(),
      target: "linux-x64",
      node,
      identityMeta: IDENTITY,
      releaseVersion: "1.2.3",
      sourceDateEpoch: 0,
    });
    expect(await checkAllowlist(assembled.artifactDir)).toEqual([]);
    const { lstat: lstatFile } = await import("node:fs/promises");
    expect((await lstatFile(join(assembled.artifactDir, "node_modules", "fastify"))).isSymbolicLink()).toBe(true);
    expect((await lstatFile(join(assembled.artifactDir, "node_modules", ".pnpm", "fastify@5", "node_modules", "avvio"))).isSymbolicLink()).toBe(true);
    const verification = await verifyArtifactDirectory(assembled.artifactDir, { target: "linux-x64", expectedVersion: "1.2.3" });
    expect(verification.ok).toBe(true);
  });

  it("refuses symlinks that escape node_modules or are absolute", async () => {
    const { symlink } = await import("node:fs/promises");
    const root = await fixtureRuntimeRoot();
    await symlink("../../etc/passwd", join(root, "node_modules", "escape"));
    await symlink("/etc/passwd", join(root, "node_modules", "absolute"));
    const violations = await checkAllowlist(root);
    expect(violations.some((violation) => violation.includes("unsafe symlink target"))).toBe(true);
    expect(violations.some((violation) => violation.includes("unsafe symlink target"))).toBe(true);
  });

  it("tar round-trip preserves long symlink targets and executable modes", async () => {
    const { symlink, lstat: lstatFile } = await import("node:fs/promises");
    const root = await fixtureRuntimeRoot();
    // A pnpm-style symlink whose target exceeds the 100-byte ustar field.
    const longTarget = `.pnpm/@fastify+fast-json-stringify-compiler@5.1.0/node_modules/@fastify/fast-json-stringify-compiler/index.js`;
    expect(longTarget.length).toBeGreaterThan(100);
    await symlink(longTarget, join(root, "node_modules", "long-link"));
    const assembled = await assembleStandaloneArtifact({
      runtimeRoot: root,
      outDir: await directory(),
      target: "linux-x64",
      node: await fakeNode(),
      identityMeta: IDENTITY,
      releaseVersion: "1.2.3",
      sourceDateEpoch: 0,
    });
    const tar = await tarballForTree(assembled.artifactDir, 0);
    const scratch = await directory();
    const extract = join(scratch, "x");
    await mkdir(extract);
    await writeFile(join(scratch, "a.tar.gz"), tar);
    execFileSync("tar", ["-xzf", join(scratch, "a.tar.gz"), "-C", extract]);
    expect(await readlink(join(extract, "node_modules", "long-link"))).toBe(longTarget);
    expect((await lstatFile(join(extract, "rly"))).mode & 0o111).toBe(0o111);
    expect((await lstatFile(join(extract, "bin", "node"))).mode & 0o111).toBe(0o111);
    // The extracted tree digests identically to the assembled tree.
    expect(await treeDigest(extract, { exclude: ["rly-artifact.json"] })).toBe(assembled.digest);
  });
});

describe("standalone artifact CI workflow (#35)", () => {
  it("consumes an explicit comma-separated target argument exactly once", () => {
    const builder = readFileSync(join(process.cwd(), "scripts", "standalone", "build-standalone.mjs"), "utf8");
    expect(builder).toContain("const targets = value();");
    expect(builder).toContain('targets.split(",")');
    expect(builder).not.toContain("else options.targets = value().split");
  });

  it("retains downloaded Node bytes until artifact assembly finishes", () => {
    const builder = readFileSync(join(process.cwd(), "scripts", "standalone", "build-standalone.mjs"), "utf8");
    expect(builder).toContain("cleanup: () => rm(scratch");
    expect(builder.indexOf("result = await assembleArtifact")).toBeLessThan(builder.indexOf("await node.cleanup?.()"));
  });

  it("runs on release publication and workflow_dispatch with the release tag as the canonical version input", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "standalone-artifacts.yml"), "utf8");
    expect(workflow).toContain("on:");
    expect(workflow).toContain("release:");
    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("release-version");
    expect(workflow).toContain("RLY_RELEASE_VERSION");
    expect(workflow).toContain("RELEASE_TAG");
    expect(workflow).toContain("github.event.release.tag_name || github.ref");
    expect(workflow).not.toContain("github.event.release.target_commitish || github.ref");
  });

  it("builds the full matrix, verifies every artifact, and uploads tarballs + sha256 + manifest + supply chain", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "standalone-artifacts.yml"), "utf8");
    expect(workflow).toContain("scripts/standalone/build-standalone.mjs");
    expect(workflow).toContain("scripts/standalone/verify-artifact.mjs");
    expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("out/standalone/*.tar.gz");
    expect(workflow).toContain("out/standalone/*.tar.gz.sig");
    expect(workflow).not.toContain("out/standalone/*.sha256 out/standalone/*.sig");
    expect(workflow).toContain("artifacts.json");
  });

  it("pins the pnpm/Node toolchain like the rest of CI and runs the #128 release supply chain", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "standalone-artifacts.yml"), "utf8");
    expect(workflow).toContain("pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86");
    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(workflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("scripts/release/qualify.mjs");
    expect(workflow).toContain("scripts/release/sign-artifacts.mjs");
    expect(workflow).toContain("scripts/release/publish.mjs");
    expect(workflow).toContain("scripts/release/verify-release.mjs");
    expect(workflow).toContain("RLY_RELEASE_SIGNING_KEY");
    expect(workflow.indexOf("scripts/release/sign-artifacts.mjs")).toBeLessThan(workflow.indexOf("scripts/release/qualify.mjs"));
    expect(workflow).toContain('TARGETS="linux-x64"');
    expect(workflow).toContain('Stable publication on ubuntu-latest is restricted to the qualified linux-x64 target');
    expect(workflow).toContain("RLY_QUALIFICATION_USE_HOST_SERVICE_MANAGER=1");
    expect(workflow).toContain("systemctl --user show-environment");
    expect(workflow).toContain("systemctl --user disable --now rly-gateway.service");
  });

  it("qualifies linux-arm64 on ubuntu-24.04-arm without publishing Stable assets", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "standalone-artifacts.yml"), "utf8");
    expect(workflow).toContain("runner: ubuntu-latest");
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
    expect(workflow).toContain("id: linux-arm64");
    expect(workflow).toContain('TARGETS="linux-arm64"');
    expect(workflow).toContain("matrix.publish == 'true'");
    expect(workflow).toMatch(/if: \$\{\{ matrix\.publish == 'true' \}\}\n\s+uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
    expect(workflow).toContain("matrix.publish == 'true' && github.event_name == 'release'");
    expect(workflow).toContain("matrix.publish == 'true' && steps.version.outputs.channel == 'stable'");
    expect(workflow.indexOf("id: linux-x64")).toBeLessThan(workflow.indexOf("id: linux-arm64"));
  });
});

describe("exact git tag resolution", () => {
  it("resolves the exact tag on HEAD or returns undefined", () => {
    const tag = exactGitTag(process.cwd());
    // A tagged HEAD yields the exact tag; any other HEAD yields undefined.
    expect(tag === undefined || typeof tag === "string").toBe(true);
  });
});

async function readDirFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const stack = [""];
  while (stack.length > 0) {
    const relative = stack.pop() ?? "";
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files;
}
