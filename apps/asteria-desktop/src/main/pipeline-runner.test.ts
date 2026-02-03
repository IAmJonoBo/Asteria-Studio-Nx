import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PipelineConfig } from "./pipeline-config.js";
import type { PipelineRunnerResult } from "./pipeline-runner.js";
import type { NormalizationResult } from "./normalization.js";
import type { PageData } from "../ipc/contracts.js";
import { runPipeline, evaluateResults } from "./pipeline-runner.js";
import { normalizePage } from "./normalization.js";
import { getRunDir, getRunManifestPath } from "./run-paths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const createSpreadImage = async (dir: string, name: string, options?: { gutter?: boolean }) => {
  const width = 220;
  const height = 120;
  const buffer = Buffer.alloc(width * height * 3, 255);
  if (options?.gutter) {
    const bandStart = Math.floor(width / 2) - 5;
    const bandEnd = bandStart + 10;
    for (let y = 0; y < height; y++) {
      for (let x = bandStart; x < bandEnd; x++) {
        const idx = (y * width + x) * 3;
        buffer[idx] = 40;
        buffer[idx + 1] = 40;
        buffer[idx + 2] = 40;
      }
    }
  }
  const spreadPath = path.join(dir, name);
  await sharp(buffer, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(spreadPath);
  return spreadPath;
};

const buildMockNormalization = (page: PageData): NormalizationResult => {
  const id = page.id;
  const isBlank = id.includes("blank");
  const isVeryLowMask = id.includes("very-low");
  const isLowMask = id.includes("low-mask");
  const isLowSkew = id.includes("low-skew");
  const isShadow = id.includes("shadow");
  const isNoise = id.includes("noise");
  const isResidual = id.includes("residual");
  const isDoubleColumn = id.includes("double");
  const isSemanticLow = id.includes("semantic-low");

  let maskCoverage = 0.9;
  if (isBlank) {
    maskCoverage = 0.05;
  } else if (isVeryLowMask) {
    maskCoverage = 0.25;
  } else if (isLowMask) {
    maskCoverage = 0.4;
  } else if (isDoubleColumn) {
    maskCoverage = 0.65;
  } else if (isSemanticLow) {
    maskCoverage = 0.66;
  }

  let backgroundStd = 5;
  if (isNoise) {
    backgroundStd = 40;
  } else if (isSemanticLow) {
    backgroundStd = 30;
  }

  let skewConfidence = 0.8;
  if (isLowSkew) {
    skewConfidence = 0.2;
  } else if (isSemanticLow) {
    skewConfidence = 0.4;
  }

  return {
    pageId: page.id,
    normalizedPath: "/tmp/normalized.png",
    cropBox: [0, 0, 100, 100] as [number, number, number, number],
    maskBox: [0, 0, 100, 100] as [number, number, number, number],
    dimensionsMm: { width: 210, height: 297 },
    dpi: 300,
    dpiSource: "fallback" as const,
    trimMm: 3,
    bleedMm: 3,
    skewAngle: 0,
    shadow: isShadow
      ? { present: true, side: "left", widthPx: 8, confidence: 0.8, darkness: 40 }
      : { present: false, side: "none", widthPx: 0, confidence: 0, darkness: 0 },
    stats: {
      backgroundMean: 240,
      backgroundStd,
      maskCoverage,
      skewConfidence,
      shadowScore: isShadow ? 40 : 0,
    },
    corrections: isResidual
      ? {
          deskewAngle: 1.2,
          skewResidualAngle: 0.25,
          skewRefined: true,
          edgeFallbackApplied: false,
          alignment: {
            box: [0, 0, 100, 100],
            drift: 0.05,
            applied: true,
          },
          morphology: {
            denoise: true,
            contrastBoost: false,
            sharpen: true,
            reason: ["text-dense"],
          },
        }
      : undefined,
  };
};

vi.mock("./normalization.ts", () => ({
  normalizePages: vi.fn(async (pages: PageData[]) => {
    if (pages.some((page) => page.id.includes("throw-normalize"))) {
      throw new Error("batch-normalize-failure");
    }
    return new Map(pages.map((page) => [page.id, buildMockNormalization(page)]));
  }),
  normalizePage: vi.fn(async (page: PageData) => buildMockNormalization(page)),
}));
vi.mock("./normalization", () => ({
  normalizePages: vi.fn(async (pages: PageData[]) => {
    if (pages.some((page) => page.id.includes("throw-normalize"))) {
      throw new Error("batch-normalize-failure");
    }
    return new Map(pages.map((page) => [page.id, buildMockNormalization(page)]));
  }),
  normalizePage: vi.fn(async (page: PageData) => buildMockNormalization(page)),
}));
vi.mock("./normalization.js", () => ({
  normalizePages: vi.fn(async (pages: PageData[]) => {
    if (pages.some((page) => page.id.includes("throw-normalize"))) {
      throw new Error("batch-normalize-failure");
    }
    return new Map(pages.map((page) => [page.id, buildMockNormalization(page)]));
  }),
  normalizePage: vi.fn(async (page: PageData) => buildMockNormalization(page)),
}));

describe("Pipeline Runner", () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-pipeline-"));
    projectRoot = tempDir;

    // Create sample JPEG files
    for (let i = 0; i < 5; i++) {
      const imgPath = path.join(projectRoot, `page-${i}.jpg`);
      // Write minimal JPEG marker
      await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xc0]));
    }

    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toFile("/tmp/normalized.png");
  });

  it("runPipeline scans and analyzes pages", async () => {
    const result = await runPipeline({
      projectRoot,
      projectId: "test-pipeline",
      sampleCount: 3,
    });

    expect(result.success).toBe(true);
    expect(result.projectId).toBe("test-pipeline");
    expect(result.pageCount).toBe(3);
    expect(result.scanConfig.pages).toHaveLength(3);
    expect(result.analysisSummary.estimates).toHaveLength(3);
    expect(result.pipelineResult.status).toBe("success");
    const normalizationMetrics = (
      result.pipelineResult.metrics as { normalization?: Record<string, number> }
    ).normalization;
    expect(normalizationMetrics?.reviewQueueCount).toBeDefined();
    expect(normalizationMetrics?.strictAcceptRate).toBe(1);
  }, 20000);

  it("runPipeline handles target DPI override", async () => {
    const result = await runPipeline({
      projectRoot,
      projectId: "test-dpi",
      targetDpi: 600,
      sampleCount: 2,
    });

    expect(result.success).toBe(true);
    expect(result.analysisSummary.dpi).toBe(600);
  }, 20000);

  it("runPipeline uses full corpus and target dimensions override", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-full-"));
    await Promise.all(
      ["a.jpg", "b.jpg", "c.jpg"].map((file) =>
        fs.writeFile(path.join(tmpDir, file), Buffer.from([0xff, 0xd8, 0xff]))
      )
    );

    const result = await runPipeline({
      projectRoot: tmpDir,
      projectId: "full-corpus",
      targetDimensionsMm: { width: 200, height: 300 },
    });

    expect(result.pageCount).toBe(3);
    expect(result.scanConfig.targetDimensionsMm).toMatchObject({ width: 200, height: 300 });
  }, 20000);

  it("runPipeline writes reports and sidecars when outputDir is set", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-output-"));
    const normalizeMock = vi.mocked(normalizePage);
    const callCountBefore = normalizeMock.mock.calls.length;
    const result = await runPipeline({
      projectRoot,
      projectId: "test-output",
      sampleCount: 2,
      outputDir,
    });

    expect(result.success).toBe(true);
    const runDir = getRunDir(outputDir, result.runId);
    const normalizeCalls = normalizeMock.mock.calls.slice(callCountBefore).map((call) => call[3]);
    expect(normalizeCalls.length).toBeGreaterThan(0);
    normalizeCalls.forEach((callRunDir) => {
      expect(callRunDir.startsWith(runDir)).toBe(true);
    });
    const files = await fs.readdir(runDir);
    expect(files).toContain("report.json");
    expect(files).toContain("review-queue.json");
    const indexPath = path.join(outputDir, "run-index.json");
    const indexRaw = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(indexRaw) as { runs?: Array<{ runId: string }> };
    expect(index.runs?.some((entry) => entry.runId === result.runId)).toBe(true);
    const sidecarDir = path.join(runDir, "sidecars");
    const sidecars = await fs.readdir(sidecarDir);
    expect(sidecars.length).toBeGreaterThan(0);
    await expect(fs.stat(path.join(outputDir, "normalized"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "previews"))).rejects.toThrow();
  }, 20000);

  it("runPipeline keeps artifacts run-scoped across multiple runs", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-multi-run-"));
    const resultA = await runPipeline({
      projectRoot,
      projectId: "multi-run-a",
      sampleCount: 2,
      outputDir,
    });
    const resultB = await runPipeline({
      projectRoot,
      projectId: "multi-run-b",
      sampleCount: 2,
      outputDir,
    });

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    const runDirA = getRunDir(outputDir, resultA.runId);
    const runDirB = getRunDir(outputDir, resultB.runId);
    expect(runDirA).not.toEqual(runDirB);
    await expect(fs.stat(path.join(outputDir, "normalized"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "previews"))).rejects.toThrow();
    await expect(fs.stat(path.join(runDirA, "manifest.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runDirB, "manifest.json"))).resolves.toBeTruthy();
  }, 20000);

  it("cancels mid-run and writes parseable report + manifest", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-cancel-"));
    const controller = new AbortController();
    let waitCalls = 0;
    let releasePause: (() => void) | undefined;
    const waitIfPaused = (): Promise<void> => {
      waitCalls += 1;
      if (waitCalls === 2) {
        return new Promise<void>((resolve) => {
          releasePause = resolve;
        });
      }
      return Promise.resolve();
    };

    const runPromise = runPipeline({
      projectRoot,
      projectId: "cancel-test",
      outputDir,
      signal: controller.signal,
      waitIfPaused,
    });

    for (let attempt = 0; attempt < 20 && !releasePause; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!releasePause) {
      throw new Error("Expected pipeline to reach pause gate for cancellation test");
    }

    controller.abort();
    releasePause();

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.pipelineResult.status).toBe("cancelled");

    const runDir = getRunDir(outputDir, result.runId);
    const reportRaw = await fs.readFile(path.join(runDir, "report.json"), "utf-8");
    const manifestRaw = await fs.readFile(getRunManifestPath(runDir), "utf-8");
    const report = JSON.parse(reportRaw) as { status?: string };
    const manifest = JSON.parse(manifestRaw) as { status?: string };
    expect(report.status).toBe("cancelled");
    expect(manifest.status).toBe("cancelled");
  });

  it("routes low semantic confidence to review queue", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-output-"));
    const semanticPagePath = path.join(projectRoot, "semantic-low.jpg");
    await fs.writeFile(semanticPagePath, Buffer.from([0xff, 0xd8, 0xff, 0xc0]));

    const result = await runPipeline({
      projectRoot,
      projectId: "semantic-review",
      outputDir,
    });

    expect(result.success).toBe(true);
    const reviewPath = path.join(outputDir, "runs", result.runId, "review-queue.json");
    const raw = await fs.readFile(reviewPath, "utf-8");
    const queue = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
    expect(queue.items?.some((item) => item.reason === "semantic-layout")).toBe(true);
    const semanticItem = queue.items?.find((item) => item.reason === "semantic-layout") as
      | { qualityGate?: { accepted?: boolean } }
      | undefined;
    expect(semanticItem?.qualityGate?.accepted).toBe(true);
  }, 20000);

  it("splits two-page spreads when enabled", async () => {
    const spreadDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-spread-"));
    await createSpreadImage(spreadDir, "spread.png", { gutter: true });

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-spread-out-"));
    const result = await runPipeline({
      projectRoot: spreadDir,
      projectId: "spread-test",
      enableSpreadSplit: true,
      spreadSplitConfidence: 0.6,
      outputDir,
    });

    expect(result.success).toBe(true);
    expect(result.scanConfig.pages.length).toBe(2);
  });

  it("does not split when spread detection fails", async () => {
    const spreadDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-no-split-"));
    await createSpreadImage(spreadDir, "single.png", { gutter: false });

    const result = await runPipeline({
      projectRoot: spreadDir,
      projectId: "no-split-detect",
      enableSpreadSplit: true,
      spreadSplitConfidence: 0.6,
    });

    expect(result.success).toBe(true);
    expect(result.scanConfig.pages.length).toBe(1);
  });

  it("fails closed when spread confidence is low", async () => {
    const spreadDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-nospread-"));
    await createSpreadImage(spreadDir, "single.png", { gutter: true });

    const result = await runPipeline({
      projectRoot: spreadDir,
      projectId: "no-split",
      enableSpreadSplit: true,
      spreadSplitConfidence: 1.1,
    });

    expect(result.success).toBe(true);
    expect(result.scanConfig.pages.length).toBe(1);
  });

  it("writes spread metadata to manifest and review queue", async () => {
    const spreadDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-spread-meta-"));
    await createSpreadImage(spreadDir, "spread.png", { gutter: true });

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-spread-meta-out-"));
    const result = await runPipeline({
      projectRoot: spreadDir,
      projectId: "spread-meta",
      enableSpreadSplit: true,
      spreadSplitConfidence: 0.6,
      outputDir,
      pipelineConfigOverrides: {
        steps: {
          qa: {
            mask_coverage_min: 0.95,
          },
        },
      } as Partial<PipelineConfig>,
    });

    expect(result.success).toBe(true);
    const runDir = getRunDir(outputDir, result.runId);
    const manifestRaw = await fs.readFile(getRunManifestPath(runDir), "utf-8");
    const manifest = JSON.parse(manifestRaw) as {
      pages?: Array<{
        pageId: string;
        spread?: { sourcePageId?: string; side?: string };
      }>;
    };
    const manifestSpreads = manifest.pages?.map((page) => page.spread).filter(Boolean) ?? [];
    expect(manifestSpreads.length).toBe(2);
    manifest.pages?.forEach((page) => {
      if (!page.spread) return;
      const baseId = page.pageId.slice(0, -2);
      expect(page.spread.sourcePageId).toBe(baseId);
      expect(["left", "right"]).toContain(page.spread.side);
    });

    const reviewRaw = await fs.readFile(path.join(runDir, "review-queue.json"), "utf-8");
    const reviewQueue = JSON.parse(reviewRaw) as {
      items?: Array<{ spread?: { sourcePageId?: string; side?: string }; pageId: string }>;
    };
    const reviewSpreads = reviewQueue.items?.map((item) => item.spread).filter(Boolean) ?? [];
    expect(reviewSpreads.length).toBe(2);
    reviewQueue.items?.forEach((item) => {
      if (!item.spread) return;
      const baseId = item.pageId.slice(0, -2);
      expect(item.spread.sourcePageId).toBe(baseId);
      expect(["left", "right"]).toContain(item.spread.side);
    });
  });

  it("runPipeline cleans stale normalized exports when checksums change", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-cleanup-"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const runId = `run-${Date.now()}`;
    const runDir = getRunDir(outputDir, runId);
    const normalizedDir = path.join(runDir, "normalized");
    const previewDir = path.join(runDir, "previews");
    await fs.mkdir(normalizedDir, { recursive: true });
    await fs.mkdir(previewDir, { recursive: true });

    const staleFile = path.join(normalizedDir, "stale.png");
    const stalePreview = path.join(previewDir, "stale-preview.png");
    await fs.writeFile(staleFile, Buffer.alloc(10));
    await fs.writeFile(stalePreview, Buffer.alloc(10));

    const manifest = {
      pages: [
        {
          pageId: "page-0",
          checksum: "old-checksum",
          normalizedFile: "stale.png",
          previews: ["stale-preview.png"],
        },
      ],
    };
    await fs.writeFile(getRunManifestPath(runDir), JSON.stringify(manifest, null, 2));

    try {
      const result = await runPipeline({
        projectRoot,
        projectId: "cleanup-test",
        outputDir,
        sampleCount: 1,
      });

      expect(result.success).toBe(true);
      await expect(fs.stat(staleFile)).rejects.toThrow();
      await expect(fs.stat(stalePreview)).rejects.toThrow();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("writes run-scoped artifacts and avoids global folders", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-run-scope-"));
    const result = await runPipeline({
      projectRoot,
      projectId: "run-scope",
      outputDir,
      sampleCount: 2,
    });

    expect(result.success).toBe(true);
    const runDir = getRunDir(outputDir, result.runId);
    await expect(fs.stat(path.join(runDir, "sidecars"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runDir, "normalized"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runDir, "previews"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runDir, "overlays"))).resolves.toBeTruthy();
    await expect(fs.stat(getRunManifestPath(runDir))).resolves.toBeTruthy();

    await expect(fs.stat(path.join(outputDir, "sidecars"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "normalized"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "previews"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "overlays"))).rejects.toThrow();
  });

  it("runs two pipelines in parallel without output collisions", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-parallel-"));
    const runIdA = "run-parallel-a";
    const runIdB = "run-parallel-b";

    const [resultA, resultB] = await Promise.all([
      runPipeline({
        projectRoot,
        projectId: "parallel-a",
        outputDir,
        sampleCount: 1,
        runId: runIdA,
      }),
      runPipeline({
        projectRoot,
        projectId: "parallel-b",
        outputDir,
        sampleCount: 1,
        runId: runIdB,
      }),
    ]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    const runDirA = getRunDir(outputDir, runIdA);
    const runDirB = getRunDir(outputDir, runIdB);
    expect(runDirA).not.toBe(runDirB);

    await expect(fs.stat(getRunManifestPath(runDirA))).resolves.toBeTruthy();
    await expect(fs.stat(getRunManifestPath(runDirB))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runDirA, "review-queue.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runDirB, "review-queue.json"))).resolves.toBeTruthy();

    const manifestA = JSON.parse(await fs.readFile(getRunManifestPath(runDirA), "utf-8")) as {
      runId?: string;
    };
    const manifestB = JSON.parse(await fs.readFile(getRunManifestPath(runDirB), "utf-8")) as {
      runId?: string;
    };
    expect(manifestA.runId).toBe(runIdA);
    expect(manifestB.runId).toBe(runIdB);
  }, 20000);

  it("runPipeline applies second-pass corrections for low-acceptance pages", async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-second-pass-"));
    const filenames = ["low-mask.jpg", "low-skew.jpg", "shadow.jpg", "body.jpg"];
    await Promise.all(
      filenames.map((name) => fs.writeFile(path.join(testDir, name), Buffer.alloc(100)))
    );

    const result = await runPipeline({
      projectRoot: testDir,
      projectId: "second-pass-test",
    });

    expect(result.success).toBe(true);
    const normalizationMetrics = (
      result.pipelineResult.metrics as { normalization?: Record<string, number> }
    ).normalization;
    expect(normalizationMetrics?.secondPassCount).toBeGreaterThan(0);

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("runPipeline records per-page normalization failures without aborting", async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-normalize-fallback-"));
    const filenames = ["throw-normalize.jpg", "body.jpg"];
    await Promise.all(
      filenames.map((name) => fs.writeFile(path.join(testDir, name), Buffer.alloc(100)))
    );

    const result = await runPipeline({
      projectRoot: testDir,
      projectId: "normalize-fallback",
    });

    expect(result.success).toBe(true);
    expect(result.pipelineResult.status).toBe("success");
    expect(result.errors.some((e) => e.phase === "normalization")).toBe(false);

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("runPipeline handles layout profiles and quality gate branches", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-layout-"));
    const files = [
      "cover.jpg",
      "title.jpg",
      "chapter.jpg",
      "body.jpg",
      "low-mask.jpg",
      "low-skew.jpg",
      "shadow.jpg",
      "noise.jpg",
    ];

    await Promise.all(
      files.map((file) => fs.writeFile(path.join(tmpDir, file), Buffer.from([0xff, 0xd8, 0xff])))
    );

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-layout-out-"));
    const result = await runPipeline({
      projectRoot: tmpDir,
      projectId: "layout-test",
      outputDir,
    });

    expect(result.success).toBe(true);
    const normalizationMetrics = (
      result.pipelineResult.metrics as { normalization?: Record<string, number> }
    ).normalization;
    expect(normalizationMetrics?.reviewQueueCount).toBeGreaterThan(0);
  }, 20000);

  it("uses config-driven QA thresholds", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-qa-config-"));
    await fs.writeFile(path.join(tmpDir, "body.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    const result = await runPipeline({
      projectRoot: tmpDir,
      projectId: "qa-config",
      pipelineConfigOverrides: {
        steps: {
          qa: {
            mask_coverage_min: 0.95,
          },
        },
      } as Partial<PipelineConfig>,
    });

    expect(result.success).toBe(true);
    const normalizationMetrics = (
      result.pipelineResult.metrics as { normalization?: Record<string, number> }
    ).normalization;
    expect(normalizationMetrics?.reviewQueueCount).toBeGreaterThan(0);
  });

  it("runPipeline returns error result for invalid root", async () => {
    const tempFile = path.join(projectRoot, "not-a-dir.txt");
    await fs.writeFile(tempFile, "invalid");

    const result = await runPipeline({
      projectRoot: tempFile,
      projectId: "bad-root",
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("evaluateResults provides observations and recommendations", () => {
    const mockResult: PipelineRunnerResult = {
      success: true,
      runId: "run-test",
      projectId: "eval-test",
      pageCount: 100,
      durationMs: 5000,
      scanConfig: {
        projectId: "eval-test",
        pages: Array.from({ length: 100 }, (_, i) => ({
          id: `p${i}`,
          filename: `page${i}.jpg`,
          originalPath: "",
          confidenceScores: {},
        })),
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      },
      analysisSummary: {
        projectId: "eval-test",
        pageCount: 100,
        dpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
        targetDimensionsPx: { width: 2480, height: 3508 },
        estimates: Array.from({ length: 100 }, (_, i) => ({
          pageId: `p${i}`,
          widthPx: 2480,
          heightPx: 3508,
          bleedPx: 10,
          trimPx: 5,
          pageBounds: [10, 10, 2470, 3498] as [number, number, number, number],
          contentBounds: [50, 50, 2430, 3458] as [number, number, number, number],
        })),
      },
      pipelineResult: {
        runId: "run-test",
        runDir: "/tmp/runs/run-test",
        status: "success",
        pagesProcessed: 100,
        errors: [],
        metrics: { durationMs: 5000 },
      },
      errors: [],
    };

    const evaluation = evaluateResults(mockResult);
    expect(evaluation.success).toBe(true);
    expect(evaluation.observations.length).toBeGreaterThan(0);
    expect(evaluation.recommendations.length).toBeGreaterThan(0);
    expect(evaluation.metrics.totalPages).toBe(100);
    expect(evaluation.metrics.throughputPagesPerSecond).toBeCloseTo(20);
  });

  it("evaluateResults flags normalization issues and fallback bleed/trim", () => {
    const evaluation = evaluateResults({
      success: true,
      runId: "run-metrics",
      projectId: "metrics-test",
      pageCount: 120,
      durationMs: 1000,
      scanConfig: {
        projectId: "metrics-test",
        pages: Array.from({ length: 120 }, (_, i) => ({
          id: `p${i}`,
          filename: `page${i}.jpg`,
          originalPath: "",
          confidenceScores: {},
        })),
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      },
      analysisSummary: {
        projectId: "metrics-test",
        pageCount: 120,
        dpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
        targetDimensionsPx: { width: 2480, height: 3508 },
        estimates: Array.from({ length: 120 }, (_, i) => ({
          pageId: `p${i}`,
          widthPx: 2480,
          heightPx: 3508,
          bleedPx: 0,
          trimPx: 0,
          pageBounds: [0, 0, 2480, 3508] as [number, number, number, number],
          contentBounds: [0, 0, 2480, 3508] as [number, number, number, number],
        })),
      },
      pipelineResult: {
        runId: "run-metrics",
        runDir: "/tmp/runs/run-metrics",
        status: "success",
        pagesProcessed: 120,
        errors: [],
        metrics: {
          durationMs: 1000,
          normalization: {
            avgSkewDeg: 2.2,
            avgMaskCoverage: 0.6,
            shadowRate: 0.2,
            lowCoverageCount: 5,
            reviewQueueCount: 10,
            strictAcceptRate: 0.5,
          },
        },
      },
      errors: [],
    });

    expect(evaluation.recommendations.some((rec) => rec.includes("mask coverage"))).toBe(true);
    expect(evaluation.recommendations.some((rec) => rec.includes("Spine/edge shadows"))).toBe(true);
    expect(evaluation.observations.some((obs) => obs.includes("Review queue size"))).toBe(true);
  });

  it("evaluateResults handles failed pipeline", () => {
    const evaluation = evaluateResults({
      success: false,
      runId: "run-fail",
      projectId: "fail-test",
      pageCount: 0,
      durationMs: 0,
      scanConfig: {
        projectId: "fail-test",
        pages: [],
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      },
      analysisSummary: {
        projectId: "fail-test",
        pageCount: 0,
        dpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
        targetDimensionsPx: { width: 0, height: 0 },
        estimates: [],
      },
      pipelineResult: {
        runId: "run-fail",
        runDir: "/tmp/runs/run-fail",
        status: "error",
        pagesProcessed: 0,
        errors: [{ pageId: "pipeline", message: "fail" }],
        metrics: { durationMs: 0 },
      },
      errors: [{ phase: "pipeline", message: "fail" }],
    });

    expect(evaluation.success).toBe(false);
    expect(evaluation.recommendations.length).toBeGreaterThan(0);
  });

  it("evaluateResults flags high variance", () => {
    const estimates = Array.from({ length: 10 }, (_, i) => ({
      pageId: `p${i}`,
      widthPx: i % 2 === 0 ? 2000 : 3000, // High variance
      heightPx: 3500,
      bleedPx: 10,
      trimPx: 5,
      pageBounds: [0, 0, 2000, 3500] as [number, number, number, number],
      contentBounds: [0, 0, 2000, 3500] as [number, number, number, number],
    }));

    const mockResult: PipelineRunnerResult = {
      success: true,
      runId: "run-variance",
      projectId: "var-test",
      pageCount: 10,
      durationMs: 1000,
      scanConfig: {
        projectId: "var-test",
        pages: estimates.map((e) => ({
          id: e.pageId,
          filename: `${e.pageId}.jpg`,
          originalPath: "",
          confidenceScores: {},
        })),
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      },
      analysisSummary: {
        projectId: "var-test",
        pageCount: 10,
        dpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
        targetDimensionsPx: { width: 2500, height: 3500 },
        estimates,
      },
      pipelineResult: {
        runId: "run-variance",
        runDir: "/tmp/runs/run-variance",
        status: "success",
        pagesProcessed: 10,
        errors: [],
        metrics: { durationMs: 1000 },
      },
      errors: [],
    };

    const evaluation = evaluateResults(mockResult);
    expect(evaluation.recommendations.some((r) => r.includes("variance"))).toBe(true);
  });

  it("evaluateResults flags large corpus and zero bounds", () => {
    const estimates = Array.from({ length: 150 }, (_, i) => ({
      pageId: `p${i}`,
      widthPx: 2480,
      heightPx: 3508,
      bleedPx: 8,
      trimPx: 4,
      pageBounds:
        i === 0
          ? ([0, 0, 0, 0] as [number, number, number, number])
          : ([0, 0, 2480, 3508] as [number, number, number, number]),
      contentBounds: [0, 0, 2480, 3508] as [number, number, number, number],
    }));

    const evaluation = evaluateResults({
      success: true,
      runId: "run-large",
      projectId: "large-test",
      pageCount: 150,
      durationMs: 6000,
      scanConfig: {
        projectId: "large-test",
        pages: estimates.map((e) => ({
          id: e.pageId,
          filename: `${e.pageId}.jpg`,
          originalPath: "",
          confidenceScores: {},
        })),
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      },
      analysisSummary: {
        projectId: "large-test",
        pageCount: 150,
        dpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
        targetDimensionsPx: { width: 2480, height: 3508 },
        estimates,
      },
      pipelineResult: {
        runId: "run-large",
        runDir: "/tmp/runs/run-large",
        status: "success",
        pagesProcessed: 150,
        errors: [],
        metrics: {
          durationMs: 6000,
          normalization: {
            avgSkewDeg: 0.2,
            avgMaskCoverage: 0.92,
            shadowRate: 0.05,
            lowCoverageCount: 0,
            reviewQueueCount: 0,
            strictAcceptRate: 0.9,
            secondPassCount: 3,
          },
        },
      },
      errors: [],
    });

    expect(evaluation.recommendations.some((rec) => rec.includes("batch processing"))).toBe(true);
    expect(evaluation.recommendations.some((rec) => rec.includes("zero content bounds"))).toBe(
      true
    );
    expect(evaluation.observations.some((obs) => obs.includes("Second-pass corrections"))).toBe(
      true
    );
  });

  it("covers layout classification and baseline validation branches", async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-layout-profiles-"));
    const filenames = [
      "000-cover.jpg",
      "010-title.jpg",
      "020-toc.jpg",
      "030-preface.jpg",
      "040-appendix.jpg",
      "050-index.jpg",
      "060-glossary.jpg",
      "070-plate.jpg",
      "080-table.jpg",
      "090-chapter.jpg",
      "100-blank.jpg",
      "110-very-low-art.jpg",
      "120-body.jpg",
      "130-residual-body.jpg",
      "140-low-skew-noise-body.jpg",
      "005-low-mask-prologue.jpg",
      "900-low-mask-epilogue.jpg",
    ];

    await Promise.all(
      filenames.map((name) => fs.writeFile(path.join(testDir, name), Buffer.alloc(100)))
    );

    const result = await runPipeline({
      projectRoot: testDir,
      projectId: "layout-profiles",
    });

    expect(result.success).toBe(true);
    expect(result.pageCount).toBe(filenames.length);
    expect(result.pipelineResult.metrics).toBeDefined();

    await fs.rm(testDir, { recursive: true, force: true });
  });
});
