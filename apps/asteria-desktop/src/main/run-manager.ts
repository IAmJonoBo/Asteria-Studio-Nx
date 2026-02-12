import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PipelineRunConfig, RunProgressEvent } from "../ipc/contracts.js";
import { runPipeline } from "./pipeline-runner.js";
import type { PipelineRunnerResult } from "./pipeline-runner.js";
import { getRunDir, getRunManifestPath, getRunReportPath } from "./run-paths.js";
import { writeJsonAtomic } from "./file-utils.js";
import {
  clearRunIndex,
  readRunIndex,
  removeRunFromIndex,
  updateRunIndex,
  type RunIndexStatus,
} from "./run-index.js";
import { clearRunProgress, emitRunProgress } from "./run-progress.js";

type PauseController = {
  pause: () => void;
  resume: () => void;
  waitIfPaused: () => Promise<void>;
  isPaused: () => boolean;
};

type AbortSignalLike = {
  aborted: boolean;
};

type AbortControllerLike = {
  abort: () => void;
  signal: AbortSignalLike;
};

type ActiveRun = {
  runId: string;
  projectId: string;
  outputDir: string;
  runDir: string;
  controller: AbortControllerLike;
  pauseController: PauseController;
  task: Promise<PipelineRunnerResult>;
};

const activeRuns = new Map<string, ActiveRun>();

export const clearActiveRunsForTesting = (): void => {
  activeRuns.clear();
};

const createPauseController = (): PauseController => {
  let paused = false;
  let resumeResolve: (() => void) | null = null;
  let resumePromise: Promise<void> | null = null;

  const waitIfPaused = async (): Promise<void> => {
    if (!paused) return;
    resumePromise ??= new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });
    await resumePromise;
  };

  const pause = (): void => {
    if (paused) return;
    paused = true;
    resumePromise ??= new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });
  };

  const resume = (): void => {
    if (!paused) return;
    paused = false;
    resumeResolve?.();
    resumeResolve = null;
    resumePromise = null;
  };

  const isPaused = (): boolean => paused;

  return { pause, resume, waitIfPaused, isPaused };
};

const createAbortController = (): AbortControllerLike => {
  const AbortControllerCtor = (
    globalThis as typeof globalThis & { AbortController?: new () => AbortControllerLike }
  ).AbortController;
  if (AbortControllerCtor) {
    return new AbortControllerCtor();
  }
  let aborted = false;
  const signal: AbortSignalLike = {
    get aborted() {
      return aborted;
    },
  };
  return {
    signal,
    abort: (): void => {
      aborted = true;
    },
  };
};

const updateRunManifestStatus = async (
  runDir: string,
  runId: string,
  status: RunIndexStatus
): Promise<void> => {
  const manifestPath = getRunManifestPath(runDir);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const updated = { ...parsed, status };
    await writeJsonAtomic(manifestPath, updated);
  } catch (error) {
    console.warn(`Failed to read manifest at ${manifestPath}`, error);
    await writeJsonAtomic(manifestPath, {
      runId,
      status,
      exportedAt: new Date().toISOString(),
      count: 0,
      pages: [],
    });
  }
};

const updateRunReportStatus = async (
  runDir: string,
  runId: string,
  projectId: string,
  status: RunIndexStatus
): Promise<void> => {
  const reportPath = getRunReportPath(runDir);
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    await writeJsonAtomic(reportPath, {
      ...parsed,
      runId,
      projectId,
      status,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn(`Failed to read report at ${reportPath}`, error);
    await writeJsonAtomic(reportPath, {
      runId,
      projectId,
      status,
      updatedAt: new Date().toISOString(),
    });
  }
};

export const startRun = async (
  config: PipelineRunConfig,
  projectRoot: string,
  outputDir: string
): Promise<string> => {
  if (activeRuns.size > 0) {
    throw new Error("A run is already active. Cancel it before starting a new run.");
  }
  const runId = `run-${Date.now()}-${randomUUID().split("-")[0] ?? "seed"}`;
  const controller = createAbortController();
  const pauseController = createPauseController();
  const runDir = getRunDir(outputDir, runId);
  const now = new Date().toISOString();
  let lastStage: string | null = null;
  const reportProgress = (event: RunProgressEvent): void => {
    const force = event.stage !== lastStage;
    lastStage = event.stage;
    emitRunProgress(event, force);
  };

  await fs.mkdir(runDir, { recursive: true });
  await updateRunIndex(outputDir, {
    runId,
    projectId: config.projectId,
    status: "queued",
    startedAt: now,
    updatedAt: now,
  });
  await updateRunManifestStatus(runDir, runId, "queued");
  await updateRunReportStatus(runDir, runId, config.projectId, "queued");

  const runTask = runPipeline({
    projectRoot,
    projectId: config.projectId,
    targetDpi: config.targetDpi,
    targetDimensionsMm: config.targetDimensionsMm,
    outputDir,
    enableSpreadSplit: true,
    enableBookPriors: true,
    runId,
    signal: controller.signal,
    waitIfPaused: pauseController.waitIfPaused,
    onProgress: reportProgress,
  }).finally(() => {
    activeRuns.delete(runId);
    clearRunProgress(runId);
  });

  activeRuns.set(runId, {
    runId,
    projectId: config.projectId,
    outputDir,
    runDir,
    controller,
    pauseController,
    task: runTask,
  });

  // Avoid unhandled rejection warnings for background runs
  void runTask.catch(() => undefined);

  return runId;
};

export const deleteRunArtifacts = async (outputDir: string, runId: string): Promise<void> => {
  if (activeRuns.has(runId)) {
    throw new Error("Cannot delete an active run.");
  }
  const runDir = getRunDir(outputDir, runId);
  await fs.rm(runDir, { recursive: true, force: true });
  await removeRunFromIndex(outputDir, runId);
};

export const clearRunHistory = async (
  outputDir: string,
  options?: { removeArtifacts?: boolean }
): Promise<{ removedRuns: number; removedArtifacts: boolean }> => {
  if (activeRuns.size > 0) {
    throw new Error("Cannot clear run history while runs are active.");
  }
  const runs = await readRunIndex(outputDir);
  if (options?.removeArtifacts) {
    await Promise.all(
      runs.map(async (run) => {
        const runDir = getRunDir(outputDir, run.runId);
        await fs.rm(runDir, { recursive: true, force: true });
      })
    );
  }
  await clearRunIndex(outputDir);
  return { removedRuns: runs.length, removedArtifacts: Boolean(options?.removeArtifacts) };
};

export const cancelRunAndDelete = async (runId: string): Promise<void> => {
  const active = activeRuns.get(runId);
  if (!active) {
    throw new Error("No active run found for cancellation.");
  }
  active.pauseController.resume();
  active.controller.abort();
  emitRunProgress(
    {
      runId,
      projectId: active.projectId,
      stage: "cancelling",
      processed: 0,
      total: 0,
      timestamp: new Date().toISOString(),
    },
    true
  );
  try {
    await active.task;
  } catch (error) {
    // Only suppress abort-related pipeline errors; log unexpected ones.
    const message = error instanceof Error ? error.message : String(error);
    const isAbortRelated =
      message.includes("abort") ||
      message.includes("cancel") ||
      (error instanceof Error && error.name === "AbortError");
    if (!isAbortRelated) {
      console.warn(`[run-manager] Unexpected error during cancel of ${runId}:`, message);
    }
  }
  await fs.rm(active.runDir, { recursive: true, force: true });
  await removeRunFromIndex(active.outputDir, runId);
};

export const cancelRun = async (runId: string): Promise<boolean> => {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.pauseController.resume();
  active.controller.abort();
  emitRunProgress(
    {
      runId,
      projectId: active.projectId,
      stage: "cancelling",
      processed: 0,
      total: 0,
      timestamp: new Date().toISOString(),
    },
    true
  );
  await updateRunIndex(active.outputDir, {
    runId,
    projectId: active.projectId,
    status: "cancelling",
    updatedAt: new Date().toISOString(),
  });
  const runDir = getRunDir(active.outputDir, runId);
  await updateRunManifestStatus(runDir, runId, "cancelling");
  await updateRunReportStatus(runDir, runId, active.projectId, "cancelling");
  return true;
};

export const pauseRun = async (runId: string): Promise<boolean> => {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.pauseController.pause();
  emitRunProgress(
    {
      runId,
      projectId: active.projectId,
      stage: "paused",
      processed: 0,
      total: 0,
      timestamp: new Date().toISOString(),
    },
    true
  );
  await updateRunIndex(active.outputDir, {
    runId,
    projectId: active.projectId,
    status: "paused",
    updatedAt: new Date().toISOString(),
  });
  const runDir = getRunDir(active.outputDir, runId);
  await updateRunManifestStatus(runDir, runId, "paused");
  await updateRunReportStatus(runDir, runId, active.projectId, "paused");
  return true;
};

export const resumeRun = async (runId: string): Promise<boolean> => {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.pauseController.resume();
  emitRunProgress(
    {
      runId,
      projectId: active.projectId,
      stage: "running",
      processed: 0,
      total: 0,
      timestamp: new Date().toISOString(),
    },
    true
  );
  await updateRunIndex(active.outputDir, {
    runId,
    projectId: active.projectId,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  const runDir = getRunDir(active.outputDir, runId);
  await updateRunManifestStatus(runDir, runId, "running");
  await updateRunReportStatus(runDir, runId, active.projectId, "running");
  return true;
};

export const isRunPaused = (runId: string): boolean => {
  const active = activeRuns.get(runId);
  return active?.pauseController.isPaused() ?? false;
};
