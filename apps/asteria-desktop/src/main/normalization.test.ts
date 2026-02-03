import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { CorpusSummary, PageBoundsEstimate, PageData } from "../ipc/contracts.js";
import { normalizePage, normalizePages } from "./normalization.js";
import { getRunDir } from "./run-paths.js";

type MockMode = "center" | "shadow-left" | "low-coverage" | "noisy" | "high-coverage" | "shaded";

const mockState = {
  width: 64,
  height: 64,
  density: 300,
  mode: "center" as MockMode,
};

const generatePreviewData = (width: number, height: number, mode: MockMode): Uint8Array => {
  const data = new Uint8Array(width * height);
  data.fill(255);

  if (mode === "shadow-left") {
    const strip = Math.max(4, Math.round(width * 0.2));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < strip; x++) {
        data[y * width + x] = 120;
      }
    }
  }

  if (mode === "shaded") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const factor = 0.6 + (x / Math.max(1, width - 1)) * 0.4;
        data[y * width + x] = Math.round(255 * factor);
      }
    }
  }

  if (mode === "noisy") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < 6 || y < 6 || x > width - 7 || y > height - 7) {
          data[y * width + x] = (x + y) % 2 === 0 ? 200 : 255;
        }
      }
    }
  }

  const coverage = mode === "low-coverage" ? 0.25 : mode === "high-coverage" ? 0.85 : 0.6;
  const left = Math.floor(width * (0.5 - coverage / 2));
  const right = Math.floor(width * (0.5 + coverage / 2));
  const top = Math.floor(height * (0.5 - coverage / 2));
  const bottom = Math.floor(height * (0.5 + coverage / 2));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      data[y * width + x] = 200;
    }
  }

  return data;
};

class MockSharp {
  private width = mockState.width;
  private height = mockState.height;
  private density = mockState.density;
  private channels = 3;
  constructor(
    private _input: unknown,
    options?: { raw?: { width: number; height: number } }
  ) {
    if (options?.raw) {
      this.width = options.raw.width;
      this.height = options.raw.height;
    }
  }

  metadata(): Promise<{ width: number; height: number; density: number }> {
    return Promise.resolve({ width: this.width, height: this.height, density: this.density });
  }

  resize(width: number, height?: number): this {
    this.width = width;
    this.height = height ?? width;
    return this;
  }

  rotate(): this {
    return this;
  }

  clone(): this {
    return this;
  }

  ensureAlpha(): this {
    this.channels = 4;
    return this;
  }

  removeAlpha(): this {
    this.channels = 3;
    return this;
  }

  grayscale(): this {
    this.channels = 1;
    return this;
  }

  raw(): this {
    return this;
  }

  extract(): this {
    return this;
  }

  withMetadata(): this {
    return this;
  }

  png(): this {
    return this;
  }

  median(): this {
    return this;
  }

  linear(): this {
    return this;
  }

  sharpen(): this {
    return this;
  }

  blur(): this {
    return this;
  }

  async toBuffer(): Promise<{
    data: Buffer;
    info: { width: number; height: number; channels: number };
  }> {
    const base = generatePreviewData(this.width, this.height, mockState.mode);
    const data = Buffer.alloc(this.width * this.height * this.channels);
    for (let i = 0; i < this.width * this.height; i++) {
      const value = base[i];
      const offset = i * this.channels;
      data[offset] = value;
      if (this.channels > 1) {
        data[offset + 1] = value;
        data[offset + 2] = value;
      }
      if (this.channels === 4) {
        data[offset + 3] = 255;
      }
    }
    return {
      data,
      info: { width: this.width, height: this.height, channels: this.channels },
    };
  }

  async toFile(): Promise<{ width: number; height: number }> {
    return { width: this.width, height: this.height };
  }
}

vi.mock("sharp", () => ({
  default: (input: unknown, options?: { raw?: { width: number; height: number } }): MockSharp =>
    new MockSharp(input, options),
}));

const buildAnalysis = (estimate: PageBoundsEstimate): CorpusSummary => ({
  projectId: "proj",
  pageCount: 1,
  dpi: 300,
  targetDimensionsMm: { width: 210, height: 297 },
  targetDimensionsPx: { width: 64, height: 64 },
  estimates: [estimate],
});

const buildPage = (): PageData => ({
  id: "page-1",
  filename: "page-1.png",
  originalPath: "/tmp/page-1.png",
  confidenceScores: {},
});

const makeRunDir = async (
  prefix: string,
  runId = "run-1"
): Promise<{ outputDir: string; runDir: string }> => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { outputDir, runDir: getRunDir(outputDir, runId) };
};

describe("normalization", () => {
  it("normalizes a page with previews and corrections", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "center";
    const estimate: PageBoundsEstimate = {
      pageId: "page-1",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { outputDir, runDir } = await makeRunDir("asteria-normalize-", "run-normalize");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: true,
    });

    expect(result.normalizedPath).toContain(path.join(runDir, "normalized"));
    expect(result.previews?.source?.path).toContain(path.join(runDir, "previews"));
    expect(result.previews?.normalized?.path).toContain(path.join(runDir, "previews"));
    expect(result.corrections?.alignment?.applied).toBe(true);
    expect(result.corrections?.morphology?.reason.length).toBeGreaterThan(0);
    expect(result.corrections?.baseline?.lineConsistency).toBeGreaterThan(0);
    expect(result.corrections?.columns?.columnCount).toBeGreaterThan(0);
    expect(result.stats.maskCoverage).toBeGreaterThan(0);
    await expect(fs.stat(path.join(outputDir, "normalized"))).rejects.toThrow();
    await expect(fs.stat(path.join(outputDir, "previews"))).rejects.toThrow();
  });

  it("uses metadata density when available", async () => {
    mockState.width = 210;
    mockState.height = 297;
    mockState.density = 600;
    mockState.mode = "high-coverage";
    const estimate: PageBoundsEstimate = {
      pageId: "page-meta",
      widthPx: 210,
      heightPx: 297,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 210, 297],
      contentBounds: [4, 4, 206, 293],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-meta-", "run-meta");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: false,
    });

    expect(result.dpiSource).toBe("metadata");
  });

  it("falls back to target sizing when metadata aspect drifts", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 600;
    mockState.mode = "high-coverage";
    const estimate: PageBoundsEstimate = {
      pageId: "page-meta-drift",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-meta-drift-", "run-meta-drift");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: false,
    });

    expect(result.dpiSource).toBe("fallback");
  });

  it("reduces background variance on shaded pages", async () => {
    mockState.width = 96;
    mockState.height = 96;
    mockState.density = 300;
    mockState.mode = "shaded";
    const estimate: PageBoundsEstimate = {
      pageId: "page-shaded",
      widthPx: 96,
      heightPx: 96,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 96, 96],
      contentBounds: [6, 6, 90, 90],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-shaded-", "run-shaded");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      shading: { enabled: true },
    });

    expect(result.stats.illuminationResidual).toBeDefined();
    expect(result.stats.illuminationResidual ?? 1).toBeLessThan(1);
  });

  it("detects spine shadow on gradient edges", async () => {
    mockState.width = 80;
    mockState.height = 80;
    mockState.density = 300;
    mockState.mode = "shadow-left";
    const estimate: PageBoundsEstimate = {
      pageId: "page-shadow",
      widthPx: 80,
      heightPx: 80,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 80, 80],
      contentBounds: [4, 4, 76, 76],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-shadow-", "run-shadow");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      shading: { enabled: true },
    });

    expect(result.stats.spineShadowScore ?? 0).toBeGreaterThan(0.1);
  });

  it("keeps crops stable when shading is disabled", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "center";
    const estimate: PageBoundsEstimate = {
      pageId: "page-stable",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir: runDirA } = await makeRunDir("asteria-stable-a-", "run-stable-a");
    const { runDir: runDirB } = await makeRunDir("asteria-stable-b-", "run-stable-b");

    const enabled = await normalizePage(buildPage(), estimate, analysis, runDirA, {
      shading: { enabled: true },
    });
    const disabled = await normalizePage(buildPage(), estimate, analysis, runDirB, {
      shading: { enabled: false },
    });

    expect(disabled.cropBox).toEqual(enabled.cropBox);
    expect(disabled.maskBox).toEqual(enabled.maskBox);
  });

  it("snaps to book median trim box when within drift", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "center";
    const estimate: PageBoundsEstimate = {
      pageId: "page-book",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-book-", "run-book");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      bookPriors: {
        model: {
          trimBoxPx: { median: [2, 2, 62, 62], dispersion: [1, 1, 1, 1] },
        },
        maxTrimDriftPx: 18,
      },
    });

    expect(result.corrections?.bookSnap?.applied).toBe(true);
  });

  it("infers common size when aspect ratio matches", async () => {
    mockState.width = 210;
    mockState.height = 297;
    mockState.density = 0;
    mockState.mode = "high-coverage";
    const estimate: PageBoundsEstimate = {
      pageId: "page-infer",
      widthPx: 210,
      heightPx: 297,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 210, 297],
      contentBounds: [4, 4, 206, 293],
    };
    const analysis = buildAnalysis(estimate);
    analysis.targetDimensionsPx = { width: 210, height: 297 };
    const { runDir } = await makeRunDir("asteria-infer-", "run-infer");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: false,
    });

    expect(result.dpiSource).toBe("inferred");
  });

  it("falls back when aspect ratio does not match", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 0;
    mockState.mode = "low-coverage";
    const estimate: PageBoundsEstimate = {
      pageId: "page-fallback",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-fallback-", "run-fallback");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: false,
    });

    expect(result.dpiSource).toBe("fallback");
    expect(result.corrections?.morphology?.contrastBoost).toBe(true);
    expect(result.corrections?.edgeFallbackApplied).toBe(true);
    expect(result.corrections?.edgeAnchorApplied).toBe(true);
  });

  it("flags alignment drift when aspect ratio diverges", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "center";
    const estimate: PageBoundsEstimate = {
      pageId: "page-align",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-align-", "run-align");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      priors: {
        targetAspectRatio: 2,
        medianBleedPx: 6,
        medianTrimPx: 2,
        adaptivePaddingPx: 0,
        edgeThresholdScale: 1,
        intensityThresholdBias: 0,
        shadowTrimScale: 1,
        maxAspectRatioDrift: 0.01,
      },
      generatePreviews: false,
    });

    expect(result.corrections?.alignment?.applied).toBe(false);
  });

  it("expands crop when target aspect ratio is wider", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "high-coverage";
    const estimate: PageBoundsEstimate = {
      pageId: "page-wide",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-wide-", "run-wide");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      priors: {
        targetAspectRatio: 1.4,
        medianBleedPx: 6,
        medianTrimPx: 2,
        adaptivePaddingPx: 0,
        edgeThresholdScale: 1,
        intensityThresholdBias: 0,
        shadowTrimScale: 1,
        maxAspectRatioDrift: 1,
      },
      generatePreviews: false,
    });

    expect(result.corrections?.alignment?.applied).toBe(true);
  });

  it("expands crop when target aspect ratio is taller", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "high-coverage";
    const estimate: PageBoundsEstimate = {
      pageId: "page-tall",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-tall-", "run-tall");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      priors: {
        targetAspectRatio: 0.6,
        medianBleedPx: 6,
        medianTrimPx: 2,
        adaptivePaddingPx: 0,
        edgeThresholdScale: 1,
        intensityThresholdBias: 0,
        shadowTrimScale: 1,
        maxAspectRatioDrift: 1,
      },
      generatePreviews: false,
    });

    expect(result.corrections?.alignment?.applied).toBe(true);
  });

  it("detects shadows and denoise plan", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "shadow-left";
    const estimate: PageBoundsEstimate = {
      pageId: "page-shadow",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-shadow-", "run-shadow-extra");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: false,
    });

    expect(result.shadow.present).toBe(true);
    expect(result.corrections?.morphology?.denoise).toBe(true);
  });

  it("forces skew refinement when configured", async () => {
    mockState.width = 64;
    mockState.height = 64;
    mockState.density = 300;
    mockState.mode = "center";
    const estimate: PageBoundsEstimate = {
      pageId: "page-refine",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-refine-", "run-refine");

    const result = await normalizePage(buildPage(), estimate, analysis, runDir, {
      generatePreviews: false,
      skewRefinement: "forced",
    });

    expect(result.corrections?.skewRefined).toBe(true);
  });

  it("normalizes multiple pages", async () => {
    const estimate: PageBoundsEstimate = {
      pageId: "page-1",
      widthPx: 64,
      heightPx: 64,
      bleedPx: 6,
      trimPx: 2,
      pageBounds: [0, 0, 64, 64],
      contentBounds: [4, 4, 60, 60],
    };
    const analysis = buildAnalysis(estimate);
    const { runDir } = await makeRunDir("asteria-normalize-many-", "run-many");

    const pages = [buildPage()];
    const results = await normalizePages(pages, analysis, runDir, { generatePreviews: false });

    expect(results.size).toBe(1);
    expect(results.get("page-1")).toBeDefined();
  });
});
