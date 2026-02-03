import fs from "node:fs";
import path from "node:path";

type LoadEnvResult = {
  loadedFiles: string[];
};

const parseEnv = (raw: string): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex === -1) continue;

    const key = withoutExport.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = withoutExport.slice(eqIndex + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      const hashIndex = value.indexOf("#");
      if (hashIndex !== -1) {
        value = value.slice(0, hashIndex).trim();
      }
    }

    value = value.replace(/\\n/g, "\n");
    entries[key] = value;
  }
  return entries;
};

const findRepoRoot = (startDir: string): string => {
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

export const loadEnv = (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): LoadEnvResult => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const repoRoot = findRepoRoot(cwd);
  const candidates = [path.join(repoRoot, ".env"), path.join(repoRoot, ".env.local")];
  const loadedFiles: string[] = [];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseEnv(raw);
      for (const [key, value] of Object.entries(parsed)) {
        if (env[key] === undefined) {
          env[key] = value;
        }
      }
      loadedFiles.push(filePath);
    } catch {
      // ignore parse errors; keep going
    }
  }

  return { loadedFiles };
};
