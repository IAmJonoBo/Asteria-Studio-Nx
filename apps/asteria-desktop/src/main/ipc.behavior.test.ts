import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  getRunDir,
  getRunManifestPath,
  getRunReportPath,
  getRunReviewQueuePath,
} from "./run-paths.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp") },
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    tiff: vi.fn(() => ({ toFile: vi.fn().mockResolvedValue(undefined) })),
    pdf: vi.fn(() => ({ toFile: vi.fn().mockResolvedValue(undefined) })),
    toFormat: vi.fn(() => ({ toFile: vi.fn().mockResolvedValue(undefined) })),
    toFile: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./pipeline-runner", () => ({
  runPipeline: vi.fn().mockResolvedValue(undefined),
}));

const resolveOutputDir = vi.fn();
const resolveProjectsRoot = vi.fn();
const loadPreferences = vi.fn();
const savePreferences = vi.fn();

vi.mock("./preferences", () => ({
  resolveOutputDir: (...args: unknown[]) => resolveOutputDir(...args),
  resolveProjectsRoot: (...args: unknown[]) => resolveProjectsRoot(...args),
  loadPreferences: (...args: unknown[]) => loadPreferences(...args),
  savePreferences: (...args: unknown[]) => savePreferences(...args),
}));

vi.mock("./app-info", () => ({ getAppInfo: () => ({ version: "0.1.0", platform: "darwin" }) }));
vi.mock("./diagnostics", () => ({
  createDiagnosticsBundle: vi.fn().mockResolvedValue({ bundlePath: "/tmp/bundle.zip" }),
}));
vi.mock("../ipc/corpusScanner", () => ({ scanCorpus: vi.fn() }));
vi.mock("../ipc/corpusAnalysis", () => ({ analyzeCorpus: vi.fn() }));
vi.mock("./projects", () => ({ listProjects: vi.fn(), importCorpus: vi.fn() }));
vi.mock("./sample-corpus", () => ({ provisionSampleCorpus: vi.fn() }));

import { registerIpcHandlers } from "./ipc.js";

const createTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-test-"));
  return dir;
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
};

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
};

describe("IPC behavior", () => {
  let tempDir: string;

  beforeEach(async () => {
    handlers.clear();
    tempDir = await createTempDir();
    resolveOutputDir.mockResolvedValue(tempDir);
    resolveProjectsRoot.mockResolvedValue(path.join(tempDir, "projects"));
    registerIpcHandlers();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("start-run writes run index + manifest + report", async () => {
    const handler = handlers.get("asteria:start-run");
    expect(handler).toBeDefined();

    const config = {
      projectId: "proj",
      pages: [
        {
          id: "p1",
          filename: "page.png",
          originalPath: path.join(tempDir, "src", "page.png"),
          confidenceScores: {},
        },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };

    const result = await (
      handler as (event: unknown, cfg: typeof config) => Promise<{ ok: boolean; value?: unknown }>
    )({}, config);
    expect(result.ok).toBe(true);
    const value = result.value as { runId: string; runDir: string };
    const runId = value.runId;
    const runDir = value.runDir;

    const index = await readJson<{ runs: Array<{ runId: string; status: string }> }>(
      path.join(tempDir, "run-index.json")
    );
    const entry = index.runs.find((run) => run.runId === runId);
    expect(entry?.status).toBe("queued");

    const manifest = await readJson<{ runId: string; status: string }>(getRunManifestPath(runDir));
    expect(manifest.runId).toBe(runId);
    expect(manifest.status).toBe("queued");

    const report = await readJson<{ runId: string; status: string }>(getRunReportPath(runDir));
    expect(report.runId).toBe(runId);
    expect(report.status).toBe("queued");
  });

  it("apply-override updates sidecar + manifest", async () => {
    const handler = handlers.get("asteria:apply-override");
    expect(handler).toBeDefined();

    const runId = `run-${randomUUID()}`;
    const runDir = getRunDir(tempDir, runId);
    await fs.mkdir(runDir, { recursive: true });

    const pageId = "page-1";
    const sidecarPath = path.join(runDir, "sidecars", `${pageId}.json`);
    const manifestPath = getRunManifestPath(runDir);

    await writeJson(sidecarPath, {
      pageId,
      source: { path: "/tmp/source.png", checksum: "abc" },
      dimensions: { width: 210, height: 297, unit: "mm" },
      dpi: 300,
      normalization: {},
      elements: [],
      metrics: {},
    });
    await writeJson(manifestPath, { pages: [{ pageId }] });

    const overrides = { normalization: { rotationDeg: 1.5 } };

    const result = await (
      handler as (
        event: unknown,
        runId: string,
        pageId: string,
        overrides: Record<string, unknown>
      ) => Promise<{ ok: boolean }>
    )({}, runId, pageId, overrides);

    expect(result.ok).toBe(true);

    const updatedSidecar = await readJson<Record<string, unknown>>(sidecarPath);
    expect(updatedSidecar.overrides).toMatchObject(overrides);
    expect((updatedSidecar.decisions as Record<string, unknown>).overrides).toContain(
      "normalization.rotationDeg"
    );

    const updatedManifest = await readJson<{ pages: Array<Record<string, unknown>> }>(manifestPath);
    expect(updatedManifest.pages[0]?.overrides).toMatchObject(overrides);
    expect(updatedManifest.pages[0]?.overrideAppliedAt).toBeDefined();
  });

  it("export-run writes export bundle with normalized pngs", async () => {
    const handler = handlers.get("asteria:export-run");
    expect(handler).toBeDefined();

    const runId = `run-${randomUUID()}`;
    const runDir = getRunDir(tempDir, runId);
    const normalizedDir = path.join(runDir, "normalized");
    await fs.mkdir(normalizedDir, { recursive: true });
    await fs.writeFile(path.join(normalizedDir, "page-1.png"), "png");

    await writeJson(getRunManifestPath(runDir), { runId, status: "success" });
    await writeJson(getRunReportPath(runDir), { runId, status: "success" });
    await writeJson(getRunReviewQueuePath(runDir), { runId, items: [] });

    const result = await (
      handler as (
        event: unknown,
        runId: string,
        formats: Array<"png">
      ) => Promise<{ ok: boolean; value?: string }>
    )({}, runId, ["png"]);

    expect(result.ok).toBe(true);
    const exportDir = result.value as string;
    const exportedPng = await fs.readFile(path.join(exportDir, "png", "page-1.png"), "utf-8");
    expect(exportedPng).toBe("png");
  });
});
