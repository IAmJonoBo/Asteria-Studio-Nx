import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const version = process.version.replace(/^v/, "");
const hasNvm = Boolean(process.env.NVM_DIR || process.env.NVM_BIN);

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
};

const writeJson = async (filePath, data) => {
  const output = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(filePath, output);
};

const writeText = async (filePath, value) => {
  await fs.writeFile(filePath, `${value}\n`);
};

const updateToolVersions = async (filePath, value) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split(/\r?\n/);
    const updated = lines.map((line) => {
      if (line.startsWith("nodejs ")) {
        return `nodejs ${value}`;
      }
      return line;
    });
    await fs.writeFile(filePath, `${updated.filter(Boolean).join("\n")}\n`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
};

const updatePackageEngines = async (filePath) => {
  const pkg = await readJson(filePath);
  const engines = { ...(pkg.engines ?? {}) };
  if (engines.node === version) return false;
  engines.node = version;
  const updated = { ...pkg, engines };
  await writeJson(filePath, updated);
  return true;
};

const run = async () => {
  if (!hasNvm) {
    console.warn("[sync-node-version] NVM not detected; using current Node.");
  }

  const targets = [
    path.join(ROOT, "package.json"),
    path.join(ROOT, "apps/asteria-desktop/package.json"),
  ];

  const updates = await Promise.all(targets.map(updatePackageEngines));

  await writeText(path.join(ROOT, ".nvmrc"), version);
  await writeText(path.join(ROOT, ".node-version"), version);
  await updateToolVersions(path.join(ROOT, ".tool-versions"), version);

  const changed = updates.some(Boolean);
  if (changed) {
    console.log(`[sync-node-version] Set engines.node to ${version}.`);
  } else {
    console.log(`[sync-node-version] engines.node already ${version}.`);
  }
};

run().catch((error) => {
  console.error("[sync-node-version] Failed to sync Node version.");
  console.error(error);
  process.exit(1);
});
