import fs from "node:fs/promises";
import type { PipelineRunConfig, RunProgressEvent } from "../ipc/contracts";
import { runPipeline } from "./pipeline-runner";
import { getRunDir, getRunManifestPath } from "./run-paths";
import { updateRunIndex, type RunIndexStatus } from "./run-index";
import { clearRunProgress, emitRunProgress } from "./run-progress";

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
  controller: AbortControllerLike;
  pauseController: PauseController;
};

const activeRuns = new Map<string, ActiveRun>();

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
    abort: () => {
      aborted = true;
    },
  };
};

const updateRunManifestStatus = async (runDir: string, runId: string, status: RunIndexStatus) => {
  const manifestPath = getRunManifestPath(runDir);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const updated = { ...parsed, status };
    await fs.writeFile(manifestPath, JSON.stringify(updated, null, 2));
  } catch {
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          runId,
          status,
          exportedAt: new Date().toISOString(),
          count: 0,
          pages: [],
        },
        null,
        2
      )
    );
  }
};

export const startRun = async (
  config: PipelineRunConfig,
  projectRoot: string,
  outputDir: string
) => {
  const runId = `run-${Date.now()}`;
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
    status: "running",
    startedAt: now,
    updatedAt: now,
  });
  await updateRunManifestStatus(runDir, runId, "running");

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
    controller,
    pauseController,
  });

  // Avoid unhandled rejection warnings for background runs
  void runTask.catch(() => undefined);

  return runId;
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
      stage: "cancelled",
      processed: 0,
      total: 0,
      timestamp: new Date().toISOString(),
    },
    true
  );
  await updateRunIndex(active.outputDir, {
    runId,
    projectId: active.projectId,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  });
  await updateRunManifestStatus(getRunDir(active.outputDir, runId), runId, "cancelled");
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
  await updateRunManifestStatus(getRunDir(active.outputDir, runId), runId, "paused");
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
  await updateRunManifestStatus(getRunDir(active.outputDir, runId), runId, "running");
  return true;
};

export const isRunPaused = (runId: string): boolean => {
  const active = activeRuns.get(runId);
  return active?.pauseController.isPaused() ?? false;
};
