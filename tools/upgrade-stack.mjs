import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const CACHE_DIR = path.join(ROOT, ".cache");
const STATE_PATH = path.join(CACHE_DIR, "upgrade-stack.json");
const DAY_MS = 24 * 60 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const force = args.has("--force") || process.env.FORCE_UPGRADE === "1";
const onlyDeps = args.has("--deps");
const onlyTrunk = args.has("--trunk");
const runDeps = onlyDeps || (!onlyDeps && !onlyTrunk);
const runTrunk = onlyTrunk || (!onlyDeps && !onlyTrunk);
const cooldownMs = Number(process.env.UPGRADE_COOLDOWN_HOURS ?? 24) * 60 * 60 * 1000;

const readState = async () => {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
};

const writeState = async (state) => {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
};

const isFresh = (timestamp) =>
  typeof timestamp === "number" &&
  Number.isFinite(timestamp) &&
  Date.now() - timestamp < cooldownMs;

const runCommand = (command, argsList, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argsList, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...extraEnv },
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${argsList.join(" ")} failed with ${code}`));
    });
  });

const main = async () => {
  const state = await readState();
  const nextState = { ...state };

  if (runDeps) {
    if (!force && isFresh(state.depsAt)) {
      console.log("[upgrade:stack] Skipping deps update (recently run).");
    } else {
      console.log("[upgrade:stack] Updating dependencies...");
      await runCommand("pnpm", ["-r", "update"]);
      nextState.depsAt = Date.now();
    }
  }

  if (runTrunk) {
    if (!force && isFresh(state.trunkAt)) {
      console.log("[upgrade:stack] Skipping Trunk upgrade (recently run).");
    } else {
      console.log("[upgrade:stack] Upgrading Trunk tools...");
      await runCommand("trunk", ["upgrade"], { CI: "1", TRUNK_NONINTERACTIVE: "1" });
      nextState.trunkAt = Date.now();
    }
  }

  console.log("[upgrade:stack] Syncing Node version metadata...");
  await runCommand("pnpm", ["sync:node-version"]);

  await writeState(nextState);
};

main().catch((error) => {
  console.error("[upgrade:stack] Failed.");
  console.error(error?.message ?? error);
  process.exit(1);
});
