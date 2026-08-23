import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_IDENTITY_SCHEMA_VERSION,
  buildIdentityDigest,
  buildIdentityFromMeta,
  buildIdentitySchema,
  CONTROL_PROTOCOL_VERSION,
  DATA_PROTOCOL_VERSION,
  currentBuildIdentity,
  defaultBuildIdentity,
  exactIdentityMatch,
  readBuildIdentityFile,
  sameSemanticVersionDifferentArtifact,
  STATE_SCHEMA_VERSION,
  type BuildIdentity,
} from "../../src/runtime/build-identity.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-build-id-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const base: BuildIdentity = {
  identitySchemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
  product: "rly-gateway",
  semanticVersion: "0.1.0",
  commitRevision: "abc123",
  buildId: "build-1",
  releaseChannel: "dev",
  controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
  dataProtocolVersion: DATA_PROTOCOL_VERSION,
  stateSchemaVersion: STATE_SCHEMA_VERSION,
};

describe("exact build identity (#94)", () => {
  it("carries every required identity field and round-trips its schema", () => {
    const identity = { ...base, artifactId: "a".repeat(64) };
    expect(buildIdentitySchema.safeParse(identity).success).toBe(true);
    const parsed = buildIdentitySchema.parse(identity);
    expect(parsed).toEqual(identity);
    expect(parsed.semanticVersion).toBe("0.1.0");
    expect(parsed.commitRevision).toBe("abc123");
    expect(parsed.buildId).toBe("build-1");
    expect(parsed.releaseChannel).toBe("dev");
    expect(parsed.controlProtocolVersion).toBe(1);
    expect(parsed.dataProtocolVersion).toBe(1);
    expect(parsed.stateSchemaVersion).toBe(4);
    expect(parsed.artifactId).toBe("a".repeat(64));
  });

  it("rejects malformed identities (bad artifact digest, unknown channel)", () => {
    expect(buildIdentitySchema.safeParse({ ...base, artifactId: "not-hex" }).success).toBe(false);
    expect(buildIdentitySchema.safeParse({ ...base, releaseChannel: "canary" }).success).toBe(false);
    expect(buildIdentitySchema.safeParse({ ...base, controlProtocolVersion: 0 }).success).toBe(false);
  });

  it("distinguishes two artifacts sharing the same semantic version", () => {
    const artifactA = { ...base, artifactId: "a".repeat(64) };
    const artifactB = { ...base, artifactId: "b".repeat(64) };
    // Same semantic version, different artifact digest ⇒ distinguishable.
    expect(artifactA.semanticVersion).toBe(artifactB.semanticVersion);
    expect(sameSemanticVersionDifferentArtifact(artifactA, artifactB)).toBe(true);
    expect(exactIdentityMatch(artifactA, artifactB)).toBe(false);
    // Exact match requires the same digest.
    expect(exactIdentityMatch(artifactA, { ...base, artifactId: "a".repeat(64) })).toBe(true);
    expect(sameSemanticVersionDifferentArtifact(artifactA, { ...base, artifactId: "a".repeat(64) })).toBe(false);
    // Different semantic version is never the same-semver signal.
    expect(sameSemanticVersionDifferentArtifact(artifactA, { ...base, semanticVersion: "0.2.0", artifactId: "b".repeat(64) })).toBe(false);
  });

  it("distinguishes same-semver different builds without deployment digests", () => {
    const buildOne = { ...base, buildId: "one" };
    const buildTwo = { ...base, buildId: "two" };
    expect(sameSemanticVersionDifferentArtifact(buildOne, buildTwo)).toBe(true);
    expect(exactIdentityMatch(buildOne, buildTwo)).toBe(false);
    expect(exactIdentityMatch(buildOne, { ...buildOne })).toBe(true);
  });

  it("never exact-matches an identity with a digest against one without", () => {
    expect(exactIdentityMatch({ ...base }, { ...base, artifactId: "a".repeat(64) })).toBe(false);
    expect(sameSemanticVersionDifferentArtifact({ ...base }, { ...base, artifactId: "a".repeat(64) })).toBe(true);
  });

  it("computes a deterministic digest over the exact identity fields", () => {
    const identity = { ...base, artifactId: "a".repeat(64) };
    expect(buildIdentityDigest(identity)).toBe(createHash("sha256").update([
      "rly-gateway", "0.1.0", "abc123", "build-1", "dev", "1", "1", "4", "a".repeat(64),
    ].join("\0")).digest("hex"));
    // The artifact digest participates: same identity, different artifact ⇒
    // different identity digest.
    expect(buildIdentityDigest(identity)).not.toBe(buildIdentityDigest({ ...base, artifactId: "b".repeat(64) }));
  });

  it("provides a deterministic dev fallback when no build metadata exists", async () => {
    const identity = await currentBuildIdentity({});
    expect(identity).toEqual(defaultBuildIdentity());
    expect(identity.semanticVersion).toBe("0.1.0");
    expect(identity.commitRevision).toBe("dev");
    expect(identity.releaseChannel).toBe("dev");
    expect(identity.artifactId).toBeUndefined();
  });

  it("reads the generated build metadata file and attaches the serving artifact", async () => {
    const dir = await directory();
    const metaPath = join(dir, "rly-build.json");
    await writeFile(metaPath, JSON.stringify({
      semanticVersion: "1.2.3",
      commitRevision: "deadbeef",
      buildId: "b-42",
      releaseChannel: "beta",
      controlProtocolVersion: 1,
      dataProtocolVersion: 1,
      stateSchemaVersion: 2,
    }), "utf8");
    const meta = await readBuildIdentityFile(metaPath);
    expect(meta).toEqual({
      semanticVersion: "1.2.3",
      commitRevision: "deadbeef",
      buildId: "b-42",
      releaseChannel: "beta",
      controlProtocolVersion: 1,
      dataProtocolVersion: 1,
      stateSchemaVersion: 2,
    });
    if (meta === undefined) throw new Error("expected build metadata");
    const identity = buildIdentityFromMeta(meta);
    expect(identity.semanticVersion).toBe("1.2.3");
    expect(identity.releaseChannel).toBe("beta");
    expect(identity.artifactId).toBeUndefined();
    // RLY_SERVING_ARTIFACT (exported by the stable bootstrap) becomes the
    // serving artifact digest.
    const serving = await currentBuildIdentity({ RLY_SERVING_ARTIFACT: "c".repeat(64) });
    expect(serving.artifactId).toBe("c".repeat(64));
    expect(serving.semanticVersion).toBe("0.1.0"); // fallback identity in tests
    // A malformed artifact env is ignored (fail closed, never trusted).
    expect((await currentBuildIdentity({ RLY_SERVING_ARTIFACT: "junk" })).artifactId).toBeUndefined();
  });

  it("fails closed on a malformed generated metadata file", async () => {
    const dir = await directory();
    const metaPath = join(dir, "rly-build.json");
    await writeFile(metaPath, JSON.stringify({ semanticVersion: "1.2.3" }), "utf8");
    expect(await readBuildIdentityFile(metaPath)).toBeUndefined();
  });
});
