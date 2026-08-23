import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import process from "node:process";

const files = [
  ...execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n"),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n"),
].filter(Boolean).filter((file) => !file.startsWith("plans/"));

function pemHeader(kind) {
  return new RegExp(`-----BEGIN ${kind}PRIVATE KEY-----`);
}

const forbiddenContent = [
  { name: "RSA private key", pattern: pemHeader("RSA ") },
  { name: "EC private key", pattern: pemHeader("EC ") },
  { name: "OPENSSH private key", pattern: pemHeader("OPENSSH ") },
  { name: "DSA private key", pattern: pemHeader("DSA ") },
  { name: "encrypted private key", pattern: pemHeader("ENCRYPTED ") },
  { name: "PKCS8 private key", pattern: pemHeader("") },
  { name: "bearer credential", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { name: "JWT-like credential", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const forbiddenPaths = [
  { name: "ledger.sqlite", pattern: /(^|\/)ledger\.sqlite$/ },
  { name: "pool_health", pattern: /(^|\/)pool_health(\.|$)/ },
  { name: "governance_keys", pattern: /(^|\/)governance_keys(\.|$)/ },
];
const findings = [];
for (const file of files) {
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(file)) findings.push(`${file}: ${rule.name}`);
  }
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(content)) findings.push(`${file}: ${rule.name}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Privacy scan passed (${String(files.length)} files)\n`);
}
