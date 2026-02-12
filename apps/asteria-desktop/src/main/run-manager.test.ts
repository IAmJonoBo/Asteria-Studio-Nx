import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunConfig } from "../ipc/contracts.js";

const mkdir = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { mkdir, readFile, writeFile, rename, rm },
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
}));

const runPipeline = vi.hoisted(() => vi.fn());
vi.mock("./pipeline-runner", () => ({ runPipeline }));

const updateRunIndex = vi.hoisted(() => vi.fn());
const clearRunIndex = vi.hoisted(() => vi.fn());
const readRunIndex = vi.hoisted(() => vi.fn());
const removeRunFromIndex = vi.hoisted(() => vi.fn());
vi.mock("./run-index", () => ({
  updateRunIndex,
  clearRunIndex,
  readRunIndex,
  removeRunFromIndex,
}));

const emitRunProgress = vi.hoisted(() => vi.fn());
const clearRunProgress = vi.hoisted(() => vi.fn());
vi.mock("./run-progress", () => ({ emitRunProgress, clearRunProgress }));

import {
  clearActiveRunsForTesting,
  cancelRunAndDelete,
  cancelRun,
  clearRunHistory,
  deleteRunArtifacts,
  isRunPaused,
  pauseRun,
  resumeRun,
  startRun,
} from "./run-manager.js";

describe("run-manager", () => {
  beforeEach(() => {
    clearActiveRunsForTesting();
    mkdir.mockReset();
    readFile.mockReset();
    writeFile.mockReset();
    rename.mockReset();
    rm.mockReset();
    runPipeline.mockReset();
    updateRunIndex.mockReset();
    clearRunIndex.mockReset();
    readRunIndex.mockReset();
    removeRunFromIndex.mockReset();
    emitRunProgress.mockReset();
    clearRunProgress.mockReset();
  });

  it("startRun updates run index and manifest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const pipelinePromise = new Promise<void>(() => undefined);
    runPipeline.mockReturnValueOnce(pipelinePromise);
    readFile.mockRejectedValueOnce(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const runId = await startRun(config, "/tmp/project", "/tmp/output");

    expect(runId).toMatch(/^run-1704067200000-/);
    expect(updateRunIndex).toHaveBeenCalledWith(
      "/tmp/output",
      expect.objectContaining({
        runId,
        projectId: "proj",
        status: "queued",
      })
    );
    expect(writeFile).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("startRun rejects when another run is active", async () => {
    // Simulate a long-running pipeline task so the run remains active.
    const pendingPromise = new Promise<void>(() => undefined);
    runPipeline.mockReturnValueOnce(pendingPromise);
    readFile.mockRejectedValueOnce(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    await startRun(config, "/tmp/project", "/tmp/output");

    await expect(startRun(config, "/tmp/project", "/tmp/output")).rejects.toThrow(
      /already active/i
    );
  });

  it("deleteRunArtifacts rejects active runs", async () => {
    // Simulate a long-running pipeline task so the run remains active.
    const pendingPromise = new Promise<void>(() => undefined);
    runPipeline.mockReturnValueOnce(pendingPromise);
    readFile.mockRejectedValueOnce(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const runId = await startRun(config, "/tmp/project", "/tmp/output");

    await expect(deleteRunArtifacts("/tmp/output", runId)).rejects.toThrow(
      /cannot delete an active run/i
    );
  });

  it("startRun updates existing manifest status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    runPipeline.mockReturnValueOnce(Promise.resolve());
    readFile.mockResolvedValueOnce(JSON.stringify({ runId: "run-previous", status: "queued" }));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    await startRun(config, "/tmp/project", "/tmp/output");

    const serializedWrites = writeFile.mock.calls.map((call) => String(call[1] ?? ""));
    const manifestPayload = serializedWrites.find((payload) => payload.includes('"status"'));
    expect(manifestPayload).toBeDefined();
    const updated = JSON.parse(manifestPayload ?? "{}") as { status?: string };
    expect(updated.status).toBe("queued");

    vi.useRealTimers();
  });

  it("pause/resume/cancel update run state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));

    let resolvePipeline: (() => void) | undefined;
    const pipelinePromise = new Promise<void>((resolve) => {
      resolvePipeline = resolve as () => void;
    });
    runPipeline.mockReturnValueOnce(pipelinePromise);
    readFile.mockRejectedValue(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const runId = await startRun(config, "/tmp/project", "/tmp/output");

    expect(await pauseRun(runId)).toBe(true);
    expect(isRunPaused(runId)).toBe(true);
    expect(emitRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "paused" }),
      true
    );

    expect(await resumeRun(runId)).toBe(true);
    expect(isRunPaused(runId)).toBe(false);
    expect(emitRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "running" }),
      true
    );

    expect(await cancelRun(runId)).toBe(true);
    expect(emitRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "cancelling" }),
      true
    );

    if (resolvePipeline) {
      resolvePipeline();
    }

    vi.useRealTimers();
  });

  it("waitIfPaused blocks until resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:02.000Z"));

    let capturedWait: (() => Promise<void>) | undefined;
    runPipeline.mockImplementationOnce((options: { waitIfPaused: () => Promise<void> }) => {
      capturedWait = options.waitIfPaused;
      return new Promise<void>(() => undefined);
    });
    readFile.mockRejectedValue(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const runId = await startRun(config, "/tmp/project", "/tmp/output");

    expect(await pauseRun(runId)).toBe(true);
    expect(capturedWait).toBeDefined();

    let resolved = false;
    const waitPromise = capturedWait?.().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(await resumeRun(runId)).toBe(true);
    await waitPromise;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it("uses fallback abort controller when missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:03.000Z"));

    const originalAbortController = (globalThis as { AbortController?: typeof AbortController })
      .AbortController;
    (globalThis as { AbortController?: typeof AbortController }).AbortController = undefined;

    let capturedSignal: { aborted: boolean } | undefined;
    runPipeline.mockImplementationOnce((options: { signal: { aborted: boolean } }) => {
      capturedSignal = options.signal;
      return new Promise<void>(() => undefined);
    });
    readFile.mockRejectedValue(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const runId = await startRun(config, "/tmp/project", "/tmp/output");

    expect(capturedSignal?.aborted).toBe(false);
    await cancelRun(runId);
    expect(capturedSignal?.aborted).toBe(true);

    (globalThis as { AbortController?: typeof AbortController }).AbortController =
      originalAbortController;

    vi.useRealTimers();
  });

  it("pause/resume/cancel return false for missing runs", async () => {
    expect(await pauseRun("run-missing")).toBe(false);
    expect(await resumeRun("run-missing")).toBe(false);
    expect(await cancelRun("run-missing")).toBe(false);
    expect(isRunPaused("run-missing")).toBe(false);
  });

  it("cancelRunAndDelete throws when run is missing", async () => {
    await expect(cancelRunAndDelete("run-missing")).rejects.toThrow(/no active run/i);
  });

  it("clearRunHistory clears run index without deleting artifacts", async () => {
    readRunIndex.mockResolvedValueOnce([
      { runId: "run-1", projectId: "proj" },
      { runId: "run-2", projectId: "proj" },
    ]);

    const result = await clearRunHistory("/tmp/output");

    expect(clearRunIndex).toHaveBeenCalledWith("/tmp/output");
    expect(rm).not.toHaveBeenCalled();
    expect(result).toEqual({ removedRuns: 2, removedArtifacts: false });
  });

  it("clearRunHistory removes run artifacts when requested", async () => {
    readRunIndex.mockResolvedValueOnce([{ runId: "run-1", projectId: "proj" }]);

    const result = await clearRunHistory("/tmp/output", { removeArtifacts: true });

    expect(rm).toHaveBeenCalledWith(expect.stringContaining("run-1"), {
      recursive: true,
      force: true,
    });
    expect(clearRunIndex).toHaveBeenCalledWith("/tmp/output");
    expect(result).toEqual({ removedRuns: 1, removedArtifacts: true });
  });

  it("cancelRunAndDelete logs unexpected non-abort errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:04.000Z"));

    // Use a controllable promise that rejects with a non-abort error once resolved
    let rejectPipeline: ((error: Error) => void) | undefined;
    const pipelinePromise = new Promise<void>((_resolve, reject) => {
      rejectPipeline = reject;
    });
    runPipeline.mockReturnValueOnce(pipelinePromise);
    readFile.mockRejectedValue(new Error("missing"));

    const config: PipelineRunConfig = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const runId = await startRun(config, "/tmp/project", "/tmp/output");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Reject the pipeline with a non-abort error before calling cancelRunAndDelete
    if (rejectPipeline) {
      rejectPipeline(new Error("disk I/O failure"));
    }
    // Let microtasks settle but keep run active (cancelRunAndDelete awaits the task)
    await cancelRunAndDelete(runId);

    // The "disk I/O failure" error is NOT abort-related, so it should be logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error"),
      expect.stringContaining("disk I/O failure")
    );

    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});
