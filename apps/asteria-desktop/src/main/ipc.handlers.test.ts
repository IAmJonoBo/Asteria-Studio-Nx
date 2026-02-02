import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { getRunDir, getRunSidecarPath } from "./run-paths";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const readFile = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const copyFile = vi.hoisted(() => vi.fn());
const readdir = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile, mkdir, writeFile, copyFile, readdir, rm },
  readFile,
  mkdir,
  writeFile,
  copyFile,
  readdir,
  rm,
}));

const scanCorpus = vi.hoisted(() => vi.fn());
const analyzeCorpus = vi.hoisted(() => vi.fn());
const startRun = vi.hoisted(() => vi.fn());
const cancelRun = vi.hoisted(() => vi.fn());
const pauseRun = vi.hoisted(() => vi.fn());
const resumeRun = vi.hoisted(() => vi.fn());
const loadPipelineConfig = vi.hoisted(() => vi.fn());
const loadProjectOverrides = vi.hoisted(() => vi.fn());
const resolvePipelineConfig = vi.hoisted(() => vi.fn());
const listProjects = vi.hoisted(() => vi.fn());
const importCorpus = vi.hoisted(() => vi.fn());

vi.mock("../ipc/corpusScanner", () => ({ scanCorpus }));
vi.mock("../ipc/corpusAnalysis", () => ({ analyzeCorpus }));
vi.mock("./run-manager", () => ({ startRun, cancelRun, pauseRun, resumeRun }));
vi.mock("./pipeline-config", () => ({
  loadPipelineConfig,
  loadProjectOverrides,
  resolvePipelineConfig,
}));
vi.mock("./projects", () => ({ listProjects, importCorpus }));

import { registerIpcHandlers } from "./ipc";

describe("IPC handler registration", () => {
  beforeEach(() => {
    handlers.clear();
    readFile.mockReset();
    mkdir.mockReset();
    writeFile.mockReset();
    copyFile.mockReset();
    readdir.mockReset();
    rm.mockReset();
    readdir.mockResolvedValue([]);
    scanCorpus.mockReset();
    analyzeCorpus.mockReset();
    startRun.mockReset();
    cancelRun.mockReset();
    pauseRun.mockReset();
    resumeRun.mockReset();
    loadPipelineConfig.mockReset();
    loadProjectOverrides.mockReset();
    resolvePipelineConfig.mockReset();
    listProjects.mockReset();
    importCorpus.mockReset();
  });

  it("list-projects delegates to projects module", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-projects");
    expect(handler).toBeDefined();
    listProjects.mockResolvedValueOnce([
      { id: "proj", name: "Proj", path: "/tmp/proj", inputPath: "/tmp/proj/input" },
    ]);

    const result = await (handler as (event: unknown) => Promise<unknown>)({});

    expect(result).toMatchObject([{ id: "proj" }]);
    expect(listProjects).toHaveBeenCalledOnce();
  });

  it("import-corpus delegates to projects module", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:import-corpus");
    expect(handler).toBeDefined();
    importCorpus.mockResolvedValueOnce({
      id: "proj",
      name: "Proj",
      path: "/tmp/proj",
      inputPath: "/tmp/input",
      status: "idle",
    });

    const result = await (
      handler as (event: unknown, request: { inputPath: string; name?: string }) => Promise<unknown>
    )({}, { inputPath: "/tmp/input", name: "Proj" });

    expect(result).toMatchObject({ id: "proj" });
    expect(importCorpus).toHaveBeenCalledWith({ inputPath: "/tmp/input", name: "Proj" });
  });

  it("registers review queue handlers", async () => {
    registerIpcHandlers();

    expect(handlers.has("asteria:fetch-review-queue")).toBe(true);
    expect(handlers.has("asteria:submit-review")).toBe(true);
    expect(handlers.has("asteria:list-runs")).toBe(true);
    expect(handlers.has("asteria:get-pipeline-config")).toBe(true);
    expect(handlers.has("asteria:save-project-config")).toBe(true);
    expect(handlers.has("asteria:get-run-config")).toBe(true);
    expect(handlers.has("asteria:fetch-sidecar")).toBe(true);
    expect(handlers.has("asteria:pause-run")).toBe(true);
    expect(handlers.has("asteria:resume-run")).toBe(true);
    expect(handlers.has("asteria:list-projects")).toBe(true);
    expect(handlers.has("asteria:import-corpus")).toBe(true);
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

    startRun.mockResolvedValueOnce("run-test");

    const result = await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)(
      {},
      config
    );

    expect(result).toMatchObject({ status: "running", pagesProcessed: 0, runId: "run-test" });
  });

  it("start-run derives a shared project root", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:start-run");
    expect(handler).toBeDefined();

    const config = {
      projectId: "proj",
      pages: [
        {
          id: "p1",
          filename: "page1.png",
          originalPath: "/tmp/book/a/page1.png",
          confidenceScores: {},
        },
        {
          id: "p2",
          filename: "page2.png",
          originalPath: "/tmp/book/b/page2.png",
          confidenceScores: {},
        },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    startRun.mockResolvedValueOnce("run-root");

    await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)({}, config);

    expect(startRun).toHaveBeenCalledWith(
      config,
      path.join("/tmp", "book"),
      path.join(process.cwd(), "pipeline-results")
    );
  });

  it("start-run rejects when no pages provided", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:start-run");
    expect(handler).toBeDefined();

    const config = {
      projectId: "proj",
      pages: [],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    await expect(
      (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)({}, config)
    ).rejects.toThrow("Cannot start run: no pages provided");
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
      handler as (event: unknown, runId: string, formats: Array<"png">) => Promise<unknown>
    )({}, "run-1", ["png"]);

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    expect(String(result)).toContain(path.join(runDir, "exports"));
  });

  it("export-run copies normalized assets by format", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();

    readdir.mockResolvedValueOnce(["page1.png", "page2.tiff", "page3.pdf", "notes.txt"]);

    await (
      handler as (
        event: unknown,
        runId: string,
        formats: Array<"png" | "tiff" | "pdf">
      ) => Promise<unknown>
    )({}, "run-2", ["png", "tiff", "pdf"]);

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-2");
    const exportDir = path.join(runDir, "exports", "2024-01-01T00-00-00-000Z");
    const normalizedDir = path.join(runDir, "normalized");

    expect(copyFile).toHaveBeenCalledWith(
      path.join(normalizedDir, "page1.png"),
      path.join(exportDir, "png", "page1.png")
    );
    expect(copyFile).toHaveBeenCalledWith(
      path.join(normalizedDir, "page2.tiff"),
      path.join(exportDir, "tiff", "page2.tiff")
    );
    expect(copyFile).toHaveBeenCalledWith(
      path.join(normalizedDir, "page3.pdf"),
      path.join(exportDir, "pdf", "page3.pdf")
    );

    vi.useRealTimers();
  });

  it("fetch-page returns default page shape", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-1", "p99");

    expect(result).toMatchObject({ id: "p99", filename: "page-p99.png" });
  });

  it("fetch-page returns source filename when available", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ source: { path: "/tmp/source/page.png" } }));

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-1", "p1");

    expect(result).toMatchObject({ id: "p1", filename: "page.png" });
  });

  it("fetch-page uses pageId when source path missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ source: {} }));

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-1", "p1");

    expect(result).toMatchObject({ id: "p1", filename: "p1" });
  });

  it("fetch-page falls back to legacy sidecar", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();
    readFile
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(JSON.stringify({ source: { path: "/tmp/original.png" } }));

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-legacy", "p10");

    expect(result).toMatchObject({ id: "p10", filename: "original.png" });
  });

  it("fetch-sidecar returns parsed JSON when present", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(
      JSON.stringify({ pageId: "p1", normalization: { cropBox: [0, 0, 10, 10] } })
    );

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-9", "p1");

    expect(result).toMatchObject({ pageId: "p1" });
    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-9");
    expect(readFile).toHaveBeenCalledWith(getRunSidecarPath(runDir, "p1"), "utf-8");
  });

  it("fetch-sidecar falls back to legacy path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();
    readFile
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(
        JSON.stringify({ pageId: "p2", normalization: { cropBox: [0, 0, 10, 10] } })
      );

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-legacy", "p2");

    expect(result).toMatchObject({ pageId: "p2" });
    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-legacy");
    expect(readFile).toHaveBeenNthCalledWith(1, getRunSidecarPath(runDir, "p2"), "utf-8");
    expect(readFile).toHaveBeenNthCalledWith(
      2,
      path.join(outputDir, "sidecars", "p2.json"),
      "utf-8"
    );
  });

  it("fetch-sidecar returns null when missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();
    readFile
      .mockRejectedValueOnce(new Error("missing"))
      .mockRejectedValueOnce(new Error("missing"));

    const result = await (
      handler as (event: unknown, runId: string, pageId: string) => Promise<unknown>
    )({}, "run-miss", "p3");

    expect(result).toBeNull();
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

  it("export-run handles missing normalized directory", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();
    readdir.mockRejectedValueOnce(new Error("missing"));

    const result = await (
      handler as (event: unknown, runId: string, formats: Array<"png">) => Promise<unknown>
    )({}, "run-missing", ["png"]);

    expect(String(result)).toContain("exports");
  });

  it("cancel-run accepts valid runId", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:cancel-run");
    expect(handler).toBeDefined();

    await (handler as (event: unknown, runId: string) => Promise<void>)({}, "run-9");

    expect(cancelRun).toHaveBeenCalledWith("run-9");
  });

  it("pause-run delegates to runner", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:pause-run");
    expect(handler).toBeDefined();

    await (handler as (event: unknown, runId: string) => Promise<void>)({}, "run-10");

    expect(pauseRun).toHaveBeenCalledWith("run-10");
  });

  it("resume-run delegates to runner", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:resume-run");
    expect(handler).toBeDefined();

    await (handler as (event: unknown, runId: string) => Promise<void>)({}, "run-11");

    expect(resumeRun).toHaveBeenCalledWith("run-11");
  });

  it("fetch-review-queue returns parsed data when present", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-review-queue");
    expect(handler).toBeDefined();
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          runs: [
            {
              runId: "run-1",
              projectId: "proj",
              generatedAt: "2026-01-01",
              reviewQueuePath: "/tmp/run-1/review-queue.json",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
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

  it("fetch-review-queue uses run directory when index lacks path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-review-queue");
    expect(handler).toBeDefined();
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          runs: [{ runId: "run-5", projectId: "proj" }],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          runId: "run-5",
          projectId: "proj",
          generatedAt: "2026-01-01",
          items: [],
        })
      );

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-5"
    );

    expect(result).toMatchObject({ runId: "run-5", projectId: "proj" });
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

  it("list-runs returns run index entries", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-runs");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        runs: [
          {
            runId: "run-1",
            projectId: "proj",
            generatedAt: "2026-01-01",
            reviewCount: 3,
            reportPath: "/tmp/report.json",
          },
        ],
      })
    );

    const result = await (handler as (event: unknown) => Promise<unknown>)({});

    expect(result).toMatchObject([
      {
        runId: "run-1",
        projectId: "proj",
        generatedAt: "2026-01-01",
        reviewCount: 3,
        reportPath: "/tmp/report.json",
      },
    ]);
  });

  it("list-runs falls back to legacy scan", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-runs");
    expect(handler).toBeDefined();
    readFile.mockRejectedValueOnce(new Error("missing"));
    readdir.mockResolvedValueOnce(["run-2-review-queue.json"]);

    const result = await (handler as (event: unknown) => Promise<unknown>)({});

    expect(result).toMatchObject([{ runId: "run-2", projectId: "unknown", reviewCount: 0 }]);
  });

  it("list-runs returns empty array when legacy scan fails", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-runs");
    expect(handler).toBeDefined();
    readFile.mockRejectedValueOnce(new Error("missing"));
    readdir.mockRejectedValueOnce(new Error("missing"));

    const result = await (handler as (event: unknown) => Promise<unknown>)({});

    expect(result).toEqual([]);
  });

  it("get-pipeline-config returns resolved config", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-pipeline-config");
    expect(handler).toBeDefined();

    loadPipelineConfig.mockResolvedValueOnce({
      config: { version: "0.1.0" },
      configPath: "/tmp/pipeline_config.yaml",
      loadedFromFile: true,
    });
    loadProjectOverrides.mockResolvedValueOnce({
      overrides: { project: { dpi: 600 } },
      configPath: "/tmp/project-config.json",
    });
    resolvePipelineConfig.mockReturnValueOnce({
      resolvedConfig: { version: "0.1.0", project: { dpi: 600 } },
      sources: {
        configPath: "/tmp/pipeline_config.yaml",
        loadedFromFile: true,
        projectConfigPath: "/tmp/project-config.json",
        projectOverrides: { project: { dpi: 600 } },
      },
    });

    const result = await (handler as (event: unknown, projectId: string) => Promise<unknown>)(
      {},
      "proj"
    );

    expect(result).toMatchObject({
      baseConfig: { version: "0.1.0" },
      resolvedConfig: { version: "0.1.0", project: { dpi: 600 } },
    });
  });

  it("get-run-config returns null when snapshot missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ configSnapshot: null }));

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-4"
    );

    expect(result).toBeNull();
  });

  it("get-run-config uses index report path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({ runs: [{ runId: "run-5", reportPath: "/tmp/custom-report.json" }] })
      )
      .mockResolvedValueOnce(JSON.stringify({ configSnapshot: { runId: "run-5" } }));

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-5"
    );

    expect(result).toMatchObject({ runId: "run-5" });
    expect(readFile).toHaveBeenNthCalledWith(2, "/tmp/custom-report.json", "utf-8");
  });

  it("list-runs falls back when index runs missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-runs");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ runs: null }));
    readdir.mockResolvedValueOnce([]);

    const result = await (handler as (event: unknown) => Promise<unknown>)({});

    expect(result).toEqual([]);
  });

  it("save-project-config writes overrides", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:save-project-config");
    expect(handler).toBeDefined();

    await (
      handler as (
        event: unknown,
        projectId: string,
        overrides: Record<string, unknown>
      ) => Promise<void>
    )({}, "proj", { project: { dpi: 500 } });

    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("save-project-config rejects invalid project id", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:save-project-config");
    expect(handler).toBeDefined();

    await expect(
      (
        handler as (
          event: unknown,
          projectId: string,
          overrides: Record<string, unknown>
        ) => Promise<void>
      )({}, "", { project: { dpi: 400 } })
    ).rejects.toThrow("Invalid project id");
  });

  it("save-project-config clears overrides when empty", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:save-project-config");
    expect(handler).toBeDefined();

    await (
      handler as (
        event: unknown,
        projectId: string,
        overrides: Record<string, unknown>
      ) => Promise<void>
    )({}, "proj", {});

    expect(rm).toHaveBeenCalledOnce();
  });

  it("get-run-config returns snapshot when report exists", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();

    readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          runs: [{ runId: "run-1", reportPath: "/tmp/report.json" }],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          configSnapshot: {
            resolvedConfig: { version: "0.1.0" },
            sources: { configPath: "/tmp/pipeline_config.yaml", loadedFromFile: true },
          },
        })
      );

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-1"
    );

    expect(result).toMatchObject({
      resolvedConfig: { version: "0.1.0" },
    });
  });

  it("get-run-config falls back to default report path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();

    readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          runs: [{ runId: "run-2" }],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          configSnapshot: {
            resolvedConfig: { version: "0.1.0" },
            sources: { configPath: "/tmp/pipeline_config.yaml", loadedFromFile: true },
          },
        })
      );

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-2"
    );

    expect(result).toMatchObject({ resolvedConfig: { version: "0.1.0" } });
  });

  it("get-run-config returns null when report missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();

    readFile.mockRejectedValueOnce(new Error("missing"));

    const result = await (handler as (event: unknown, runId: string) => Promise<unknown>)(
      {},
      "run-404"
    );

    expect(result).toBeNull();
  });
});
