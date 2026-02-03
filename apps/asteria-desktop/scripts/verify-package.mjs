import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { info, note, section, startStep } from "./cli.mjs";

const appRoot = process.cwd();
const distRoot = path.join(appRoot, "dist-app");

const statSafe = async (target) => {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
};

const walk = async (root, matcher) => {
  const matches = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stats = await statSafe(current);
    if (!stats) continue;
    if (stats.isDirectory()) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        stack.push(path.join(current, entry.name));
      }
    } else if (matcher(current)) {
      matches.push(current);
    }
  }
  return matches;
};

const findUnpackedRoots = async (root) => {
  return walk(root, (target) => target.endsWith("app.asar.unpacked"));
};

const fileSize = async (file) => {
  const stats = await statSafe(file);
  return stats ? formatBytes(stats.size) : "missing";
};

const listArtifacts = async (root) => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(root, entry.name);
    info(`${entry.name}: ${await fileSize(full)}`);
  }
};

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} failed`);
  }
};

const runCapture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const findMountedVolumes = (dmgPath) => {
  const infoResult = runCapture("hdiutil", ["info"]);
  if (infoResult.status !== 0) return [];

  const mounts = [];
  let currentMatches = false;
  for (const line of infoResult.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("image-path")) {
      const value = trimmed.split(":").slice(1).join(":").trim();
      currentMatches = value === dmgPath || value.endsWith(path.basename(dmgPath));
      continue;
    }
    if (currentMatches && trimmed.startsWith("mount-point")) {
      const mountPoint = trimmed.split(":").slice(1).join(":").trim();
      if (mountPoint) mounts.push(mountPoint);
      continue;
    }
    if (currentMatches && trimmed.includes("/dev/disk")) {
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last?.startsWith("/")) {
        mounts.push(last);
      }
    }
    if (!trimmed) currentMatches = false;
  }

  return mounts;
};

const detachExistingMounts = async (dmgPath) => {
  const mounts = findMountedVolumes(dmgPath);
  for (const mount of mounts) {
    try {
      run("hdiutil", ["detach", mount, "-force"]);
    } catch {
      // ignore
    }
  }
};

const findAppUnpackedInMount = async (mountRoot) => {
  const entries = await fs.readdir(mountRoot, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appEntry) return [];
  const appRoot = path.join(mountRoot, appEntry.name);
  const unpacked = path.join(appRoot, "Contents", "Resources", "app.asar.unpacked");
  const stats = await statSafe(unpacked);
  if (stats?.isDirectory()) {
    return [unpacked];
  }
  return [];
};

const withMountedDmg = async (dmgPath, fn) => {
  const existingMounts = findMountedVolumes(dmgPath);
  if (existingMounts.length > 0) {
    return await fn(existingMounts[0]);
  }

  const mountRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "asteria-dmg-"));
  let attached = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runCapture("hdiutil", [
      "attach",
      dmgPath,
      "-nobrowse",
      "-noverify",
      "-readonly",
      "-mountpoint",
      mountRoot,
    ]);
    if (result.status === 0) {
      attached = true;
      break;
    }
    if (result.stderr.includes("Resource busy")) {
      await detachExistingMounts(dmgPath);
      continue;
    }
    throw new Error(`hdiutil failed: ${result.stderr.trim() || "unknown error"}`);
  }

  if (!attached) {
    throw new Error("hdiutil failed after retry");
  }

  try {
    return await fn(mountRoot);
  } finally {
    try {
      run("hdiutil", ["detach", mountRoot, "-force"]);
    } catch {
      // best-effort detach
    }
  }
};

const main = async () => {
  section("PACKAGED ARTEFACT VERIFY");
  info(`Dist: ${distRoot}`);

  const distStats = await statSafe(distRoot);
  if (!distStats || !distStats.isDirectory()) {
    console.error(`Missing dist-app directory at ${distRoot}`);
    process.exit(1);
  }

  note("Top-level artefacts:");
  await listArtifacts(distRoot);

  let unpackedRoots = await findUnpackedRoots(distRoot);
  if (unpackedRoots.length === 0) {
    const entries = await fs.readdir(distRoot, { withFileTypes: true });
    const dmgEntries = entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".dmg") &&
        !entry.name.startsWith(".temp")
    );
    const dmgFiles = dmgEntries.map((entry) => path.join(distRoot, entry.name));
    const fallbackDmgFiles =
      dmgFiles.length === 0
        ? entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dmg"))
            .map((entry) => path.join(distRoot, entry.name))
        : dmgFiles;

    if (fallbackDmgFiles.length > 0) {
      if (process.platform !== "darwin") {
        note("DMG found, but unpack verification requires macOS. Skipping native module checks.");
        process.exit(0);
      }

      const dmgPath = fallbackDmgFiles[0];
      note(`Mounting DMG for inspection: ${path.basename(dmgPath)}`);
      await withMountedDmg(dmgPath, async (mountRoot) => {
        unpackedRoots = await findAppUnpackedInMount(mountRoot);
        if (unpackedRoots.length === 0) {
          unpackedRoots = await findUnpackedRoots(mountRoot);
        }
      });
    }
  }

  if (unpackedRoots.length === 0) {
    console.error("No app.asar.unpacked directory found.");
    process.exit(1);
  }

  const verifyStep = startStep("Verify native module unpacking");
  let missing = 0;

  for (const root of unpackedRoots) {
    const sharpDir = path.join(root, "node_modules", "sharp");
    const imgDir = path.join(root, "node_modules", "@img");
    const sharpStats = await statSafe(sharpDir);
    const imgStats = await statSafe(imgDir);

    if (!sharpStats?.isDirectory()) {
      missing += 1;
      note(`Missing sharp in ${root}`);
    } else {
      info(`Sharp unpacked: ${sharpDir}`);
    }

    if (!imgStats?.isDirectory()) {
      missing += 1;
      note(`Missing @img in ${root}`);
    } else {
      info(`@img unpacked: ${imgDir}`);
    }

    const nodeBinaries = await walk(root, (target) => target.endsWith(".node"));
    if (nodeBinaries.length === 0) {
      missing += 1;
      note(`No native .node binaries found in ${root}`);
    } else {
      info(`Native binaries: ${nodeBinaries.length}`);
    }
  }

  if (missing > 0) {
    verifyStep("fail", `${missing} check(s) failed`);
    process.exit(1);
  }

  verifyStep("ok", "native modules unpacked");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
