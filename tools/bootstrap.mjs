#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const findRepoRoot = (startDir) => {
  let current = startDir;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const runCapture = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || "").trim();
};

const banner = (title) => {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
};

const main = () => {
  const repoRoot = findRepoRoot(process.cwd());

  banner("ASTERIA BOOTSTRAP");
  console.log(`Repo: ${repoRoot}`);

  const pnpmVersion = runCapture("pnpm", ["--version"]);
  if (!pnpmVersion) {
    console.error("pnpm not found. Install pnpm (or enable corepack) and retry.");
    process.exit(1);
  }
  console.log(`pnpm: ${pnpmVersion}`);

  banner("Installing dependencies (pnpm install)");
  run("pnpm", ["install"], { cwd: repoRoot });

  banner("Checking Rust toolchain (optional)");
  const rustcVersion = runCapture("rustc", ["--version"]);
  const cargoVersion = runCapture("cargo", ["--version"]);

  if (!rustcVersion && !cargoVersion) {
    console.log("Rust toolchain not found. This is optional for now.");
    console.log("If you plan to work on native CV stages, install via rustup.");
    return;
  }

  if (rustcVersion) console.log(`rustc: ${rustcVersion}`);
  if (cargoVersion) console.log(`cargo: ${cargoVersion}`);
  console.log("Rust toolchain OK.");
};

try {
  main();
} catch (error) {
  console.error("Bootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
