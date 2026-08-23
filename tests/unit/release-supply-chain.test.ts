import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleStandaloneArtifact,
  sha256Of,
  tarballForTree,
  type IdentityMeta,
} from "../../scripts/standalone/pack.mjs";
import {
  canonicalJsonStringify,
  generateSigningKeyPair,
  publicKeyFingerprint,
  signDigestStatement,
  signJson,
  signBytes,
  verifyDigestStatement,
  verifyJsonSignature,
  verifySignature,
} from "../../scripts/release/signing.mjs";
import type { SignatureEnvelope } from "../../scripts/release/signing.mjs";
import {
  buildReleaseManifest,
  releaseManifestArtifactDigests,
  releaseManifestMatchesIdentity,
  serializeReleaseManifest,
  validateReleaseManifest,
} from "../../scripts/release/manifest.mjs";
import { buildSbomForArtifact, validateSbom, verifySbomArtifactRef } from "../../scripts/release/sbom.mjs";
import { buildProvenance, validateProvenance, verifyProvenanceSubjects } from "../../scripts/release/provenance.mjs";
import {
  buildChannelMetadata,
  channelVersionFor,
  evaluateChannelMetadata,
  qualificationStatusForChannel,
  validateChannelMetadata,
} from "../../scripts/release/channel.mjs";
import {
  deriveQualificationResult,
  gateResult,
  qualificationArtifactBindingErrors,
  qualificationBlocksStable,
  qualificationTargetSetErrors,
  runQualificationGates,
} from "../../scripts/release/qualification.mjs";
import { assertReleaseImmutable, detectAssetReplacement } from "../../scripts/release/immutability.mjs";

const ROOT = join(__dirname, "..", "..");

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-release-supply-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const IDENTITY: IdentityMeta = {
  semanticVersion: "1.0.0-beta.33",
  commitRevision: "a2c07bcf379bcb96fedac21ee42633f95687eadf",
  buildId: "build-128",
  releaseChannel: "beta",
  controlProtocolVersion: 1,
  dataProtocolVersion: 1,
  stateSchemaVersion: 2,
};

const RELEASE = {
  releaseVersion: IDENTITY.semanticVersion,
  releaseChannel: "beta",
  sourceCommit: IDENTITY.commitRevision,
  buildId: IDENTITY.buildId,
  stateSchemaVersion: 2,
  controlProtocolVersion: 1,
  dataProtocolVersion: 1,
  publishedAt: "2026-08-13T12:00:00.000Z",
  filename: `rly-${IDENTITY.semanticVersion}-linux-x64.tar.gz`,
  sha256: "a".repeat(64),
  artifactDigest: "b".repeat(64),
};

function makeManifest(overrides: Partial<typeof RELEASE> = {}) {
  const release = { ...RELEASE, ...overrides };
  return buildReleaseManifest({
    releaseVersion: release.releaseVersion,
    releaseChannel: release.releaseChannel,
    sourceCommit: release.sourceCommit,
    buildId: release.buildId,
    stateSchemaVersion: release.stateSchemaVersion,
    controlProtocolVersion: release.controlProtocolVersion,
    dataProtocolVersion: release.dataProtocolVersion,
    publishedAt: release.publishedAt,
    workflow: { name: "standalone-artifacts", runId: "run-1", toolchain: { node: "24.19.0", pnpm: "11.16.0", os: "linux" } },
    artifacts: [
      {
        target: "linux-x64",
        filename: release.filename,
        sizeBytes: 1234,
        sha256: release.sha256,
        artifactDigest: release.artifactDigest,
        targetStatus: "supported",
        targetStatusReason: "built and smoke-tested on the repository Linux CI runner",
        bundledNodeVersion: "24.19.0",
        bundledNodeVersionSource: "download",
        requiredSignatures: ["ed25519-sha256"],
        attestations: ["rly-1.0.0-beta.33-linux-x64.sbom.json"],
      },
    ],
  });
}

/** Minimal unpacked artifact tree (same shape as the #35 fixture). */
async function fixtureArtifactRoot(overrides: { extraPackages?: Array<[string, string]> } = {}): Promise<string> {
  const root = await directory();
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "rly-gateway",
    version: "0.1.0",
    private: true,
    type: "module",
    bin: { rly: "dist/cli/main.js" },
    engines: { node: ">=24 <25" },
    dependencies: { "fixture-dep": "1.0.0" },
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
  await writeFile(join(root, "node_modules", "fixture-dep", "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", license: "MIT" }));
  await writeFile(join(root, "node_modules", "fixture-dep", "index.js"), "export const value = 42;\n");
  for (const [name, contents] of overrides.extraPackages ?? []) {
    const [pkgName, pkgVersion, license] = name.split("@") as [string, string, string];
    const dir = join(root, "node_modules", `pkg-${pkgName}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: `pkg-${pkgName}`, version: pkgVersion, license }));
    await writeFile(join(dir, "index.js"), contents);
  }
  return root;
}

/** Assembles a fixture artifact (fake bundled node) into a release dir. */
async function assembleFixtureArtifact(): Promise<{ artifactDir: string; digest: string; metadata: Record<string, unknown>; fileCount: number }> {
  const outDir = await directory();
  const nodeDir = await directory();
  const bin = join(nodeDir, "node");
  await writeFile(bin, "#!/bin/sh\necho v99.0.0\n");
  await chmod(bin, 0o755);
  return assembleStandaloneArtifact({
    runtimeRoot: await fixtureArtifactRoot(),
    outDir,
    target: "linux-x64",
    node: { bin, license: undefined, version: "99.0.0", source: "fixture" },
    identityMeta: IDENTITY,
    releaseVersion: IDENTITY.semanticVersion,
    sourceDateEpoch: 0,
  });
}

  async function buildReleaseDir(): Promise<string> {
    const releaseDir = await directory();
    const nodeDir = await directory();
    const nodeBin = join(nodeDir, "node");
    await writeFile(nodeBin, "#!/bin/sh\nexec \"$(command -v node)\" \"$@\"\n");
    await chmod(nodeBin, 0o755);
    const assembled = await assembleStandaloneArtifact({
      runtimeRoot: await fixtureArtifactRoot(),
      outDir: releaseDir,
      target: "linux-x64",
      node: { bin: nodeBin, license: undefined, version: "99.0.0", source: "fixture" },
      identityMeta: IDENTITY,
      releaseVersion: IDENTITY.semanticVersion,
      sourceDateEpoch: 0,
    });
    const tar = await tarballForTree(assembled.artifactDir, 0);
    await writeFile(join(releaseDir, RELEASE.filename), tar);
    await writeFile(join(releaseDir, `${RELEASE.filename}.sha256`), `${sha256Of(tar)}  ${RELEASE.filename}\n`);
    const artifacts = {
      artifactSchemaVersion: 1,
      releaseVersion: IDENTITY.semanticVersion,
      commitRevision: IDENTITY.commitRevision,
      buildId: IDENTITY.buildId,
      releaseChannel: "beta",
      sourceDateEpoch: 0,
      allowlistVersion: 1,
      artifacts: [{
        name: RELEASE.filename,
        sha256: sha256Of(tar),
        targetPlatform: "linux-x64",
        targetStatus: "supported",
        targetStatusReason: "reason",
        bundledNodeVersion: "99.0.0",
        bundledNodeVersionSource: "fixture",
        artifactDigest: assembled.digest,
        fileCount: assembled.fileCount,
      }],
    };
    await writeFile(join(releaseDir, "artifacts.json"), `${JSON.stringify(artifacts, null, 2)}\n`);
    return releaseDir;
  }

describe("release signing (#128)", () => {
  it("signs and verifies JSON payloads with canonical bytes", () => {
    const pair = generateSigningKeyPair();
    const payload = { releaseVersion: "1.0.0-beta.33", channel: "beta", nested: { a: 1, b: "x" } };
    const envelope = signJson(pair.privateKey, payload);
    expect(verifyJsonSignature(pair.publicKey, payload, envelope)).toBe(true);
    expect(verifyJsonSignature(pair.publicKey, { ...payload, channel: "stable" }, envelope)).toBe(false);
  });

  it("signs and verifies digest statements (the artifact trust chain)", () => {
    const pair = generateSigningKeyPair();
    const digest = "c".repeat(64);
    const envelope = signDigestStatement(pair.privateKey, digest);
    expect(verifyDigestStatement(pair.publicKey, digest, envelope)).toBe(true);
    expect(verifyDigestStatement(pair.publicKey, "d".repeat(64), envelope)).toBe(false);
    expect(() => signDigestStatement(pair.privateKey, "not-a-digest")).toThrow();
  });

  it("signs arbitrary bytes and rejects tampered bytes", () => {
    const pair = generateSigningKeyPair();
    const bytes = Buffer.from("release bytes");
    const envelope = signBytes(pair.privateKey, bytes);
    expect(verifySignature(pair.publicKey, bytes, envelope)).toBe(true);
    expect(verifySignature(pair.publicKey, Buffer.from("release byteS"), envelope)).toBe(false);
  });

  it("binds the signature to the key fingerprint and rejects a different key", () => {
    const pair = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const payload = { releaseVersion: "1.0.0-beta.33" };
    const envelope = signJson(pair.privateKey, payload);
    expect(envelope.keyFingerprint).toBe(publicKeyFingerprint(pair.publicKey));
    expect(() => verifyJsonSignature(other.publicKey, payload, envelope)).toThrow(/does not match the release public key/);
  });

  it("canonical JSON is deterministic and order-independent", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe(canonicalJsonStringify({ a: 2, b: 1 }));
    expect(canonicalJsonStringify({ a: [1, { c: 3, b: 2 }] })).toBe('{"a":[1,{"b":2,"c":3}]}');
  });

  it("the committed release public key is a valid Ed25519 key with a stable fingerprint", () => {
    const committed = readFileSync(join(ROOT, "scripts", "release", "signing-public-key.pem"), "utf8");
    expect(committed).toContain("-----BEGIN PUBLIC KEY-----");
    expect(publicKeyFingerprint(committed)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonical release manifest (#128)", () => {
  it("builds and validates a legal manifest binding version/channel/commit/build/targets/digests", () => {
    const manifest = makeManifest();
    expect(validateReleaseManifest(manifest)).toEqual([]);
    expect(manifest.manifestSchemaVersion).toBe(1);
    expect(manifest.requiredSignatures).toContain("ed25519-sha256");
    expect(manifest.artifacts[0]).toMatchObject({
      target: "linux-x64",
      filename: RELEASE.filename,
      sha256: RELEASE.sha256,
      artifactDigest: RELEASE.artifactDigest,
    });
    expect(releaseManifestArtifactDigests(manifest)).toEqual({ "linux-x64": RELEASE.artifactDigest });
  });

  it("rejects a manifest with a split identity or invalid shape", () => {
    const manifest = makeManifest();
    expect(releaseManifestMatchesIdentity(manifest, { ...IDENTITY, semanticVersion: "9.9.9" })).not.toEqual([]);
    expect(validateReleaseManifest({ ...manifest, artifacts: [] })).toContain("artifacts must be a non-empty list");
    expect(validateReleaseManifest({ ...manifest, releaseChannel: "dev" }).some((error) => error.includes("not beta|stable"))).toBe(true);
    expect(validateReleaseManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0], sha256: "not-hex" }] }).some((error) => error.includes("sha256"))).toBe(true);
  });

  it("serializes deterministically for signature verification", () => {
    const manifest = makeManifest();
    const pair = generateSigningKeyPair();
    const bytes = serializeReleaseManifest(manifest);
    const envelope = signJson(pair.privateKey, JSON.parse(bytes));
    expect(verifyJsonSignature(pair.publicKey, JSON.parse(bytes), envelope)).toBe(true);
  });
});

describe("SBOM generation (#128)", () => {
  it("builds a deterministic SBOM from the ACTUAL artifact bytes referencing the exact digest", async () => {
    const root = await fixtureArtifactRoot({ extraPackages: [["zeta@2.0.0@Apache-2.0", "export const z = 1;"], ["alpha@1.1.0@MIT", "export const a = 1;"]] });
    const first = await buildSbomForArtifact(root, {
      filename: RELEASE.filename,
      sha256: RELEASE.sha256,
      artifactDigest: RELEASE.artifactDigest,
      releaseVersion: RELEASE.releaseVersion,
      releaseChannel: "beta",
      target: "linux-x64",
      sourceDateEpoch: 0,
    });
    const second = await buildSbomForArtifact(root, {
      filename: RELEASE.filename,
      sha256: RELEASE.sha256,
      artifactDigest: RELEASE.artifactDigest,
      releaseVersion: RELEASE.releaseVersion,
      releaseChannel: "beta",
      target: "linux-x64",
      sourceDateEpoch: 0,
    });
    expect(first).toEqual(second); // deterministic
    expect(validateSbom(first)).toEqual([]);
    expect(first.artifactRef).toEqual({ filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest });
    expect(first.packages.some((pkg) => pkg.name === "rly-gateway" && pkg.version === "1.0.0-beta.33")).toBe(true);
    expect(first.packages.some((pkg) => pkg.name === "fixture-dep" && pkg.version === "1.0.0")).toBe(true);
    expect(first.packages.some((pkg) => pkg.name === "pkg-zeta" && pkg.version === "2.0.0" && pkg.licenseConcluded === "Apache-2.0")).toBe(true);
    expect(first.packages.some((pkg) => pkg.name === "pkg-alpha" && pkg.version === "1.1.0")).toBe(true);
    const names = first.packages.map((pkg) => pkg.name);
    expect(names).toEqual([...names].sort());
  });

  it("fails verification when the SBOM references a different artifact digest", async () => {
    const sbom = await buildSbomForArtifact(await fixtureArtifactRoot(), {
      filename: RELEASE.filename,
      sha256: RELEASE.sha256,
      artifactDigest: RELEASE.artifactDigest,
      releaseVersion: RELEASE.releaseVersion,
      releaseChannel: "beta",
      target: "linux-x64",
      sourceDateEpoch: 0,
    });
    expect(verifySbomArtifactRef(sbom, { ...RELEASE, sha256: "e".repeat(64) })).not.toEqual([]);
    expect(verifySbomArtifactRef(sbom, RELEASE)).toEqual([]);
  });

  it("does not emit credentials or user content", async () => {
    const root = await fixtureArtifactRoot();
    const sbom = await buildSbomForArtifact(root, {
      filename: RELEASE.filename,
      sha256: RELEASE.sha256,
      artifactDigest: RELEASE.artifactDigest,
      releaseVersion: RELEASE.releaseVersion,
      releaseChannel: "beta",
      target: "linux-x64",
      sourceDateEpoch: 0,
    });
    const serialized = JSON.stringify(sbom);
    expect(serialized).not.toMatch(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
    expect(serialized).not.toMatch(/Bearer\s+\S{20,}/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

describe("build provenance (#128)", () => {
  it("ties artifact digests to the source revision and workflow/toolchain inputs", () => {
    const provenance = buildProvenance({
      releaseVersion: RELEASE.releaseVersion,
      releaseChannel: "beta",
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      workflow: { name: "standalone-artifacts", runId: "1234", workflowSha: RELEASE.sourceCommit },
      toolchain: { node: "24.19.0", pnpm: "11.16.0", os: "linux" },
      inputs: { targets: ["linux-x64"] },
      artifacts: [{ name: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest }],
      completionTimestamp: RELEASE.publishedAt,
    });
    expect(validateProvenance(provenance)).toEqual([]);
    expect(provenance.subject[0]).toEqual({ name: RELEASE.filename, digest: { sha256: RELEASE.sha256, rlyArtifactDigest: RELEASE.artifactDigest } });
    expect(provenance.predicate.invocation.configSource.digest.gitCommit).toBe(RELEASE.sourceCommit);
    expect(provenance.predicate.materials[0]?.digest.gitCommit).toBe(RELEASE.sourceCommit);
    expect(JSON.stringify(provenance)).not.toMatch(/Bearer\s+\S{20,}/i);
  });

  it("rejects provenance whose subjects do not match the published digests", () => {
    const provenance = buildProvenance({
      releaseVersion: RELEASE.releaseVersion,
      releaseChannel: "beta",
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      artifacts: [{ name: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest }],
      completionTimestamp: RELEASE.publishedAt,
    });
    expect(verifyProvenanceSubjects(provenance, [{ name: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest }])).toEqual([]);
    expect(verifyProvenanceSubjects(provenance, [{ name: RELEASE.filename, sha256: "f".repeat(64), artifactDigest: RELEASE.artifactDigest }])).not.toEqual([]);
    expect(verifyProvenanceSubjects(provenance, [])).toEqual([]);
  });
});

describe("signed channel metadata (#128)", () => {
  it("assigns monotonic per-channel version counters", () => {
    expect(channelVersionFor("1.0.0-beta.33", "beta")).toBe(33);
    expect(channelVersionFor("1.0.0-beta.2", "beta")).toBe(2);
    expect(channelVersionFor("0.1.0", "stable")).toBe(1_000);
    expect(channelVersionFor("1.0.3", "stable")).toBe(1_000_003);
    expect(channelVersionFor("1.0.10", "stable")).toBe(1_000_010);
    expect(channelVersionFor("1.0.0-beta.33", "stable")).toBeNull();
    expect(channelVersionFor("1.2.0", "stable")).toBe(1_002_000);
  });

  it("builds valid metadata mapping the channel to exact digests with explicit staleness/freeze", () => {
    const metadata = buildChannelMetadata({
      channel: "beta",
      releaseVersion: RELEASE.releaseVersion,
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      publishedAt: RELEASE.publishedAt,
      artifactDigests: { "linux-x64": { filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified", ref: "rly-qualification.json" },
    });
    expect(validateChannelMetadata(metadata)).toEqual([]);
    expect(metadata.version).toBe(33);
    expect(metadata.freeze).toEqual({ frozen: false });
    expect(metadata.staleness.maxAgeDays).toBe(30);
    expect(metadata.snapshots[0]?.artifacts["linux-x64"]?.artifactDigest).toBe(RELEASE.artifactDigest);
  });

  it("detects rollback: a lower version than the highest observed is refused", () => {
    const metadata = buildChannelMetadata({
      channel: "beta",
      releaseVersion: RELEASE.releaseVersion,
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      publishedAt: RELEASE.publishedAt,
      artifactDigests: { "linux-x64": { filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified" },
    });
    expect(evaluateChannelMetadata(metadata, { highestObservedVersion: 33 }).ok).toBe(true);
    const rolledBack = evaluateChannelMetadata(metadata, { highestObservedVersion: 34 });
    expect(rolledBack.ok).toBe(false);
    expect(rolledBack.rollbackDetected).toBe(true);
  });

  it("flags stale metadata older than the window", () => {
    const metadata = buildChannelMetadata({
      channel: "beta",
      releaseVersion: RELEASE.releaseVersion,
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      publishedAt: "2026-01-01T00:00:00.000Z",
      artifactDigests: { "linux-x64": { filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified" },
    });
    const evaluation = evaluateChannelMetadata(metadata, { now: "2026-03-15T00:00:00.000Z" });
    expect(evaluation.stale).toBe(true);
    expect(evaluation.ok).toBe(false);
  });

  it("honors an explicit freeze", () => {
    const metadata = buildChannelMetadata({
      channel: "beta",
      releaseVersion: RELEASE.releaseVersion,
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      publishedAt: RELEASE.publishedAt,
      artifactDigests: { "linux-x64": { filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified" },
      freeze: { frozen: true, reason: "incident QA freeze" },
    });
    const evaluation = evaluateChannelMetadata(metadata);
    expect(evaluation.frozen).toBe(true);
    expect(evaluation.ok).toBe(false);
  });

  it("never lets beta evidence masquerade as stable qualification", () => {
    const gaps = { "linux-x64": { status: "experimental-gaps" } };
    const qualified = { "linux-x64": { status: "qualified" } };
    expect(qualificationStatusForChannel(gaps, "beta")).toBe("experimental-gaps");
    expect(qualificationStatusForChannel(qualified, "beta")).toBe("qualified");
    expect(qualificationStatusForChannel(gaps, "stable")).toBe("not-qualified");
    expect(qualificationStatusForChannel(qualified, "stable")).toBe("qualified");
    expect(qualificationStatusForChannel({}, "stable")).toBe("not-qualified");
  });

  it("reads the qualification DOCUMENT shape ({ result }) so gaps are recorded, not hidden", () => {
    // The real rly-qualification.json per-target document carries `result`;
    // an experimental-gaps result must never surface as qualified in the channel.
    const docGaps = { "linux-x64": { result: "experimental-gaps" } };
    expect(qualificationStatusForChannel(docGaps, "beta")).toBe("experimental-gaps");
    expect(qualificationStatusForChannel(docGaps, "stable")).toBe("not-qualified");
  });
});

describe("exact-byte qualification (#128)", () => {
  it("derives qualified / experimental-gaps / not-qualified from gate statuses", () => {
    expect(deriveQualificationResult([gateResult("clean-install", "passed"), gateResult("identity", "passed")])).toBe("qualified");
    expect(deriveQualificationResult([gateResult("clean-install", "passed"), gateResult("identity", "skipped", { detail: "host not provisioned" })])).toBe("experimental-gaps");
    expect(deriveQualificationResult([gateResult("clean-install", "passed"), gateResult("identity", "failed", { detail: "mismatch" })])).toBe("not-qualified");
  });

  it("a skipped gate is never passing evidence and blocks stable promotion", () => {
    const qualification = {
      result: "experimental-gaps",
      gates: [gateResult("clean-install", "passed"), gateResult("identity", "skipped", { detail: "host not provisioned" })],
    };
    const blockers = qualificationBlocksStable(qualification);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.some((blocker) => blocker.includes("identity"))).toBe(true);
  });

  it("missing/failed required gates (incl. platform signing) block stable", () => {
    const qualification = {
      result: "not-qualified",
      gates: [
        gateResult("clean-install", "passed"),
        gateResult("identity", "passed"),
        gateResult("permissions", "passed"),
        gateResult("platform-signing", "skipped", { detail: "macOS codesign/notarization verification gate not run: requires a provisioned macOS host" }),
        gateResult("runtime-readiness", "passed"),
        gateResult("update-handoff", "passed"),
        gateResult("init-service-registration", "skipped", { detail: "no provisioned service manager" }),
        gateResult("uninstall", "passed"),
      ],
    };
    const blockers = qualificationBlocksStable(qualification);
    expect(blockers.some((blocker) => blocker.includes("platform-signing"))).toBe(true);
    expect(blockers.some((blocker) => blocker.includes("result is not-qualified"))).toBe(true);
  });

  it("no qualification record at all blocks stable", () => {
    expect(qualificationBlocksStable(undefined).length).toBeGreaterThan(0);
    expect(qualificationBlocksStable(null).length).toBeGreaterThan(0);
  });

  it("requires an exact target-set match between artifacts and qualification evidence", () => {
    expect(qualificationTargetSetErrors(["linux-x64"], { targets: { "linux-x64": {} } })).toEqual([]);
    expect(qualificationTargetSetErrors(["linux-x64", "darwin-arm64"], { targets: { "linux-x64": {} } })).toEqual([
      "artifact targets missing qualification evidence: darwin-arm64",
    ]);
    expect(qualificationTargetSetErrors(["linux-x64"], { targets: { "linux-x64": {}, "darwin-arm64": {} } })).toEqual([
      "qualification targets missing from release artifacts: darwin-arm64",
    ]);
  });

  it("binds Stable qualification to the exact version, channel, filename, and digests", () => {
    const artifact = {
      target: "linux-x64",
      filename: "rly-0.1.0-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      artifactDigest: "b".repeat(64),
    };
    const exact = {
      releaseVersion: "0.1.0",
      channel: "stable",
      target: "linux-x64",
      qualifiedBytes: { filename: artifact.filename, sha256: artifact.sha256, artifactDigest: artifact.artifactDigest },
    };
    expect(qualificationArtifactBindingErrors([artifact], { targets: { "linux-x64": exact } }, { releaseVersion: "0.1.0", channel: "stable" })).toEqual([]);
    const stale = {
      ...exact,
      releaseVersion: "9.9.9",
      qualifiedBytes: { filename: "wrong.tar.gz", sha256: "c".repeat(64), artifactDigest: "d".repeat(64) },
    };
    const errors = qualificationArtifactBindingErrors([artifact], { targets: { "linux-x64": stale } }, { releaseVersion: "0.1.0", channel: "stable" });
    expect(errors).toEqual(expect.arrayContaining([
      "linux-x64 releaseVersion 9.9.9 != 0.1.0",
      "linux-x64 qualifiedBytes.filename wrong.tar.gz != rly-0.1.0-linux-x64.tar.gz",
      `linux-x64 qualifiedBytes.sha256 ${"c".repeat(64)} != ${"a".repeat(64)}`,
      `linux-x64 qualifiedBytes.artifactDigest ${"d".repeat(64)} != ${"b".repeat(64)}`,
    ]));
  });

  it("runs the matrix against the exact bytes with an injected executor", async () => {
    const assembled = await assembleFixtureArtifact();
    const { artifactDir } = assembled;
    const pair = generateSigningKeyPair();
    // A real tarball so the clean-install gate extracts the exact bytes; the
    // digest/signature are the REAL values (the #129 verified-install gate
    // recomputes them, so a stub would fail the exact-byte comparison).
    const tarball = await tarballForTree(artifactDir, 0);
    const digest = sha256Of(tarball);
    await writeFile(`${artifactDir}.tar.gz`, tarball);
    await writeFile(`${artifactDir}.tar.gz.sig`, `${JSON.stringify(signDigestStatement(pair.privateKey, digest), null, 2)}\n`);
    // The verified-install gate runs against the SAME acquisition code rly
    // install consumes, injected from source: `dist/` is not built while
    // `pnpm test` runs (tests precede `pnpm build` in `pnpm verify`), so the
    // compiled-module default would skip the gate on a fresh CI checkout.
    const { verifyLocalAcquisition } = await import("../../src/installer/acquire.js");

    // Executable gates use a fake executor; static gates run for real.
    const executor = (_command: string, args: string[]): { ok: boolean; output: string } => {
      if (args.includes("doctor")) return { ok: true, output: '{"ok":true}' };
      if (args.includes("init")) return { ok: false, output: "no user systemd manager" };
      return { ok: true, output: JSON.stringify({ product: "rly-gateway", version: RELEASE.releaseVersion, commitRevision: RELEASE.sourceCommit, buildId: RELEASE.buildId, releaseChannel: "beta", controlProtocolVersion: 1, dataProtocolVersion: 1, stateSchemaVersion: 2, identitySchemaVersion: 1 }) };
    };
    const result = await runQualificationGates({
      artifactRoot: artifactDir,
      tarballPath: `${artifactDir}.tar.gz`,
      tarballSha256: digest,
      artifactDigest: assembled.metadata.artifactDigest as string,
      filename: RELEASE.filename,
      releaseManifest: makeManifest(),
      publicKeyPem: pair.publicKey,
      channel: "beta",
      target: "linux-x64",
      host: { platform: "linux", arch: "x64", os: "local" },
      executor,
      verifyLocalAcquisitionImpl: verifyLocalAcquisition as (options: {
        metadataDirectory: string;
        tarballPath: string;
        channel: "beta" | "stable";
        target: string;
        publicKeyPem?: string;
        now?: string;
        highestObservedVersion?: number;
      }) => Promise<{ version: string; artifactDigest: string }>,
    });
    expect(result.qualifiedBytes).toEqual({ filename: RELEASE.filename, sha256: digest, artifactDigest: assembled.metadata.artifactDigest });
    expect(result.gates.map((gate) => gate.id)).toEqual([
      "clean-install", "identity", "permissions", "platform-signing", "runtime-readiness", "update-handoff", "init-service-registration", "uninstall", "verified-install",
    ]);
    const gate = result.gates.find((g) => g.id === "verified-install");
    if (gate !== undefined && gate.status !== "passed") console.log("GATE-DETAIL", JSON.stringify(gate));
    expect(gate?.status).toBe("passed");
    expect(result.result).toBe("experimental-gaps");
    expect(qualificationBlocksStable(result).some((blocker) => blocker.includes("init-service-registration"))).toBe(true);
  });
});

describe("release immutability (#128)", () => {
  it("refuses silently replacing published bytes under the same release identity", () => {
    const existing = buildChannelMetadata({
      channel: "beta",
      releaseVersion: RELEASE.releaseVersion,
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      publishedAt: RELEASE.publishedAt,
      artifactDigests: { "linux-x64": { filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified" },
    });
    const same = makeManifest();
    expect(assertReleaseImmutable({ existingMetadata: existing, newManifest: same }).ok).toBe(true);
    const replaced = makeManifest({ artifactDigest: "9".repeat(64) });
    const result = assertReleaseImmutable({ existingMetadata: existing, newManifest: replaced });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/immutability violation/);
  });

  it("detects replacement of published bytes", () => {
    const metadata = buildChannelMetadata({
      channel: "stable",
      releaseVersion: "1.0.3",
      sourceCommit: RELEASE.sourceCommit,
      buildId: RELEASE.buildId,
      publishedAt: RELEASE.publishedAt,
      artifactDigests: { "linux-x64": { filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest, targetStatus: "supported" } },
      qualification: { status: "qualified" },
    });
    expect(detectAssetReplacement({ metadata, assets: [{ releaseVersion: "1.0.3", target: "linux-x64", filename: RELEASE.filename, sha256: RELEASE.sha256, artifactDigest: RELEASE.artifactDigest }] })).toEqual([]);
    const replaced = detectAssetReplacement({ metadata, assets: [{ releaseVersion: "1.0.3", target: "linux-x64", filename: RELEASE.filename, sha256: "7".repeat(64), artifactDigest: "8".repeat(64) }] });
    expect(replaced.length).toBe(1);
    expect(replaced[0]?.actualSha256).toBe("7".repeat(64));
  });
});

describe("publish + verify pipeline integration (#128)", () => {


  function run(nodeArgs: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, nodeArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("publishes and verifies a release end to end; tampering fails verification", async () => {
    const releaseDir = await buildReleaseDir();
    const keys = await directory();
    const pair = generateSigningKeyPair();
    await writeFile(join(keys, "private.pem"), pair.privateKey);
    await writeFile(join(keys, "public.pem"), pair.publicKey);

    const preSign = run([
      "scripts/release/sign-artifacts.mjs",
      "--release-dir", releaseDir,
      "--signing-key", join(keys, "private.pem"),
    ]);
    expect(preSign.status, preSign.stderr).toBe(0);
    const preSignedEnvelope = JSON.parse(readFileSync(join(releaseDir, `${RELEASE.filename}.sig`), "utf8")) as SignatureEnvelope;
    const exactTarballSha = sha256Of(readFileSync(join(releaseDir, RELEASE.filename)));
    expect(verifyDigestStatement(pair.publicKey, exactTarballSha, preSignedEnvelope)).toBe(true);

    const publishArgs = [
      "scripts/release/publish.mjs",
      "--release-dir", releaseDir,
      "--version", IDENTITY.semanticVersion,
      "--channel", "beta",
      "--source-commit", IDENTITY.commitRevision,
      "--build-id", IDENTITY.buildId,
      "--signing-key", join(keys, "private.pem"),
      "--public-key", join(keys, "public.pem"),
    ];
    const publish = run(publishArgs);
    expect(publish.status, publish.stderr).toBe(0);
    expect(readFileSync(join(releaseDir, "rly-release.json"), "utf8")).toContain(IDENTITY.semanticVersion);
    expect(readFileSync(join(releaseDir, "rly-channel-beta.json"), "utf8")).toContain('"channel": "beta"');
    expect(readFileSync(join(releaseDir, `${RELEASE.filename}.sig`), "utf8")).toContain("ed25519");

    const verifyArgs = [
      "scripts/release/verify-release.mjs",
      "--release-dir", releaseDir,
      "--channel", "beta",
      "--public-key", join(keys, "public.pem"),
    ];
    const verify = run(verifyArgs);
    expect(verify.status, verify.stderr).toBe(0);

    // Tampering with the published tarball must be detected (immutability).
    const tarballPath = join(releaseDir, RELEASE.filename);
    const original = readFileSync(tarballPath);
    const tampered = Buffer.from(original);
    tampered[100] = tampered[100] === 0x41 ? 0x42 : 0x41;
    await writeFile(tarballPath, tampered);
    const verifyTampered = run(verifyArgs);
    expect(verifyTampered.status).not.toBe(0);
    expect(verifyTampered.stderr).toMatch(/replacement or corruption|immutability violation/);
    await writeFile(tarballPath, original);

    // Stable channel verification blocks without full qualification evidence.
    const verifyStable = run([...verifyArgs, "--channel", "stable"]);
    expect(verifyStable.status).not.toBe(0);
    expect(verifyStable.stderr).toMatch(/stable/);
  });

  it("refuses republishing the same release version with different bytes", async () => {
    const releaseDir = await buildReleaseDir();
    const keys = await directory();
    const pair = generateSigningKeyPair();
    await writeFile(join(keys, "private.pem"), pair.privateKey);
    const base = [
      "scripts/release/publish.mjs",
      "--release-dir", releaseDir,
      "--version", IDENTITY.semanticVersion,
      "--channel", "beta",
      "--source-commit", IDENTITY.commitRevision,
      "--build-id", IDENTITY.buildId,
      "--signing-key", join(keys, "private.pem"),
    ];
    expect(run(base).status).toBe(0);
    // Change the artifact digest so the second publish would replace published bytes.
    const artifactDir = join(releaseDir, `rly-${IDENTITY.semanticVersion}-linux-x64`);
    const metadata = JSON.parse(readFileSync(join(artifactDir, "rly-artifact.json"), "utf8")) as { artifactDigest: string };
    metadata.artifactDigest = "c".repeat(64);
    await writeFile(join(artifactDir, "rly-artifact.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    const second = run(base);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/immutability violation/);
  });

  it("fails closed when Stable artifact and qualification target sets differ", async () => {
    const releaseDir = await buildReleaseDir();
    const keys = await directory();
    const pair = generateSigningKeyPair();
    await writeFile(join(keys, "private.pem"), pair.privateKey);
    await writeFile(join(releaseDir, "rly-qualification.json"), `${JSON.stringify({
      qualificationSchemaVersion: 1,
      targets: { "darwin-arm64": { result: "qualified" } },
    }, null, 2)}\n`);
    const result = run([
      "scripts/release/publish.mjs",
      "--release-dir", releaseDir,
      "--version", IDENTITY.semanticVersion,
      "--channel", "stable",
      "--source-commit", IDENTITY.commitRevision,
      "--build-id", IDENTITY.buildId,
      "--signing-key", join(keys, "private.pem"),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stable qualification evidence mismatch");
    expect(result.stderr).toContain("artifact targets missing qualification evidence: linux-x64");
    expect(result.stderr).toContain("qualification targets missing from release artifacts: darwin-arm64");
  });
});

describe("verified-install qualification gate (#129)", () => {
  it("verifies the exact artifact bytes and refuses tampered bytes", async () => {
    const releaseDir = await buildReleaseDir();
    const { runVerifiedInstallGate } = await import("../../scripts/release/qualification.mjs");
    const { verifyLocalAcquisition } = await import("../../src/installer/acquire.js");
    const tarballPath = join(releaseDir, RELEASE.filename);
    const tarballBytes = readFileSync(tarballPath);
    const sha256 = sha256Of(tarballBytes);
    const artifactDir = join(releaseDir, `rly-${IDENTITY.semanticVersion}-linux-x64`);
    const { treeDigest } = await import("../../scripts/standalone/pack.mjs");
    const artifactDigest = await treeDigest(artifactDir, { exclude: ["rly-artifact.json"] });
    const gate = await runVerifiedInstallGate({
      artifactRoot: artifactDir,
      tarballPath,
      tarballSha256: sha256,
      artifactDigest,
      filename: RELEASE.filename,
      channel: "beta",
      target: "linux-x64",
      releaseManifest: makeManifest(),
      publicKeyPem: "unused",
      repoRoot: join(process.cwd(), "..", "missing-dist-sentinel"), // force injectable verifier path
      verifyLocalAcquisitionImpl: verifyLocalAcquisition as (options: {
        metadataDirectory: string;
        tarballPath: string;
        channel: "beta" | "stable";
        target: string;
        publicKeyPem?: string;
        now?: string;
        highestObservedVersion?: number;
      }) => Promise<{ version: string; artifactDigest: string }>,
    });
    expect(gate.id).toBe("verified-install");
    expect(gate.status).toBe("passed");
    expect(gate.detail).toContain("tampered artifact refused");
  });

  it("records a skipped gate when the compiled installer module is unavailable", async () => {
    const { runVerifiedInstallGate } = await import("../../scripts/release/qualification.mjs");
    const gate = await runVerifiedInstallGate({
      artifactRoot: "/tmp/nonexistent",
      tarballPath: "/tmp/nonexistent.tgz",
      channel: "beta",
      target: "linux-x64",
      releaseManifest: makeManifest(),
      repoRoot: join(process.cwd(), "missing-dist"),
    });
    expect(gate.id).toBe("verified-install");
    expect(gate.status).toBe("skipped");
  });
});
