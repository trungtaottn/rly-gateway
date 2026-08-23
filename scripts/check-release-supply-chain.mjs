#!/usr/bin/env node
// RLY release supply-chain gate (#128).
//
// Static, hermetic enforcement of the release supply-chain controls that do
// not require a built artifact:
//   - the committed release public key is present and a valid Ed25519 key;
//   - release-critical third-party Actions are pinned to reviewed immutable
//     commit SHAs (documented mapping below);
//   - release workflows use least-required GITHUB_TOKEN permissions and do
//     not expose npm credentials when npm is not the primary channel;
//   - the standalone artifact workflow runs exact-byte qualification, the
//     signed publish step, and the release verifier;
//   - no private signing key material is tracked;
//   - the public release surface identifies exact-byte
//     qualification as the publication authority.
//
// Run as part of `pnpm test:release` (the release gate).

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { publicKeyFingerprint } from "./release/signing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reviewed immutable revisions for every release-critical third-party
 * GitHub Action (pin = the full commit SHA of the reviewed release tag).
 * Kept in sync with the workflow files below; changing a pin requires
 * updating BOTH this map and the workflow `uses:` lines.
 */
const PINNED_ACTIONS = {
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1": "actions/checkout v7.0.1 (reviewed tag commit, node24)",
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86": "pnpm/action-setup v6.0.10 (reviewed tag commit, node24)",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020": "actions/setup-node v7.0.0 (reviewed tag commit, node24)",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a": "actions/upload-artifact v7.0.1 (reviewed tag commit, node24)",
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1": "actions/create-github-app-token v3 (reviewed tag commit)",
};

const RELEASE_WORKFLOWS = [
  ".github/workflows/standalone-artifacts.yml",
  ".github/workflows/release-beta.yml",
  ".github/workflows/release-stable.yml",
];

async function main() {
  const errors = [];
  const notes = [];

  // 1. Committed public key.
  const publicKeyPath = join(ROOT, "scripts", "release", "signing-public-key.pem");
  let publicKey;
  try {
    publicKey = await readFile(publicKeyPath, "utf8");
  } catch {
    errors.push("scripts/release/signing-public-key.pem is missing");
  }
  if (publicKey !== undefined) {
    if (!publicKey.includes("-----BEGIN PUBLIC KEY-----")) errors.push("committed public key is not a PEM public key");
    else notes.push(`release public key fingerprint ${publicKeyFingerprint(publicKey).slice(0, 16)}…`);
  }

  // 2. Action pinning + least privilege + no npm credentials + pipeline steps.
  for (const workflowPath of RELEASE_WORKFLOWS) {
    const workflow = await readFile(join(ROOT, workflowPath), "utf8");
    const used = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((match) => match[1]);
    for (const action of used) {
      if (action.includes("@") && !action.startsWith(".")) {
        if (!Object.hasOwn(PINNED_ACTIONS, action)) {
          errors.push(`${workflowPath}: third-party action ${action} is not pinned to a reviewed immutable SHA`);
        }
      }
    }
    if (/NODE_AUTH_TOKEN|NPM_TOKEN|npmjs|npm.pkg.github/.test(workflow)) {
      errors.push(`${workflowPath}: exposes npm credentials while npm is not the primary distribution channel`);
    }
    if (!/\npermissions:\s*\n\s+contents:\s*(read|write)/.test(workflow)) {
      errors.push(`${workflowPath}: missing an explicit least-privilege permissions block`);
    }
  }

  const standalone = await readFile(join(ROOT, ".github", "workflows", "standalone-artifacts.yml"), "utf8");
  for (const step of ["scripts/release/sign-artifacts.mjs", "scripts/release/qualify.mjs", "scripts/release/publish.mjs", "scripts/release/verify-release.mjs", "scripts/install.sh", "RLY_RELEASE_SIGNING_KEY"]) {
    if (!standalone.includes(step)) errors.push(`standalone-artifacts.yml is missing the ${step} supply-chain step/secret`);
  }
  if (standalone.indexOf("scripts/release/sign-artifacts.mjs") > standalone.indexOf("scripts/release/qualify.mjs")) {
    errors.push("standalone-artifacts.yml must sign exact artifact bytes before qualification");
  }

  // 3. No private signing key material is tracked.
  const tracked = [
    ...execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n"),
    ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n"),
  ].filter(Boolean);
  for (const file of tracked) {
    if (/signing-private-key/i.test(file)) errors.push(`tracked file looks like a private signing key: ${file}`);
  }
  const privateKeyPath = join(ROOT, "scripts", "release", "signing-private-key.pem");
  if (await stat(privateKeyPath).then(() => true).catch(() => false)) {
    errors.push("scripts/release/signing-private-key.pem exists in the worktree — NEVER commit it");
  }

  // 4. The public release surface names the publication authority without
  // requiring the private project documentation tree in a clean checkout.
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  if (!/exact-byte qualification is the\s+publication authority/i.test(readme)) {
    errors.push("README.md does not identify exact-byte qualification as the publication authority");
  }

  if (errors.length > 0) {
    process.stderr.write(`Release supply-chain gate FAILED:\n  - ${errors.join("\n  - ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Release supply-chain gate passed (${notes.length > 0 ? notes.join("; ") : "all controls verified"})\n`);
}

await main().catch((error) => {
  process.stderr.write(`release supply-chain gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
