import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./file-utils.js";

export type RunIndexStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "error"
  | "success";

export type RunIndexEntry = {
  runId: string;
  projectId: string;
  generatedAt?: string;
  reviewCount?: number;
  reportPath?: string;
  reviewQueuePath?: string;
  status?: RunIndexStatus;
  startedAt?: string;
  updatedAt?: string;
  phase?: string;
  inferredDimensionsMm?: { width: number; height: number };
  inferredDpi?: number;
  dimensionConfidence?: number;
  dpiConfidence?: number;
};

const mergeEntry = (base: RunIndexEntry, update: RunIndexEntry): RunIndexEntry => {
  const output: RunIndexEntry = { ...base };
  (Object.keys(update) as Array<keyof RunIndexEntry>).forEach((key) => {
    const value = update[key];
    if (value !== undefined) {
      output[key] = value as never;
    }
  });
  return output;
};

// Serialize concurrent write operations per-file to avoid read-modify-write races.
const pendingWrites = new Map<string, Promise<void>>();

const serialize = async (key: string, fn: () => Promise<void>): Promise<void> => {
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  pendingWrites.set(key, next);
  try {
    await next;
  } finally {
    if (pendingWrites.get(key) === next) {
      pendingWrites.delete(key);
    }
  }
};

export const readRunIndex = async (outputDir: string): Promise<RunIndexEntry[]> => {
  const indexPath = path.join(outputDir, "run-index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const runs = (parsed as Record<string, unknown>).runs;
    return Array.isArray(runs) ? (runs as RunIndexEntry[]) : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      console.warn(`Failed to read run index at ${indexPath}`, error);
    }
    return [];
  }
};

export const updateRunIndex = async (outputDir: string, entry: RunIndexEntry): Promise<void> => {
  const indexPath = path.join(outputDir, "run-index.json");
  await serialize(indexPath, async () => {
    const runs = await readRunIndex(outputDir);
    const existingIndex = runs.findIndex((run) => run.runId === entry.runId);
    if (existingIndex >= 0) {
      runs[existingIndex] = mergeEntry(runs[existingIndex], entry);
    } else {
      runs.unshift(entry);
    }
    await writeJsonAtomic(indexPath, { runs });
  });
};

export const removeRunFromIndex = async (outputDir: string, runId: string): Promise<void> => {
  const indexPath = path.join(outputDir, "run-index.json");
  await serialize(indexPath, async () => {
    const runs = await readRunIndex(outputDir);
    const updated = runs.filter((run) => run.runId !== runId);
    await writeJsonAtomic(indexPath, { runs: updated });
  });
};

export const clearRunIndex = async (outputDir: string): Promise<void> => {
  const indexPath = path.join(outputDir, "run-index.json");
  await serialize(indexPath, async () => {
    await writeJsonAtomic(indexPath, { runs: [] });
  });
};
