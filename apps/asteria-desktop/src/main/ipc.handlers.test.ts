import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getRunDir, getRunReviewQueuePath, getRunSidecarPath } from "./run-paths.js";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const readFile = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const copyFile = vi.hoisted(() => vi.fn());
const cp = vi.hoisted(() => vi.fn());
const readdir = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());
const sharpCall = vi.hoisted(() => {
  const toFile = vi.fn().mockResolvedValue(undefined);
  const tiff = vi.fn(() => ({ toFile }));
  const pdf = vi.fn(() => ({ toFile }));
  const toFormat = vi.fn(() => ({ toFile }));
  const sharpFn = vi.fn(() => ({ tiff, pdf, toFormat, toFile }));
  return { sharpFn, toFile, tiff, pdf, toFormat };
});

const showItemInFolder = vi.hoisted(() => vi.fn());
const openPath = vi.hoisted(() => vi.fn());
const getPath = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  shell: { showItemInFolder, openPath },
  app: { getPath },
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile, mkdir, writeFile, copyFile, cp, readdir, rm, rename },
  readFile,
  mkdir,
  writeFile,
  copyFile,
  cp,
  readdir,
  rm,
  rename,
}));

vi.mock("sharp", () => ({ default: sharpCall.sharpFn }));

const scanCorpus = vi.hoisted(() => vi.fn());
const analyzeCorpus = vi.hoisted(() => vi.fn());
const startRun = vi.hoisted(() => vi.fn());
const cancelRun = vi.hoisted(() => vi.fn());
const cancelRunAndDelete = vi.hoisted(() => vi.fn());
const clearRunHistory = vi.hoisted(() => vi.fn());
const deleteRunArtifacts = vi.hoisted(() => vi.fn());
const pauseRun = vi.hoisted(() => vi.fn());
const resumeRun = vi.hoisted(() => vi.fn());
const loadPipelineConfig = vi.hoisted(() => vi.fn());
const loadProjectOverrides = vi.hoisted(() => vi.fn());
const resolvePipelineConfig = vi.hoisted(() => vi.fn());
const listProjects = vi.hoisted(() => vi.fn());
const importCorpus = vi.hoisted(() => vi.fn());
const loadPreferences = vi.hoisted(() => vi.fn());
const savePreferences = vi.hoisted(() => vi.fn());
const resolveOutputDir = vi.hoisted(() => vi.fn());
const resolveProjectsRoot = vi.hoisted(() => vi.fn());
const createDiagnosticsBundle = vi.hoisted(() => vi.fn());
const getAppInfo = vi.hoisted(() => vi.fn());
const provisionSampleCorpus = vi.hoisted(() => vi.fn());

vi.mock("../ipc/corpusScanner", () => ({ scanCorpus }));
vi.mock("../ipc/corpusAnalysis", () => ({ analyzeCorpus }));
vi.mock("./run-manager", () => ({
  startRun,
  cancelRun,
  cancelRunAndDelete,
  clearRunHistory,
  deleteRunArtifacts,
  pauseRun,
  resumeRun,
}));
vi.mock("./pipeline-config", () => ({
  loadPipelineConfig,
  loadProjectOverrides,
  resolvePipelineConfig,
}));
vi.mock("./projects", () => ({ listProjects, importCorpus }));
vi.mock("./preferences", () => ({
  loadPreferences,
  savePreferences,
  resolveOutputDir,
  resolveProjectsRoot,
}));
vi.mock("./diagnostics", () => ({ createDiagnosticsBundle }));
vi.mock("./app-info", () => ({ getAppInfo }));
vi.mock("./sample-corpus", () => ({ provisionSampleCorpus }));

import { buildBundleFileUrl, registerIpcHandlers } from "./ipc.js";

const unwrap = <T>(result: unknown): T => {
  const resolved = result as { ok: boolean; value?: T; error?: { message?: string } };
  if (resolved.ok) return resolved.value as T;
  throw new Error(resolved.error?.message ?? "IPC failed");
};

describe("IPC handler registration", () => {
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    handlers.clear();
    readFile.mockReset();
    mkdir.mockReset();
    writeFile.mockReset();
    copyFile.mockReset();
    cp.mockReset();
    readdir.mockReset();
    rm.mockReset();
    rename.mockReset();
    showItemInFolder.mockReset();
    openPath.mockReset();
    getPath.mockReset();
    sharpCall.sharpFn.mockReset();
    sharpCall.toFile.mockReset();
    sharpCall.tiff.mockReset();
    sharpCall.pdf.mockReset();
    sharpCall.toFormat.mockReset();
    readdir.mockResolvedValue([]);
    scanCorpus.mockReset();
    analyzeCorpus.mockReset();
    startRun.mockReset();
    cancelRun.mockReset();
    cancelRunAndDelete.mockReset();
    clearRunHistory.mockReset();
    deleteRunArtifacts.mockReset();
    pauseRun.mockReset();
    resumeRun.mockReset();
    loadPipelineConfig.mockReset();
    loadProjectOverrides.mockReset();
    resolvePipelineConfig.mockReset();
    listProjects.mockReset();
    importCorpus.mockReset();
    loadPreferences.mockReset();
    savePreferences.mockReset();
    resolveOutputDir.mockReset();
    resolveProjectsRoot.mockReset();
    createDiagnosticsBundle.mockReset();
    getAppInfo.mockReset();
    provisionSampleCorpus.mockReset();
    copyFile.mockResolvedValue(undefined);
    cp.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveOutputDir.mockResolvedValue(path.join(process.cwd(), "pipeline-results"));
    resolveProjectsRoot.mockResolvedValue(path.join(process.cwd(), "projects"));
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;
  });

  it("list-projects delegates to projects module", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-projects");
    expect(handler).toBeDefined();
    listProjects.mockResolvedValueOnce([
      { id: "proj", name: "Proj", path: "/tmp/proj", inputPath: "/tmp/proj/input" },
    ]);

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

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

    const result = unwrap(
      await (
        handler as (
          event: unknown,
          request: { inputPath: string; name?: string }
        ) => Promise<unknown>
      )({}, { inputPath: "/tmp/input", name: "Proj" })
    );

    expect(result).toMatchObject({ id: "proj" });
    expect(importCorpus).toHaveBeenCalledWith({ inputPath: "/tmp/input", name: "Proj" });
  });

  it("get-app-preferences delegates to preferences module", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-app-preferences");
    expect(handler).toBeDefined();
    loadPreferences.mockResolvedValueOnce({
      outputDir: "/tmp/out",
      projectsDir: "/tmp/projects",
      firstRunComplete: true,
      sampleCorpusInstalled: false,
    });

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

    expect(loadPreferences).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outputDir: "/tmp/out", projectsDir: "/tmp/projects" });
  });

  it("set-app-preferences saves updates", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:set-app-preferences");
    expect(handler).toBeDefined();
    savePreferences.mockResolvedValueOnce({
      outputDir: "/tmp/out",
      projectsDir: "/tmp/projects",
      firstRunComplete: false,
      sampleCorpusInstalled: true,
    });

    const result = unwrap(
      await (handler as (event: unknown, prefs: Record<string, unknown>) => Promise<unknown>)(
        {},
        { sampleCorpusInstalled: true }
      )
    );

    expect(savePreferences).toHaveBeenCalledWith({ sampleCorpusInstalled: true });
    expect(result).toMatchObject({ sampleCorpusInstalled: true });
  });

  it("get-app-info delegates to app-info module", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-app-info");
    expect(handler).toBeDefined();
    getAppInfo.mockReturnValueOnce({ version: "0.1.0", platform: "darwin" });

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

    expect(getAppInfo).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ version: "0.1.0", platform: "darwin" });
  });

  it("create-diagnostics-bundle delegates to diagnostics module", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:create-diagnostics-bundle");
    expect(handler).toBeDefined();
    createDiagnosticsBundle.mockResolvedValueOnce({ bundlePath: "/tmp/diag.zip" });

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

    expect(createDiagnosticsBundle).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ bundlePath: "/tmp/diag.zip" });
  });

  it("registers review queue handlers", async () => {
    registerIpcHandlers();

    expect(handlers.has("asteria:get-app-preferences")).toBe(true);
    expect(handlers.has("asteria:set-app-preferences")).toBe(true);
    expect(handlers.has("asteria:get-app-info")).toBe(true);
    expect(handlers.has("asteria:provision-sample-corpus")).toBe(true);
    expect(handlers.has("asteria:create-diagnostics-bundle")).toBe(true);
    expect(handlers.has("asteria:reveal-path")).toBe(true);
    expect(handlers.has("asteria:fetch-review-queue")).toBe(true);
    expect(handlers.has("asteria:submit-review")).toBe(true);
    expect(handlers.has("asteria:list-runs")).toBe(true);
    expect(handlers.has("asteria:clear-run-history")).toBe(true);
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

    const result = unwrap(
      await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)({}, config)
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

    const result = await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)(
      {},
      config
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Cannot start run: no pages provided" },
    });
  });

  it("analyze-corpus delegates to analyzer", async () => {
    analyzeCorpus.mockResolvedValueOnce({
      projectId: "proj",
      pageCount: 0,
      dpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
      targetDimensionsPx: { width: 0, height: 0 },
      estimates: [],
    });
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

    const result = unwrap(
      await (handler as (event: unknown, cfg: typeof config) => Promise<unknown>)({}, config)
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

    const result = unwrap(
      await (handler as (event: unknown, rootPath: string) => Promise<unknown>)({}, "/tmp")
    );

    expect(result).toMatchObject({ projectId: "proj" });
    expect(scanCorpus).toHaveBeenCalledOnce();
  });

  it("export-run returns output path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          formats: Array<"png">
        ) => Promise<unknown>
      )({}, "run-1", runDir, ["png"])
    );
    expect(String(result)).toContain(path.join(runDir, "exports"));
  });

  it("export-run copies normalized assets by format", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-2");
    readdir
      .mockResolvedValueOnce(["page-1.json"])
      .mockResolvedValueOnce(["page1.png", "page2.png", "notes.txt"]);

    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          formats: Array<"png" | "tiff" | "pdf">
        ) => Promise<unknown>
      )({}, "run-2", runDir, ["png", "tiff", "pdf"])
    );
    const exportDir = path.join(runDir, "exports", "2024-01-01T00-00-00-000Z");
    const normalizedDir = path.join(runDir, "normalized");
    const sidecarDir = path.join(runDir, "sidecars");
    const trainingDir = path.join(runDir, "training");

    expect(copyFile).toHaveBeenCalledWith(
      path.join(runDir, "manifest.json"),
      path.join(exportDir, "manifest.json")
    );
    expect(copyFile).toHaveBeenCalledWith(
      path.join(runDir, "report.json"),
      path.join(exportDir, "report.json")
    );
    expect(copyFile).toHaveBeenCalledWith(
      path.join(runDir, "review-queue.json"),
      path.join(exportDir, "review-queue.json")
    );
    expect(copyFile).toHaveBeenCalledWith(
      path.join(normalizedDir, "page1.png"),
      path.join(exportDir, "png", "page1.png")
    );
    expect(copyFile).toHaveBeenCalledWith(
      path.join(sidecarDir, "page-1.json"),
      path.join(exportDir, "sidecars", "page-1.json")
    );
    expect(cp).toHaveBeenCalledWith(trainingDir, path.join(exportDir, "training"), {
      recursive: true,
    });
    expect(sharpCall.tiff).toHaveBeenCalledTimes(2);
    expect(sharpCall.toFormat).toHaveBeenCalledTimes(2);
    expect(sharpCall.toFormat).toHaveBeenCalledWith("pdf");

    vi.useRealTimers();
  });

  it("export-run reports warnings when IO fails", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();

    copyFile.mockRejectedValue(new Error("copy-fail"));
    readdir.mockRejectedValue(new Error("readdir-fail"));
    cp.mockRejectedValue(new Error("cp-fail"));
    sharpCall.sharpFn.mockImplementation(() => {
      throw new Error("sharp-fail");
    });

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-warn");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        formats: Array<"tiff">
      ) => Promise<unknown>
    )({}, "run-warn", runDir, ["tiff"]);

    expect(warnSpy).toHaveBeenCalled();
  });

  it("fetch-page returns default page shape", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();

    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-1");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p99")
    );

    expect(result).toMatchObject({ id: "p99", filename: "page-p99.png" });
  });

  it("fetch-page returns source filename when available", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ source: { path: "/tmp/source/page.png" } }));

    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-1");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p1")
    );

    expect(result).toMatchObject({ id: "p1", filename: "page.png" });
    expect(readFile).toHaveBeenCalledWith(getRunSidecarPath(runDir, "p1"), "utf-8");
  });

  it("fetch-sidecar reads run-scoped sidecar data", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ pageId: "p9" }));

    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-9");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string
        ) => Promise<unknown>
      )({}, "run-9", runDir, "p9")
    );

    expect(result).toMatchObject({ pageId: "p9" });
    expect(readFile).toHaveBeenCalledWith(getRunSidecarPath(runDir, "p9"), "utf-8");
  });

  it("fetch-page uses pageId when source path missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-page");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ source: {} }));

    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-1");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p1")
    );

    expect(result).toMatchObject({ id: "p1", filename: "p1" });
  });

  it("fetch-sidecar returns parsed JSON when present", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(
      JSON.stringify({ pageId: "p1", normalization: { cropBox: [0, 0, 10, 10] } })
    );

    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-9");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string
        ) => Promise<unknown>
      )({}, "run-9", runDir, "p1")
    );

    expect(result).toMatchObject({ pageId: "p1" });
    expect(readFile).toHaveBeenCalledWith(getRunSidecarPath(runDir, "p1"), "utf-8");
  });

  it("fetch-sidecar returns null when missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();
    readFile.mockRejectedValueOnce(new Error("missing"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-miss");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string
        ) => Promise<unknown>
      )({}, "run-miss", runDir, "p3")
    );

    expect(result).toBeNull();
    expect(readFile).toHaveBeenCalledWith(getRunSidecarPath(runDir, "p3"), "utf-8");
    expect(readFile).not.toHaveBeenCalledWith(path.join(outputDir, "sidecars", "p3.json"), "utf-8");
  });

  it("fetch-sidecar rejects global output paths", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-sidecar");
    expect(handler).toBeDefined();

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const invalidResult = await (
      handler as (event: unknown, runId: string, runDir: string, pageId: string) => Promise<unknown>
    )({}, "run-1", outputDir, "p1");
    expect(invalidResult).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Invalid run directory") },
    });
  });

  it("apply-override accepts overrides", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p42", { crop: { x: 1 } })
    );
    expect(writeFile).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith(
      expect.any(String),
      path.join(runDir, "overrides", "p42.json")
    );
  });

  it("apply-override updates sidecar with decisions.overrides and decisions.overrideAppliedAt", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    const mockSidecar = JSON.stringify({
      pageId: "p42",
      normalization: { cropBox: [0, 0, 100, 100] },
      decisions: { accepted: true, notes: "test" },
    });
    readFile.mockResolvedValueOnce(mockSidecar);

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p42", {
        normalization: { rotationDeg: 1.5, cropBox: [0, 0, 150, 150] },
      })
    );

    // Check that writeFile was called with updated sidecar
    const writeFileCalls = writeFile.mock.calls;
    const sidecarWriteCall = writeFileCalls.find(
      (call) => typeof call[1] === "string" && call[1].includes('"overrideAppliedAt"')
    );
    expect(sidecarWriteCall).toBeDefined();

    const writtenData = JSON.parse(sidecarWriteCall![1] as string);
    expect(writtenData.decisions.overrides).toEqual([
      "normalization.rotationDeg",
      "normalization.cropBox",
    ]);
    expect(writtenData.decisions.overrideAppliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(writtenData.overrides).toEqual({
      normalization: { rotationDeg: 1.5, cropBox: [0, 0, 150, 150] },
    });
  });

  it("apply-override updates manifest with per-page overrides and overrideAppliedAt", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    const mockSidecar = JSON.stringify({ pageId: "p42" });
    const mockManifest = JSON.stringify({
      runId: "run-1",
      pages: [
        { pageId: "p41", filename: "page41.png" },
        { pageId: "p42", filename: "page42.png" },
        { pageId: "p43", filename: "page43.png" },
      ],
    });
    readFile.mockResolvedValueOnce(mockSidecar).mockResolvedValueOnce(mockManifest);

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p42", { normalization: { rotationDeg: -2.0 } })
    );

    // Check that writeFile was called (writeJsonAtomic uses writeFile internally)
    expect(writeFile).toHaveBeenCalled();

    // Find a writeFile call that looks like it's writing JSON with the pages structure
    const jsonWriteCalls = writeFile.mock.calls.filter((call) => {
      if (typeof call[1] !== "string") return false;
      try {
        const data = JSON.parse(call[1]);
        return Array.isArray(data.pages);
      } catch (error) {
        void error;
        return false;
      }
    });

    expect(jsonWriteCalls.length).toBeGreaterThan(0);

    // Parse the manifest write and verify it has the expected structure
    const manifestData = JSON.parse(jsonWriteCalls[jsonWriteCalls.length - 1][1] as string);
    expect(manifestData.pages).toHaveLength(3);
    const updatedPage = manifestData.pages.find((p: { pageId: string }) => p.pageId === "p42");
    expect(updatedPage).toBeDefined();
    expect(updatedPage.overrides).toEqual({ normalization: { rotationDeg: -2.0 } });
    expect(updatedPage.overrideAppliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Other pages should not be affected
    const otherPages = manifestData.pages.filter((p: { pageId: string }) => p.pageId !== "p42");
    otherPages.forEach((p: { overrides?: unknown }) => {
      expect(p.overrides).toBeUndefined();
    });
  });

  it("apply-override handles missing sidecar gracefully", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    // Sidecar read fails
    readFile.mockRejectedValueOnce(new Error("ENOENT"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    // Should not throw, should still write override file
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p99", { normalization: { rotationDeg: 0.5 } })
    );

    expect(rename).toHaveBeenCalledWith(
      expect.any(String),
      path.join(runDir, "overrides", "p99.json")
    );
  });

  it("apply-override handles missing manifest gracefully", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    const mockSidecar = JSON.stringify({ pageId: "p42" });
    // Manifest read fails
    readFile.mockResolvedValueOnce(mockSidecar).mockRejectedValueOnce(new Error("ENOENT"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    // Should not throw, sidecar should still be updated
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p42", { normalization: { rotationDeg: 0.5 } })
    );

    // Check sidecar was written
    const writeFileCalls = writeFile.mock.calls;
    const sidecarWriteCall = writeFileCalls.find(
      (call) => typeof call[1] === "string" && call[1].includes('"overrideAppliedAt"')
    );
    expect(sidecarWriteCall).toBeDefined();
  });

  it("apply-override handles non-array manifest.pages", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    const mockSidecar = JSON.stringify({ pageId: "p42" });
    const mockManifest = JSON.stringify({ runId: "run-1", pages: "not-an-array" });
    readFile.mockResolvedValueOnce(mockSidecar).mockResolvedValueOnce(mockManifest);

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    // Should not throw even with malformed manifest
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          pageId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "run-1", runDir, "p42", { normalization: { rotationDeg: 0.5 } })
    );

    // Manifest should not be updated (no writeFile call with the manifest content)
    const writeFileCalls = writeFile.mock.calls;
    const manifestWriteCall = writeFileCalls.find(
      (call) => typeof call[1] === "string" && call[1].includes('"pages":"not-an-array"')
    );
    expect(manifestWriteCall).toBeUndefined();
  });

  it("export-run handles missing normalized directory", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();
    readdir
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("missing"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-missing");
    const result = unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          formats: Array<"png">
        ) => Promise<unknown>
      )({}, "run-missing", runDir, ["png"])
    );

    expect(String(result)).toContain("exports");
  });

  it("cancel-run accepts valid runId", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:cancel-run");
    expect(handler).toBeDefined();

    unwrap(await (handler as (event: unknown, runId: string) => Promise<unknown>)({}, "run-9"));

    expect(cancelRun).toHaveBeenCalledWith("run-9");
  });

  it("pause-run delegates to runner", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:pause-run");
    expect(handler).toBeDefined();

    unwrap(await (handler as (event: unknown, runId: string) => Promise<unknown>)({}, "run-10"));

    expect(pauseRun).toHaveBeenCalledWith("run-10");
  });

  it("resume-run delegates to runner", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:resume-run");
    expect(handler).toBeDefined();

    unwrap(await (handler as (event: unknown, runId: string) => Promise<unknown>)({}, "run-11"));

    expect(resumeRun).toHaveBeenCalledWith("run-11");
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

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    const result = unwrap(
      await (handler as (event: unknown, runId: string, runDir: string) => Promise<unknown>)(
        {},
        "run-1",
        runDir
      )
    );

    expect(result).toMatchObject({ runId: "run-1", projectId: "proj" });
    expect(readFile).toHaveBeenCalledWith(getRunReviewQueuePath(runDir), "utf-8");
  });

  it("fetch-review-queue uses run directory when index lacks path", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-review-queue");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        runId: "run-5",
        projectId: "proj",
        generatedAt: "2026-01-01",
        items: [],
      })
    );

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-5");
    const result = unwrap(
      await (handler as (event: unknown, runId: string, runDir: string) => Promise<unknown>)(
        {},
        "run-5",
        runDir
      )
    );

    expect(result).toMatchObject({ runId: "run-5", projectId: "proj" });
    expect(readFile).toHaveBeenCalledWith(getRunReviewQueuePath(runDir), "utf-8");
  });

  it("fetch-review-queue returns empty queue when missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:fetch-review-queue");
    expect(handler).toBeDefined();
    readFile
      .mockRejectedValueOnce(new Error("missing"))
      .mockRejectedValueOnce(new Error("missing"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-2");
    const result = unwrap(
      await (handler as (event: unknown, runId: string, runDir: string) => Promise<unknown>)(
        {},
        "run-2",
        runDir
      )
    );

    expect(result).toMatchObject({ runId: "run-2", items: [] });
  });

  it("submit-review accepts decision payload", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-3");
    unwrap(
      await (
        handler as (
          event: unknown,
          runId: string,
          runDir: string,
          decisions: unknown[]
        ) => Promise<unknown>
      )({}, "run-3", runDir, [{ pageId: "p1", decision: "accept" }])
    );
  });

  it("submit-review creates training directory structure", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-train-1");
    const trainingDir = path.join(runDir, "training");
    const trainingPageDir = path.join(trainingDir, "page");
    const trainingTemplateDir = path.join(trainingDir, "template");

    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-train-1", runDir, [{ pageId: "page1", decision: "accept" }]);

    expect(mkdir).toHaveBeenCalledWith(path.join(runDir, "reviews"), { recursive: true });
    expect(mkdir).toHaveBeenCalledWith(trainingPageDir, { recursive: true });
    expect(mkdir).toHaveBeenCalledWith(trainingTemplateDir, { recursive: true });
  });

  it("submit-review writes per-page training records with all fields", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const sidecar = {
      pageId: "page1",
      normalization: { cropBox: [0, 0, 100, 100] },
      elements: [{ type: "text", bbox: [10, 10, 50, 50] }],
      bookModel: { runningHeadTemplates: [{ id: "template1", pattern: "Chapter {n}" }] },
    };
    readFile.mockResolvedValueOnce(
      JSON.stringify({ determinism: { appVersion: "1.0.0", configHash: "abc123" } })
    ); // report read
    readFile.mockResolvedValueOnce(JSON.stringify(sidecar)); // sidecar read
    readFile.mockRejectedValueOnce(new Error("no override")); // override read (fails)

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-train-2");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-train-2", runDir, [{ pageId: "page1", decision: "accept", notes: "looks good" }]);

    const writeCall = writeFile.mock.calls.find(
      (call) => String(call[0]).includes("training/page") && String(call[0]).includes("page1.json")
    );
    expect(writeCall).toBeDefined();
    if (!writeCall) throw new Error("writeCall not found");
    const written = JSON.parse(writeCall[1] as string);
    const expectedSidecarUrl = buildBundleFileUrl(getRunSidecarPath(runDir, "page1"));
    expect(written).toMatchObject({
      runId: "run-train-2",
      pageId: "page1",
      decision: "accept",
      notes: "looks good",
      confirmed: true,
      appVersion: "1.0.0",
      configHash: "abc123",
      templateIds: ["template1"],
      sidecarPath: expectedSidecarUrl,
    });
    expect(written.timestamps).toHaveProperty("submittedAt");
    expect(written.timestamps).toHaveProperty("appliedAt");
    expect(written.auto).toHaveProperty("normalization");
    expect(written.auto).toHaveProperty("elements");
    expect(written.final).toHaveProperty("normalization");
  });

  it("submit-review captures baseline grid deltas and element edits", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const sidecar = {
      pageId: "page-10",
      normalization: {
        cropBox: [0, 0, 100, 100],
        trimBox: [0, 0, 100, 100],
        skewAngle: -0.2,
      },
      elements: [
        { id: "el-1", type: "text", bbox: [0, 0, 10, 10] },
        { id: "el-2", type: "title", bbox: [10, 0, 20, 10] },
      ],
      bookModel: {
        baselineGrid: { dominantSpacingPx: 12 },
      },
      metrics: {
        baseline: { medianSpacingPx: 10 },
      },
    };

    readFile
      .mockResolvedValueOnce(
        JSON.stringify({ determinism: { appVersion: "1.0.0", configHash: "hash-10" } })
      )
      .mockResolvedValueOnce(JSON.stringify(sidecar))
      .mockRejectedValueOnce(new Error("no override"));

    const overrides = {
      normalization: {
        rotationDeg: 1.5,
        cropBox: [1, 2, 110, 120],
        trimBox: [1, 1, 95, 96],
      },
      elements: [
        { id: "el-1", type: "text", bbox: [0, 0, 10, 10], confidence: 0.9 },
        { id: "el-3", type: "title", bbox: [20, 20, 30, 30] },
      ],
      guides: {
        baselineGrid: {
          spacingPx: 14,
          offsetPx: 2,
          angleDeg: -0.1,
          snapToPeaks: true,
          markCorrect: false,
        },
      },
    };

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-grid");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-grid", runDir, [{ pageId: "page-10", decision: "adjust", overrides }]);

    const sidecarWrite = writeFile.mock.calls.find(
      (call) =>
        String(call[0]).includes(path.join(runDir, "sidecars")) &&
        String(call[0]).includes("page-10.json")
    );
    expect(sidecarWrite).toBeDefined();
    if (!sidecarWrite) throw new Error("sidecarWrite not found");
    const sidecarPayload = JSON.parse(sidecarWrite[1] as string);
    expect(sidecarPayload.adjustments).toBeDefined();
    expect(sidecarPayload.adjustments.cropOffsets).toEqual([1, 2, 10, 20]);
    expect(sidecarPayload.adjustments.trimOffsets).toEqual([1, 1, -5, -4]);
    expect(sidecarPayload.adjustments.elementEdits).toHaveLength(3);

    const trainingWrite = writeFile.mock.calls.find(
      (call) =>
        String(call[0]).includes(path.join(runDir, "training", "page")) &&
        String(call[0]).includes("page-10.json")
    );
    expect(trainingWrite).toBeDefined();
    if (!trainingWrite) throw new Error("trainingWrite not found");
    const trainingPayload = JSON.parse(trainingWrite[1] as string);
    expect(trainingPayload.delta?.guides?.baselineGrid).toMatchObject({
      spacingPx: 2,
      angleDeg: 0.1,
      snapToPeaks: true,
      markCorrect: false,
    });

    const guidesHintWrite = writeFile.mock.calls.find(
      (call) =>
        String(call[0]).includes(path.join(runDir, "training", "guides")) &&
        String(call[0]).includes("page-10.json")
    );
    expect(guidesHintWrite).toBeDefined();
    if (!guidesHintWrite) throw new Error("guidesHintWrite not found");
    const guidesHint = JSON.parse(guidesHintWrite[1] as string);
    expect(guidesHint.effective?.baselineGrid).toMatchObject({
      spacingPx: 14,
      offsetPx: 2,
      angleDeg: -0.1,
    });
  });

  it("submit-review writes per-template training records with page linkage", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const sidecar1 = {
      bookModel: { runningHeadTemplates: [{ id: "template1", pattern: "Chapter {n}" }] },
    };
    const sidecar2 = {
      bookModel: { runningHeadTemplates: [{ id: "template1", pattern: "Chapter {n}" }] },
    };
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({ determinism: { appVersion: "1.0.0", configHash: "abc123" } })
      ) // report
      .mockResolvedValueOnce(JSON.stringify(sidecar1)) // page1 sidecar
      .mockRejectedValueOnce(new Error("no override")) // page1 override (fails)
      .mockResolvedValueOnce(JSON.stringify(sidecar2)) // page2 sidecar
      .mockRejectedValueOnce(new Error("no override")); // page2 override (fails)

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-train-3");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-train-3", runDir, [
      { pageId: "page1", decision: "accept" },
      { pageId: "page2", decision: "accept" },
    ]);

    const writeCall = writeFile.mock.calls.find(
      (call) =>
        String(call[0]).includes("training/template") && String(call[0]).includes("template1.json")
    );
    expect(writeCall).toBeDefined();
    if (!writeCall) throw new Error("writeCall not found");
    const written = JSON.parse(writeCall[1] as string);
    expect(written).toMatchObject({
      runId: "run-train-3",
      templateId: "template1",
      confirmed: true,
      appVersion: "1.0.0",
      configHash: "abc123",
      pages: expect.arrayContaining(["page1", "page2"]),
      confirmedPages: expect.arrayContaining(["page1", "page2"]),
    });
  });

  it("buildBundleFileUrl emits file URLs for posix and windows paths", () => {
    const fixtures = [
      {
        label: "posix",
        pathModule: path.posix,
        root: "/tmp/pipeline-results/run-1",
      },
      {
        label: "win32",
        pathModule: path.win32,
        root: "C:\\pipeline-results\\run-1",
      },
    ];

    fixtures.forEach(({ pathModule, root }) => {
      const sidecarPath = pathModule.join(root, "sidecars", "page-1.json");
      const expected = pathToFileURL(pathModule.resolve(sidecarPath)).toString();
      expect(buildBundleFileUrl(sidecarPath, pathModule)).toBe(expected);
      expect(expected).toMatch(/^file:/);
    });
  });

  it("submit-review writes training manifest with counts", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const sidecar = {
      bookModel: { runningHeadTemplates: [{ id: "template1", pattern: "Chapter {n}" }] },
    };
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({ determinism: { appVersion: "1.0.0", configHash: "abc123" } })
      ) // report
      .mockResolvedValueOnce(JSON.stringify(sidecar)) // page1 sidecar
      .mockRejectedValueOnce(new Error("no override")) // page1 override (fails)
      .mockResolvedValueOnce(JSON.stringify(sidecar)) // page2 sidecar
      .mockRejectedValueOnce(new Error("no override")); // page2 override (fails)

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-train-4");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-train-4", runDir, [
      { pageId: "page1", decision: "accept" },
      { pageId: "page2", decision: "reject" },
    ]);

    const writeCall = writeFile.mock.calls.find(
      (call) => String(call[0]).includes("training") && String(call[0]).includes("manifest.json")
    );
    expect(writeCall).toBeDefined();
    if (!writeCall) throw new Error("writeCall not found");
    const manifest = JSON.parse(writeCall[1] as string);
    expect(manifest).toMatchObject({
      runId: "run-train-4",
      appVersion: "1.0.0",
      configHash: "abc123",
      counts: {
        pages: 2,
        templates: 1,
      },
    });
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.templates).toHaveLength(1);
  });

  it("submit-review uses unknown determinism when report missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    readFile.mockRejectedValueOnce(new Error("missing report"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-train-5");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-train-5", runDir, [{ pageId: "page1", decision: "accept" }]);

    const writeCall = writeFile.mock.calls.find(
      (call) => String(call[0]).includes("training") && String(call[0]).includes("manifest.json")
    );
    expect(writeCall).toBeDefined();
    if (!writeCall) throw new Error("writeCall not found");
    const manifest = JSON.parse(writeCall[1] as string);
    expect(manifest.appVersion).toBe("unknown");
    expect(manifest.configHash).toBe("unknown");
  });

  it("submit-review template confirmed field reflects actual page decisions", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();

    const sidecar1 = {
      bookModel: { runningHeadTemplates: [{ id: "template1", pattern: "Chapter {n}" }] },
    };
    const sidecar2 = {
      bookModel: { runningHeadTemplates: [{ id: "template1", pattern: "Chapter {n}" }] },
    };
    const sidecar3 = {
      bookModel: { runningHeadTemplates: [{ id: "template2", pattern: "Page {n}" }] },
    };
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({ determinism: { appVersion: "1.0.0", configHash: "abc123" } })
      ) // report
      .mockResolvedValueOnce(JSON.stringify(sidecar1)) // page1 sidecar
      .mockRejectedValueOnce(new Error("no override")) // page1 override (fails)
      .mockResolvedValueOnce(JSON.stringify(sidecar2)) // page2 sidecar
      .mockRejectedValueOnce(new Error("no override")) // page2 override (fails)
      .mockResolvedValueOnce(JSON.stringify(sidecar3)) // page3 sidecar
      .mockRejectedValueOnce(new Error("no override")); // page3 override (fails)

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-train-6");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-train-6", runDir, [
      { pageId: "page1", decision: "accept" },
      { pageId: "page2", decision: "reject" },
      { pageId: "page3", decision: "reject" },
    ]);

    const template1Call = writeFile.mock.calls.find(
      (call) =>
        String(call[0]).includes("training/template") && String(call[0]).includes("template1.json")
    );
    expect(template1Call).toBeDefined();
    if (!template1Call) throw new Error("template1Call not found");
    const template1 = JSON.parse(template1Call[1] as string);
    expect(template1.confirmed).toBe(true);
    expect(template1.pages).toEqual(expect.arrayContaining(["page1", "page2"]));
    expect(template1.confirmedPages).toEqual(["page1"]);

    const template2Call = writeFile.mock.calls.find(
      (call) =>
        String(call[0]).includes("training/template") && String(call[0]).includes("template2.json")
    );
    expect(template2Call).toBeDefined();
    if (!template2Call) throw new Error("template2Call not found");
    const template2 = JSON.parse(template2Call[1] as string);
    expect(template2.confirmed).toBe(false);
    expect(template2.pages).toEqual(["page3"]);
    expect(template2.confirmedPages).toEqual([]);
  });

  it("submit-review writes a training bundle manifest", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:submit-review");
    expect(handler).toBeDefined();
    readFile.mockRejectedValueOnce(new Error("missing-sidecar"));

    const runDir = getRunDir(path.join(process.cwd(), "pipeline-results"), "run-training");
    await (
      handler as (
        event: unknown,
        runId: string,
        runDir: string,
        decisions: unknown[]
      ) => Promise<void>
    )({}, "run-training", runDir, [
      {
        pageId: "page-7",
        decision: "accept",
        overrides: { normalization: { rotationDeg: 0.5 } },
      },
    ]);

    const trainingDir = path.join(runDir, "training");
    expect(rename).toHaveBeenCalledWith(
      expect.any(String),
      path.join(trainingDir, "page", "page-7.json")
    );
    expect(rename).toHaveBeenCalledWith(
      expect.any(String),
      path.join(trainingDir, "manifest.json")
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

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

    expect(result).toMatchObject([
      {
        runId: "run-1",
        runDir: getRunDir(path.join(process.cwd(), "pipeline-results"), "run-1"),
        projectId: "proj",
        generatedAt: "2026-01-01",
        reviewCount: 3,
        reportPath: "/tmp/report.json",
      },
    ]);
  });

  it("list-runs returns empty array when index missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-runs");
    expect(handler).toBeDefined();
    readFile.mockRejectedValueOnce(new Error("missing"));

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

    expect(result).toEqual([]);
  });

  it("clear-run-history delegates to run manager", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:clear-run-history");
    expect(handler).toBeDefined();
    resolveOutputDir.mockResolvedValueOnce("/tmp/out");
    clearRunHistory.mockResolvedValueOnce({ removedRuns: 2, removedArtifacts: true });

    const result = unwrap(
      await (
        handler as (event: unknown, options?: { removeArtifacts?: boolean }) => Promise<unknown>
      )({}, { removeArtifacts: true })
    );

    expect(clearRunHistory).toHaveBeenCalledWith("/tmp/out", { removeArtifacts: true });
    expect(result).toMatchObject({ removedRuns: 2, removedArtifacts: true });
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

    const result = unwrap(
      await (handler as (event: unknown, projectId: string) => Promise<unknown>)({}, "proj")
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

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-4");
    const result = unwrap(
      await (handler as (event: unknown, runId: string, runDir: string) => Promise<unknown>)(
        {},
        "run-4",
        runDir
      )
    );

    expect(result).toBeNull();
  });

  it("list-runs returns empty when index runs missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:list-runs");
    expect(handler).toBeDefined();
    readFile.mockResolvedValueOnce(JSON.stringify({ runs: null }));
    readdir.mockResolvedValueOnce([]);

    const result = unwrap(await (handler as (event: unknown) => Promise<unknown>)({}));

    expect(result).toEqual([]);
  });

  it("save-project-config writes overrides", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:save-project-config");
    expect(handler).toBeDefined();

    unwrap(
      await (
        handler as (
          event: unknown,
          projectId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "proj", { project: { dpi: 500 } })
    );

    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("save-project-config rejects invalid project id", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:save-project-config");
    expect(handler).toBeDefined();

    const result = await (
      handler as (
        event: unknown,
        projectId: string,
        overrides: Record<string, unknown>
      ) => Promise<unknown>
    )({}, "", { project: { dpi: 400 } });
    expect(result).toMatchObject({ ok: false, error: { message: "Invalid project id" } });
  });

  it("save-project-config clears overrides when empty", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:save-project-config");
    expect(handler).toBeDefined();

    unwrap(
      await (
        handler as (
          event: unknown,
          projectId: string,
          overrides: Record<string, unknown>
        ) => Promise<unknown>
      )({}, "proj", {})
    );

    expect(rm).toHaveBeenCalledOnce();
  });

  it("get-run-config returns snapshot when report exists", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();

    readFile.mockResolvedValueOnce(
      JSON.stringify({
        configSnapshot: {
          resolvedConfig: { version: "0.1.0" },
          sources: { configPath: "/tmp/pipeline_config.yaml", loadedFromFile: true },
        },
      })
    );

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-1");
    const result = unwrap(
      await (handler as (event: unknown, runId: string, runDir: string) => Promise<unknown>)(
        {},
        "run-1",
        runDir
      )
    );

    expect(result).toMatchObject({
      resolvedConfig: { version: "0.1.0" },
    });
  });

  it("get-run-config returns null when report missing", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:get-run-config");
    expect(handler).toBeDefined();

    readFile.mockRejectedValueOnce(new Error("missing"));

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-404");
    const result = unwrap(
      await (handler as (event: unknown, runId: string, runDir: string) => Promise<unknown>)(
        {},
        "run-404",
        runDir
      )
    );

    expect(result).toBeNull();
  });

  it("record-template-training writes signal to template directory", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:record-template-training");
    expect(handler).toBeDefined();

    const signal = {
      templateId: "body",
      scope: "template",
      appliedAt: "2026-02-03T15:00:00Z",
      pages: ["page-1", "page-2"],
      overrides: { normalization: { rotationDeg: 0.5 } },
      sourcePageId: "page-1",
      layoutProfile: "body",
    };

    unwrap(
      await (handler as (event: unknown, runId: string, signal: unknown) => Promise<unknown>)(
        {},
        "run-6",
        signal
      )
    );

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-6");
    const templateDir = path.join(runDir, "training", "template");
    expect(mkdir).toHaveBeenCalledWith(templateDir, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(path.join(templateDir.replaceAll("\\", "\\\\"), "\\.body-.*\\.json.*\\.tmp$"))
      ),
      expect.stringMatching(/"runId"\s*:\s*"run-6"/)
    );
  });

  it("record-template-training validates signal payload", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:record-template-training");
    expect(handler).toBeDefined();

    const invalidSignal = {
      templateId: "body",
      scope: "invalid-scope",
      appliedAt: "2026-02-03T15:00:00Z",
      pages: ["page-1"],
      overrides: {},
    };

    const invalidResult = await (
      handler as (event: unknown, runId: string, signal: unknown) => Promise<unknown>
    )({}, "run-7", invalidSignal);
    expect(invalidResult).toMatchObject({
      ok: false,
      error: {
        message: "Invalid template training signal: scope must be template or section",
      },
    });
  });

  it("record-template-training sanitizes templateId for filename", async () => {
    registerIpcHandlers();
    const handler = handlers.get("asteria:record-template-training");
    expect(handler).toBeDefined();

    const signal = {
      templateId: "body/chapter:1",
      scope: "section",
      appliedAt: "2026-02-03T15:00:00Z",
      pages: ["page-1"],
      overrides: { normalization: { rotationDeg: 0.5 } },
    };

    unwrap(
      await (handler as (event: unknown, runId: string, signal: unknown) => Promise<unknown>)(
        {},
        "run-8",
        signal
      )
    );

    const outputDir = path.join(process.cwd(), "pipeline-results");
    const runDir = getRunDir(outputDir, "run-8");
    const templateDir = path.join(runDir, "training", "template");
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          path.join(templateDir.replace(/\\/g, "\\\\"), "\\.body_chapter_1-.*\\.json.*\\.tmp$")
        )
      ),
      expect.any(String)
    );
  });
});
