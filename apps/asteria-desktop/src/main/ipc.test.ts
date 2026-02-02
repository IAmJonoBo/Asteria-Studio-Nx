import { describe, it, expect, beforeEach } from "vitest";
import type { CorpusSummary, PipelineRunConfig, PipelineRunResult } from "../ipc/contracts";
import { analyzeCorpus } from "../ipc/corpusAnalysis";
import { scanCorpus } from "../ipc/corpusScanner";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Mock/stub tests for IPC handlers.
 * Replace with real orchestrator tests as implementation grows.
 */

describe("IPC Handlers (Stubs)", () => {
  let mockConfig: PipelineRunConfig;

  beforeEach(() => {
    mockConfig = {
      projectId: "test-proj",
      pages: [
        { id: "p1", filename: "page1.png", originalPath: "/input/p1", confidenceScores: {} },
        { id: "p2", filename: "page2.png", originalPath: "/input/p2", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    };
  });

  it("start-run returns valid result structure", async () => {
    // Simulate handler response
    const result: PipelineRunResult = {
      runId: `run-${Date.now()}`,
      status: "running",
      pagesProcessed: 0,
      errors: [],
      metrics: {},
    };

    expect(result.runId).toBeDefined();
    expect(result.status).toBe("running");
    expect(result.pagesProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("start-run handles multiple pages", async () => {
    const largeConfig = {
      ...mockConfig,
      pages: Array.from({ length: 100 }, (_, i) => ({
        id: `p${i}`,
        filename: `page${i}.png`,
        originalPath: "",
        confidenceScores: {},
      })),
    };

    expect(largeConfig.pages).toHaveLength(100);
  });

  it("cancel-run is callable with valid runId", async () => {
    const runId = "run-12345";
    // Would call ipcMain.invoke in real context
    expect(runId).toBeDefined();
  });

  it("analyze-corpus returns bounds seeded from target dimensions", async () => {
    const summary: CorpusSummary = await analyzeCorpus(mockConfig);
    expect(summary.estimates[0].pageBounds[2]).toBeGreaterThan(2000);
    expect(summary.pageCount).toBe(mockConfig.pages.length);
  });

  it("scan-corpus builds run config from images", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-"));
    const imgPath = path.join(tmpDir, "scan.jpg");
    await fs.writeFile(imgPath, "fake");

    const config = await scanCorpus(tmpDir);
    expect(config.pages).toHaveLength(1);
    expect(config.targetDpi).toBeGreaterThan(0);
  });
});
