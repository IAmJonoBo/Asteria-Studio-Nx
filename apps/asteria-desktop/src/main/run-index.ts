import fs from "node:fs/promises";
import path from "node:path";

export type RunIndexStatus = "queued" | "running" | "paused" | "cancelled" | "error" | "success";

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

export const readRunIndex = async (outputDir: string): Promise<RunIndexEntry[]> => {
  const indexPath = path.join(outputDir, "run-index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as { runs?: RunIndexEntry[] };
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
};

export const updateRunIndex = async (outputDir: string, entry: RunIndexEntry): Promise<void> => {
  const indexPath = path.join(outputDir, "run-index.json");
  const runs = await readRunIndex(outputDir);
  const existingIndex = runs.findIndex((run) => run.runId === entry.runId);
  if (existingIndex >= 0) {
    runs[existingIndex] = mergeEntry(runs[existingIndex], entry);
  } else {
    runs.unshift(entry);
  }
  await fs.writeFile(indexPath, JSON.stringify({ runs }, null, 2));
};
