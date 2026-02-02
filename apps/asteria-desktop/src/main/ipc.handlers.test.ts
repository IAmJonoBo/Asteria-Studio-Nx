import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const readFile = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile, mkdir, writeFile },
  readFile,
  mkdir,
  writeFile,
}));

const scanCorpus = vi.hoisted(() => vi.fn());
const analyzeCorpus = vi.hoisted(() => vi.fn());
const runPipeline = vi.hoisted(() => vi.fn());

vi.mock("../ipc/corpusScanner", () => ({ scanCorpus }));
vi.mock("../ipc/corpusAnalysis", () => ({ analyzeCorpus }));
vi.mock("./pipeline-runner", () => ({ runPipeline }));

import { registerIpcHandlers } from "./ipc";

describe("IPC handler registration", () => {
  beforeEach(() => {
    handlers.clear();
    readFile.mockReset();
    mkdir.mockReset();
    writeFile.mockReset();
    scanCorpus.mockReset();
    analyzeCorpus.mockReset();
    runPipeline.mockReset();
  });

  it("registers review queue handlers", async () => {
    registerIpcHandlers();

    expect(handlers.has("asteria:fetch-review-queue")).toBe(true);
    expect(handlers.has("asteria:submit-review")).toBe(true);
  });

  it("start-run returns a stubbed result", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:start-run");
    expect(handler).toBeDefined();

    const config = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    runPipeline.mockResolvedValueOnce({
      success: true,
      runId: "run-test",
      projectId: "proj",
      pageCount: 1,
      durationMs: 10,
      scanConfig: {
        projectId: "proj",
        pages: config.pages,
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      },
      analysisSummary: { projectId: "proj", pageCount: 1, dpi: 300, estimates: [] },
      pipelineResult: { status: "success", pagesProcessed: 1 },
      errors: [],
    });

    const result = await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)(
      {},
      config
    );

    expect(result).toMatchObject({ status: "success", pagesProcessed: 1 });
  });

  it("analyze-corpus delegates to analyzer", async () => {
    analyzeCorpus.mockResolvedValueOnce({ projectId: "proj", pageCount: 0, dpi: 300 });
    registerIpcHandlers();
    const handler = handlers.get("asteria:analyze-corpus");
    expect(handler).toBeDefined();

    const config = {
      projectId: "proj",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const result = await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)(
      {},
      config
    );

    expect(result).toMatchObject({ projectId: "proj" });
    expect(analyzeCorpus).toHaveBeenCalledOnce();
  });

  it("scan-corpus delegates to scanner", async () => {
    scanCorpus.mockResolvedValueOnce({
      projectId: "proj",
      pages: [],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    });
    registerIpcHandlers();
    const handler = handlers.get("asteria:scan-corpus");
    expect(handler).toBeDefined();

    const result = await (handler as (event: unknown, rootPath: string) => Promise<unknown>)(
      {},
      "/tmp"
    );

    expect(result).toMatchObject({ projectId: "proj" });
    expect(scanCorpus).toHaveBeenCalledOnce();
  });

  it("export-run returns output path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();

    const result = await (
      handler as (event: unknown, runId: string, format: "png") => Promise<unknown>
    )({}, "run-1", "png");

    expect(result).toBe(path.join(process.cwd(), "pipeline-results", "normalized"));
  });

  it("fetch-page returns default page shape", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();

    const result = await (handler as (event: unknown, pageId: string) => Promise<unknown>)(
      {},
      "p99"
    );

    expect(result).toMatchObject({ id: "p99", filename: "page-p99.png" });
  });

  it("apply-override accepts overrides", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    await (
      handler as (
        event: unknown,
        pageId: string,
        overrides: Record<string, unknown>
      ) => Promise<void>
    )({}, "p42", { crop: { x: 1 } });
  });

  it("cancel-run accepts valid runId", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:cancel-run");
    expect(handler).toBeDefined();

    await (handler as (event: unknown, runId: string) => Promise<void>)({}, "run-9");
  });

  it("fetch-review-queue returns parsed data when present", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-review-queue");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        runId: "run-1",
        projectId: "proj",
        generatedAt: "2026-01-01",
        items: [],
      })
    );

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-1"
    );

    expect(result).toMatchObject({ runId: "run-1", projectId: "proj" });
  });

  it("fetch-review-queue returns empty queue when missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-review-queue");
    expect(handler).toBeDefined();
    readFile.mockRejectedValueOnce(new Error("missing"));

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-2"
    );

    expect(result).toMatchObject({ runId: "run-2", items: [] });
  });

  it("submit-review accepts decision payload", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    await (handler as (event: unknown, runId: string, decisions: unknown[]) => Promise<void>)(
      {},
      "run-3",
      [{ pageId: "p1", decision: "accept" }]
    );
  });
});
