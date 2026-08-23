import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { artifactIdSchema } from "./update/types.js";
import { RUNTIME_VERSION } from "./gateway-attestation.js";
import { SCHEMA_V4_VERSION } from "../storage/schema-v4.js";

/**
 * Exact build identity (#94). One versioned identity object is shared by
 * `/identity`, `rly --version`, diagnostics, the release-candidate manifest
 * (`rly.json`), deployment metadata, and update probation, so every surface
 * can compare the SAME exact build/artifact identity fields.
 *
 * The identity binds:
 *   - semantic version (package version),
 *   - commit/source revision,
 *   - build ID (per-build),
 *   - release channel (dev | beta | stable),
 *   - control/data protocol versions,
 *   - durable state/schema version,
 *   - artifact digest — the #92 content-addressed deployment identity when the
 *     runtime is serving from the immutable store (`refs/active`), so two
 *     byte-distinct artifacts sharing a semantic version are distinguishable.
 *
 * All fields are public, non-secret build metadata. Credentials, account
 * identity, prompts, responses, and reasoning text never enter this object.
 */

export const BUILD_IDENTITY_SCHEMA_VERSION = 1;
export const PRODUCT_NAME = "rly-gateway";
/** Control (management/data attestation) protocol version shared by CLI/runtime. */
export const CONTROL_PROTOCOL_VERSION = 1;
/** Data-plane wire protocol version (currently unified with control). */
export const DATA_PROTOCOL_VERSION = 1;
/** Durable control-plane state/schema version the runtime was built against. */
export const STATE_SCHEMA_VERSION = SCHEMA_V4_VERSION;

export const RELEASE_CHANNELS = ["dev", "beta", "stable"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const buildIdentitySchema = z.object({
  identitySchemaVersion: z.literal(BUILD_IDENTITY_SCHEMA_VERSION),
  product: z.literal(PRODUCT_NAME),
  semanticVersion: z.string().min(1),
  commitRevision: z.string().min(1),
  buildId: z.string().min(1),
  releaseChannel: z.enum(RELEASE_CHANNELS),
  controlProtocolVersion: z.number().int().positive(),
  dataProtocolVersion: z.number().int().positive(),
  stateSchemaVersion: z.number().int().positive(),
  /**
   * Content-addressed immutable deployment identity (#92) when this runtime is
   * serving from `refs/active`; absent for dev/foreground runs. Present on the
   * serving runtime's `/identity` so same-semver-different-artifact is an
   * observable, comparable distinction.
   */
  artifactId: artifactIdSchema.optional(),
});

export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

/** `dist/rly-build.json` (inside the deployment tree when built). */
const BUILD_META_URL = new URL("../rly-build.json", import.meta.url);

/** Deterministic dev/fallback identity used when no build metadata file exists. */
export function defaultBuildIdentity(): BuildIdentity {
  return {
    identitySchemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    semanticVersion: RUNTIME_VERSION,
    commitRevision: "dev",
    buildId: "dev",
    releaseChannel: "dev",
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
    dataProtocolVersion: DATA_PROTOCOL_VERSION,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
  };
}

/** Shape of the generated `dist/rly-build.json` (subset of BuildIdentity). */
export type BuildMeta = Readonly<{
  semanticVersion: string;
  commitRevision: string;
  buildId: string;
  releaseChannel: ReleaseChannel;
  controlProtocolVersion: number;
  dataProtocolVersion: number;
  stateSchemaVersion: number;
}>;

const buildMetaSchema = z.object({
  semanticVersion: z.string().min(1),
  commitRevision: z.string().min(1),
  buildId: z.string().min(1),
  releaseChannel: z.enum(RELEASE_CHANNELS),
  controlProtocolVersion: z.number().int().positive(),
  dataProtocolVersion: z.number().int().positive(),
  stateSchemaVersion: z.number().int().positive(),
});

export function buildIdentityFromMeta(meta: BuildMeta): BuildIdentity {
  return {
    identitySchemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
    product: PRODUCT_NAME,
    ...meta,
  };
}

/** Reads and validates a generated build-metadata file. Missing/invalid ⇒ undefined. */
export async function readBuildIdentityFile(path: string | URL): Promise<BuildMeta | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = buildMetaSchema.safeParse(JSON.parse(contents) as unknown);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Resolves the current build identity: the generated `dist/rly-build.json`
 * when present (built tree), otherwise the deterministic dev fallback. The
 * serving artifact digest is taken from `RLY_SERVING_ARTIFACT`, exported by
 * the stable bootstrap when it launches the committed `refs/active`
 * deployment; dev/foreground runs report no artifact identity.
 */
export async function currentBuildIdentity(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<BuildIdentity> {
  const meta = await readBuildIdentityFile(BUILD_META_URL);
  const identity = meta === undefined ? defaultBuildIdentity() : buildIdentityFromMeta(meta);
  const artifact = environment["RLY_SERVING_ARTIFACT"];
  return artifact !== undefined && artifactIdSchema.safeParse(artifact).success
    ? { ...identity, artifactId: artifact }
    : identity;
}

/**
 * Deterministic digest over the exact build identity fields (including the
 * artifact digest when present). Used for the ownership-record executable
 * fingerprint so reuse/attestation is build-aware.
 */
export function buildIdentityDigest(identity: BuildIdentity): string {
  return createHash("sha256")
    .update([
      identity.product,
      identity.semanticVersion,
      identity.commitRevision,
      identity.buildId,
      identity.releaseChannel,
      String(identity.controlProtocolVersion),
      String(identity.dataProtocolVersion),
      String(identity.stateSchemaVersion),
      identity.artifactId ?? "",
    ].join("\0"))
    .digest("hex");
}

/**
 * Exact build identity match: every field must be equal, including the
 * artifact digest when present. An identity lacking an artifact digest never
 * exact-matches one that has it (and vice versa).
 */
export function exactIdentityMatch(left: BuildIdentity, right: BuildIdentity): boolean {
  return buildIdentityDigest(left) === buildIdentityDigest(right);
}

/**
 * Distinguishes two artifacts that share a semantic version but are NOT the
 * same exact artifact: same `semanticVersion`, different artifact identity
 * (content-addressed deployment digest when known, else buildId/commit).
 * This is the "same semantic version, different artifact" signal used by
 * reuse/probation/diagnostics.
 */
export function sameSemanticVersionDifferentArtifact(left: BuildIdentity, right: BuildIdentity): boolean {
  if (left.semanticVersion !== right.semanticVersion) return false;
  return artifactIdentity(left) !== artifactIdentity(right);
}

function artifactIdentity(identity: BuildIdentity): string {
  return identity.artifactId ?? `${identity.commitRevision}:${identity.buildId}`;
}
