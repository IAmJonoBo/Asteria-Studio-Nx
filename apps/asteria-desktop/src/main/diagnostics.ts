import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { app } from "electron";
import { getAppInfo } from "./app-info.js";
import { getAsteriaRoot, loadPreferences } from "./preferences.js";
import { readRunIndex } from "./run-index.js";
import {
  getRunDir,
  getRunManifestPath,
  getRunReportPath,
  getRunReviewQueuePath,
  getRunLogPath,
} from "./run-paths.js";

const ensureDir = async (dir: string): Promise<void> => {
  await fsp.mkdir(dir, { recursive: true });
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "ENOENT") {
      console.warn(`Diagnostics stat failed for ${target}`, error);
    }
    return false;
  }
};

const copyFileIfExists = async (source: string, destination: string): Promise<boolean> => {
  if (!(await exists(source))) return false;
  await ensureDir(path.dirname(destination));
  await fsp.copyFile(source, destination);
  return true;
};

const copyDirIfExists = async (source: string, destination: string): Promise<boolean> => {
  if (!(await exists(source))) return false;
  await ensureDir(path.dirname(destination));
  await fsp.cp(source, destination, { recursive: true });
  return true;
};

const timestampSlug = (): string =>
  new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");

const zipDirectory = async (sourceDir: string, outPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", (err) => reject(err));
    archive.on("error", (err: Error) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });

const selectLatestRunId = (
  runs: Array<{ runId: string; updatedAt?: string; generatedAt?: string }>
): string | null => {
  if (runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) => {
    const aTime = a.updatedAt ?? a.generatedAt ?? "";
    const bTime = b.updatedAt ?? b.generatedAt ?? "";
    return bTime.localeCompare(aTime);
  });
  return sorted[0]?.runId ?? null;
};

export const createDiagnosticsBundle = async (): Promise<{ bundlePath: string }> => {
  const userDataPath = app.getPath("userData");
  const root = getAsteriaRoot(userDataPath);
  const diagnosticsRoot = path.join(root, "diagnostics");
  const timestamp = timestampSlug();
  const sessionDir = path.join(diagnosticsRoot, timestamp);

  await ensureDir(sessionDir);

  const appInfo = getAppInfo();
  await fsp.writeFile(path.join(sessionDir, "app-info.json"), JSON.stringify(appInfo, null, 2));

  const preferences = await loadPreferences({ userDataPath });
  await fsp.writeFile(
    path.join(sessionDir, "preferences.json"),
    JSON.stringify(preferences, null, 2)
  );

  const runs = await readRunIndex(preferences.outputDir);
  const latestRunId = selectLatestRunId(runs);
  if (latestRunId) {
    const runDir = getRunDir(preferences.outputDir, latestRunId);
    const runBundleDir = path.join(sessionDir, "latest-run", latestRunId);

    await copyFileIfExists(getRunManifestPath(runDir), path.join(runBundleDir, "manifest.json"));
    await copyFileIfExists(getRunReportPath(runDir), path.join(runBundleDir, "report.json"));
    await copyFileIfExists(
      getRunReviewQueuePath(runDir),
      path.join(runBundleDir, "review-queue.json")
    );
    await copyFileIfExists(getRunLogPath(runDir), path.join(runBundleDir, "run.log"));
  }

  const logsDir = app.getPath("logs");
  if (await exists(logsDir)) {
    await copyDirIfExists(logsDir, path.join(sessionDir, "app-logs"));
  }

  const bundlePath = path.join(diagnosticsRoot, `asteria-diagnostics-${timestamp}.zip`);
  await zipDirectory(sessionDir, bundlePath);

  return { bundlePath };
};
