import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineRunConfig, PageData } from "../ipc/contracts.js";
import type { NormalizationResult } from "./normalization.js";

const scanCorpus = vi.hoisted(() => vi.fn());
const analyzeCorpus = vi.hoisted(() => vi.fn());
const normalizePage = vi.hoisted(() => vi.fn());
const applyDimensionInference = vi.hoisted(() => vi.fn((config: PipelineRunConfig) => config));
const estimatePageBounds = vi.hoisted(() =>
  vi.fn(async () => ({ bounds: [], targetPx: { width: 0, height: 0 } }))
);

vi.mock("../ipc/corpusScanner", (): { scanCorpus: typeof scanCorpus } => ({ scanCorpus }));
vi.mock(
  "../ipc/corpusAnalysis",
  (): {
    analyzeCorpus: typeof analyzeCorpus;
    computeTargetDimensionsPx: (
      dims: { width: number; height: number },
      dpi: number
    ) => {
      width: number;
      height: number;
    };
    applyDimensionInference: typeof applyDimensionInference;
    estimatePageBounds: typeof estimatePageBounds;
  } => ({
    analyzeCorpus,
    computeTargetDimensionsPx: (
      dims: { width: number; height: number },
      dpi: number
    ): { width: number; height: number } => ({
      width: Math.round((dims.width / 25.4) * dpi),
      height: Math.round((dims.height / 25.4) * dpi),
    }),
    applyDimensionInference,
    estimatePageBounds,
  })
);
vi.mock("./normalization.ts", (): { normalizePage: typeof normalizePage } => ({ normalizePage }));
vi.mock("./normalization", (): { normalizePage: typeof normalizePage } => ({ normalizePage }));
vi.mock("./normalization.js", (): { normalizePage: typeof normalizePage } => ({ normalizePage }));

const loadRunPipeline = async (): Promise<typeof import("./pipeline-runner.js").runPipeline> => {
  const mod = await import("./pipeline-runner.js");
  return mod.runPipeline;
};

const buildConfig = (pages: PageData[]): PipelineRunConfig => ({
  projectId: "recovery-test",
  pages,
  targetDpi: 300,
  targetDimensionsMm: { width: 210, height: 297 },
});

const buildNormalized = (page: PageData): NormalizationResult => ({
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
  shadow: { present: false, side: "none", widthPx: 0, confidence: 0, darkness: 0 },
  stats: {
    backgroundMean: 240,
    backgroundStd: 5,
    maskCoverage: 0.9,
    skewConfidence: 0.8,
    shadowScore: 0,
  },
});

describe("Pipeline Runner recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("retries scanning and proceeds", async () => {
    vi.resetModules();
    const runPipeline = await loadRunPipeline();
    const pages = [
      { id: "p1", filename: "page-1.jpg", originalPath: "/tmp/page-1.jpg", confidenceScores: {} },
    ];
    let attempts = 0;
    scanCorpus.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("scan failed");
      return buildConfig(pages);
    });
    analyzeCorpus.mockResolvedValueOnce({
      projectId: "recovery-test",
      pageCount: 1,
      dpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
      targetDimensionsPx: { width: 2480, height: 3508 },
      estimates: [
        {
          pageId: "p1",
          widthPx: 2480,
          heightPx: 3508,
          bleedPx: 10,
          trimPx: 0,
          pageBounds: [0, 0, 2480, 3508] as [number, number, number, number],
          contentBounds: [10, 10, 2470, 3498] as [number, number, number, number],
        },
      ],
    });
    normalizePage.mockImplementation(async (page: PageData) => buildNormalized(page));

    const result = await runPipeline({
      projectRoot: "/tmp",
      projectId: "recovery-test",
      outputDir: "/tmp/out",
      enableBookPriors: false,
    });

    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it("falls back to generated summary when analysis fails", async () => {
    vi.resetModules();
    const runPipeline = await loadRunPipeline();
    const pages = [
      { id: "p2", filename: "page-2.jpg", originalPath: "/tmp/page-2.jpg", confidenceScores: {} },
    ];
    scanCorpus.mockResolvedValueOnce(buildConfig(pages));
    analyzeCorpus.mockRejectedValueOnce(new Error("analysis failed"));
    normalizePage.mockImplementation(async (page: PageData) => buildNormalized(page));

    const result = await runPipeline({
      projectRoot: "/tmp",
      projectId: "recovery-test",
      outputDir: "/tmp/out",
      enableBookPriors: false,
    });

    expect(result.analysisSummary.notes).toContain("Fallback summary");
    expect(result.success).toBe(true);
  });

  it("records per-page normalization errors without aborting", async () => {
    vi.resetModules();
    const runPipeline = await loadRunPipeline();
    const pages = [
      { id: "fail", filename: "page-3.jpg", originalPath: "/tmp/page-3.jpg", confidenceScores: {} },
    ];
    scanCorpus.mockResolvedValueOnce(buildConfig(pages));
    analyzeCorpus.mockResolvedValueOnce({
      projectId: "recovery-test",
      pageCount: 1,
      dpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
      targetDimensionsPx: { width: 2480, height: 3508 },
      estimates: [
        {
          pageId: "fail",
          widthPx: 2480,
          heightPx: 3508,
          bleedPx: 10,
          trimPx: 0,
          pageBounds: [0, 0, 2480, 3508] as [number, number, number, number],
          contentBounds: [10, 10, 2470, 3498] as [number, number, number, number],
        },
      ],
    });
    normalizePage.mockRejectedValueOnce(new Error("normalize failed"));

    const result = await runPipeline({
      projectRoot: "/tmp",
      projectId: "recovery-test",
      outputDir: "/tmp/out",
    });

    expect(result.success).toBe(true);
    expect(result.errors.some((entry: { phase: string }) => entry.phase === "normalization")).toBe(
      true
    );
  });
});
