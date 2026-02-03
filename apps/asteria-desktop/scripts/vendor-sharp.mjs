import fs from "node:fs/promises";
import path from "node:path";
import { info, note, section, startStep } from "./cli.mjs";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "..", "..");
const storeRoot = path.join(repoRoot, "node_modules", ".pnpm", "node_modules", "@img");
const destRoot = path.join(appRoot, "node_modules", "@img");

const platform = process.platform;
const arch = process.arch;

const platformKey = `${platform}-${arch}`;
const sharpPkg = `sharp-${platformKey}`;
const libvipsPkg = `sharp-libvips-${platformKey}`;

const resolveDir = async (target) => {
  try {
    const real = await fs.realpath(target);
    return real;
  } catch {
    return target;
  }
};

const copyDir = async (src, dest) => {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const resolved = await resolveDir(src);
  await fs.cp(resolved, dest, { recursive: true });
};

const exists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  section("VENDOR SHARP BINARIES");
  info(`Platform: ${platformKey}`);
  info(`Source store: ${storeRoot}`);
  info(`Destination: ${destRoot}`);

  const packages = [sharpPkg, libvipsPkg];
  const copyStep = startStep("Copy platform packages");
  let copied = 0;

  for (const pkg of packages) {
    const src = path.join(storeRoot, pkg);
    const dest = path.join(destRoot, pkg);
    if (!(await exists(src))) {
      note(`Missing in store: ${src}`);
      continue;
    }
    await copyDir(src, dest);
    info(`Copied ${pkg}`);
    copied += 1;
  }

  if (copied === 0) {
    copyStep("warn", "no platform packages copied");
    return;
  }

  copyStep("ok", `${copied} package(s) copied`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
