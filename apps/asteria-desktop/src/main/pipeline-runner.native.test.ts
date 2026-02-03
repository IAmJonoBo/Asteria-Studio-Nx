import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { PageData } from "../ipc/contracts.js";
import type { NormalizationResult } from "./normalization.js";

const mockNative = {
  estimateSkewAngle: vi.fn(() => ({ angle: 0, confidence: 0.8 })),
  baselineMetrics: vi.fn(() => ({
    lineConsistency: 0.8,
    textLineCount: 12,
    spacingNorm: 0.05,
    spacingMadNorm: 0.005,
    offsetNorm: 0.02,
    angleDeg: 0,
    confidence: 0.7,
    peakSharpness: 1.2,
    peaksY: [0.1, 0.2, 0.3],
  })),
  columnMetrics: vi.fn(() => ({ columnCount: 1, columnSeparation: 0.6 })),
  detectLayoutElements: vi.fn(() => [
    { id: "native-1", type: "text_block", bbox: [0, 0, 10, 10], confidence: 0.8 },
  ]),
  projectionProfileX: vi.fn(() => [1]),
  projectionProfileY: vi.fn(() => [2]),
  sobelMagnitude: vi.fn(() => [3]),
  dhash9x8: vi.fn(() => "abcd"),
};

let normalizedPath = "";

const buildNormalization = (page: PageData): NormalizationResult => ({
  pageId: page.id,
  normalizedPath,
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
    illuminationResidual: 0,
    spineShadowScore: 0,
  },
  corrections: {
    deskewAngle: 0.1,
    baseline: { lineConsistency: 0.8, textLineCount: 12, residualAngle: 0.1, peaksY: [] },
  },
});

vi.mock("./pipeline-core-native.ts", (): { getPipelineCoreNative: () => typeof mockNative } => ({
  getPipelineCoreNative: (): typeof mockNative => mockNative,
}));

vi.mock("./remote-inference.ts", (): { requestRemoteLayout: ReturnType<typeof vi.fn> } => ({
  requestRemoteLayout: vi.fn(async (): Promise<null> => null),
}));

vi.mock(
  "./normalization.ts",
  (): { normalizePages: ReturnType<typeof vi.fn>; normalizePage: ReturnType<typeof vi.fn> } => ({
    normalizePages: vi.fn(
      async (pages: PageData[]) => new Map(pages.map((page) => [page.id, buildNormalization(page)]))
    ),
    normalizePage: vi.fn(async (page: PageData) => buildNormalization(page)),
  })
);

vi.mock(
  "./normalization",
  (): { normalizePages: ReturnType<typeof vi.fn>; normalizePage: ReturnType<typeof vi.fn> } => ({
    normalizePages: vi.fn(
      async (pages: PageData[]) => new Map(pages.map((page) => [page.id, buildNormalization(page)]))
    ),
    normalizePage: vi.fn(async (page: PageData) => buildNormalization(page)),
  })
);

vi.mock(
  "./normalization.js",
  (): { normalizePages: ReturnType<typeof vi.fn>; normalizePage: ReturnType<typeof vi.fn> } => ({
    normalizePages: vi.fn(
      async (pages: PageData[]) => new Map(pages.map((page) => [page.id, buildNormalization(page)]))
    ),
    normalizePage: vi.fn(async (page: PageData) => buildNormalization(page)),
  })
);

import { runPipeline } from "./pipeline-runner.js";

describe("Pipeline Runner native coverage", () => {
  let tempDir: string;

  beforeEach(async () => {
    mockNative.detectLayoutElements.mockClear();
    mockNative.dhash9x8.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-native-"));
    const imgPath = path.join(tempDir, "page-0.jpg");
    await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xc0]));

    normalizedPath = path.join(tempDir, "normalized.png");
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toFile(normalizedPath);
  });

  it("uses native layout and dhash when available", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-native-out-"));
    const result = await runPipeline({
      projectRoot: tempDir,
      projectId: "native-test",
      sampleCount: 1,
      outputDir,
    });

    expect(result.success).toBe(true);
    expect(mockNative.detectLayoutElements).toHaveBeenCalled();
    expect(mockNative.dhash9x8).toHaveBeenCalled();
  });
});
