import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

const forbidden = [
  { name: "email identity", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "bearer credential", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { name: "JWT-like credential", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "user cliproxy auth path", pattern: /\.ccs\/cliproxy\/auth/ },
  { name: "live token field", pattern: /"(accessToken|refreshToken|idToken|clientSecret)"\s*:\s*"[^"]+"/ },
];

type ManagementDto = {
  account: Record<string, unknown>;
  absentFields: string[];
};

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...collectFiles(path));
    else files.push(path);
  }
  return files;
}

function relativeToRoot(file: string): string {
  return file.slice(root.length + 1);
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(root, relative), "utf8"));
}

describe("upstream fixtures stay synthetic", () => {
  const fixtureFiles = collectFiles(join(root, "tests/fixtures/upstream"));


  it("includes sanitized compatibility fixtures", () => {
    expect(fixtureFiles.map(relativeToRoot)).toEqual(expect.arrayContaining([
      "tests/fixtures/upstream/ccs/profile-target-shape.json",
      "tests/fixtures/upstream/ccs/pool-policy.json",
      "tests/fixtures/upstream/opencodex/credential-generation-shape.json",
      "tests/fixtures/upstream/opencodex/eligibility-decision.json",
      "tests/fixtures/upstream/opencodex/management-dto.json",
      "tests/fixtures/upstream/opencodex/oauth-pkce-shape.json",
      "tests/fixtures/upstream/claude-proxy/helper-model-map.json",
      "tests/fixtures/upstream/claude-proxy/sse-event-shape.json",
      "tests/fixtures/upstream/rejected-patterns.json",
      "tests/fixtures/upstream/cliproxy-plus/bridge-only.json",
      "tests/fixtures/upstream/clinepass/auth-shape.json",
    ]));
  });

  it("contains no credential, identity, or live payload markers", () => {
    const findings: string[] = [];
    for (const file of fixtureFiles) {
      const content = readFileSync(file, "utf8");
      for (const rule of forbidden) {
        if (rule.pattern.test(content)) findings.push(`${relativeToRoot(file)}: ${rule.name}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("keeps management DTO free of secret-bearing fields", () => {
    const dto = readJson("tests/fixtures/upstream/opencodex/management-dto.json") as ManagementDto;
    expect(dto.absentFields).toEqual(expect.arrayContaining([
      "accessToken",
      "refreshToken",
      "authorization",
      "email",
      "prompt",
      "response",
    ]));
    for (const field of dto.absentFields) {
      expect(dto.account).not.toHaveProperty(field);
    }
  });
});
