#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const license = await readFile(resolve(root, "LICENSE"), "utf8");
if (!license.includes("MIT License")) {
  process.stderr.write("LICENSE is not MIT\n");
  process.exitCode = 1;
}
const copyright = license.split("\n").find((line) => line.startsWith("Copyright")) ?? "";
if (!copyright.includes("Trung Tao")) {
  process.stderr.write("LICENSE copyright was flipped\n");
  process.exitCode = 1;
}
if (process.exitCode) process.exit(process.exitCode);
process.stdout.write("License check passed\n");
