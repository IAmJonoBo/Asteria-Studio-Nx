import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunConfig } from "../ipc/contracts";

const mkdir = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { mkdir, readFile, writeFile, rename },
  mkdir,
  readFile,
  writeFile,
  rename,
}));

const runPipeline = vi.hoisted(() => vi.fn());
vi.mock("./pipeline-runner", () => ({ runPipeline }));

const updateRunIndex = vi.hoisted(() => vi.fn());
vi.mock("./run-index", () => ({ updateRunIndex }));

const emitRunProgress = vi.hoisted(() => vi.fn());
const clearRunProgress = vi.hoisted(() => vi.fn());
vi.mock("./run-progress", () => ({ emitRunProgress, clearRunProgress }));

import { cancelRun, isRunPaused, pauseRun, resumeRun, startRun } from "./run-manager";

describe("run-manager", () => {
  beforeEach(() => {
    mkdir.mockReset();
    readFile.mockReset();
    writeFile.mockReset();
    rename.mockReset();
    runPipeline.mockReset();
    updateRunIndex.mockReset();
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

    expect(runId).toBe("run-1704067200000");
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
  });
});
