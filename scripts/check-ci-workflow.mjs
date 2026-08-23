#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

const workflow = await readFile(".github/workflows/ci.yml", "utf8");
const required = [
  [/pull_request:\n\s+branches: \[dev, main\]/, "PR targets dev and main"],
  [/types: \[opened, synchronize, reopened, ready_for_review, edited\]/, "PR-title edit trigger"],
  [/name: required-ci\n\s+if: \$\{\{ always\(\) \}\}\n\s+needs: \[.*conventional-commit.*verify.*\]/, "always-run aggregate dependencies"],
  [/TITLE_RESULT: \$\{\{ needs\.conventional-commit\.result \}\}/, "aggregate title result"],
  [/RITUAL_RESULT: \$\{\{ needs\.ritual-gate\.result \}\}/, "aggregate ritual result"],
  [/VERIFY_RESULT: \$\{\{ needs\.verify\.result \}\}/, "aggregate verify result"],
  [/test "\$TITLE_RESULT" = success/, "aggregate title success guard"],
  [/test "\$RITUAL_RESULT" = success/, "aggregate ritual success guard"],
  [/test "\$VERIFY_RESULT" = success/, "aggregate verify success guard"],
];
for (const [pattern, description] of required) {
  if (!pattern.test(workflow)) throw new Error(`CI workflow is missing ${description}`);
}
if (/^\s*push:/m.test(workflow)) throw new Error("full CI must not run on branch pushes");
if (workflow.indexOf("pnpm/action-setup@v4") > workflow.indexOf("actions/setup-node@v4")) {
  throw new Error("pnpm must be installed before setup-node enables pnpm caching");
}
process.stdout.write("CI workflow contract passed\n");
