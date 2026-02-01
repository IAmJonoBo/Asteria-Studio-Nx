import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeCorpus,
  computeTargetDimensionsPx,
  estimatePageBounds,
  mmToPx,
} from "./corpusAnalysis";
import type { PipelineRunConfig } from "./contracts";

const buildConfig = (): PipelineRunConfig => ({
  projectId: "proj-corpus",
  pages: [
    { id: "p1", filename: "page1.png", originalPath: "/input/p1", confidenceScores: {} },
    { id: "p2", filename: "page2.png", originalPath: "/input/p2", confidenceScores: {} },
  ],
  targetDpi: 400,
  targetDimensionsMm: { width: 210, height: 297 },
});

const mockDimensions = async (): Promise<{ width: number; height: number }> => ({
  width: 2480,
  height: 3508,
});

describe("corpusAnalysis", () => {
  it("converts mm to px using dpi", () => {
    expect(mmToPx(25.4, 254)).toBeCloseTo(254);
  });

  it("computes target dimensions in px", () => {
    const dims = computeTargetDimensionsPx({ width: 210, height: 297 }, 400);
    expect(dims.width).toBeGreaterThan(3000);
    expect(dims.height).toBeGreaterThan(dims.width);
  });

  it("estimates page bounds for each page", async () => {
    const { bounds } = await estimatePageBounds(buildConfig(), {
      dimensionProvider: mockDimensions,
    });
    expect(bounds).toHaveLength(2);
    expect(bounds[0].pageBounds[2]).toBeGreaterThan(2000);
    expect(bounds[0].contentBounds[0]).toBeGreaterThan(0);
  });

  it("produces corpus summary with estimates", async () => {
    const summary = await analyzeCorpus(buildConfig());
    expect(summary.pageCount).toBe(2);
    expect(summary.estimates[0].pageId).toBe("p1");
    expect(summary.targetDimensionsPx.width).toBeGreaterThan(3000);
  });

  it("falls back to target dimensions when no probe is available", async () => {
    const config = buildConfig();
    config.pages[0].originalPath = "page1.txt"; // unsupported extension

    const { bounds } = await estimatePageBounds(config, {
      dimensionProvider: async () => null,
    });

    expect(bounds[0].widthPx).toBeGreaterThan(3000);
    expect(bounds[0].bleedPx).toBeGreaterThan(0);
  });

  it("probes JPEG dimensions when available", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-corpus-"));
    const jpegPath = path.join(tmpDir, "probe.jpg");
    const relativePath = path.relative(tmpDir, jpegPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Refusing to write outside temp directory");
    }

    // Minimal JPEG with width=32, height=16
    const jpegBuffer = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xc0, // SOF0
      0x00,
      0x11, // length 17
      0x08, // precision
      0x00,
      0x10, // height 16
      0x00,
      0x20, // width 32
      0x03, // components
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x00,
      0xff,
      0xd9, // EOI
    ]);

    await fs.writeFile(jpegPath, jpegBuffer);

    const config = buildConfig();
    config.pages[0].originalPath = jpegPath;

    const { bounds } = await estimatePageBounds(config);
    expect(bounds[0].widthPx).toBeGreaterThan(3000);
    expect(bounds[0].heightPx).toBeGreaterThan(3000);
  });

  it("falls back when JPEG is unreadable", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-corpus-"));
    const jpegPath = path.join(tmpDir, "tiny.jpg");
    await fs.writeFile(jpegPath, Buffer.from([0xff, 0xd8])); // shorter than SOF search

    const config = buildConfig();
    config.pages[0].originalPath = jpegPath;

    const { bounds } = await estimatePageBounds(config);
    expect(bounds[0].widthPx).toBeGreaterThan(3000);
    expect(bounds[0].heightPx).toBeGreaterThan(3000);
  });

  it("skips short JPEG segments and falls back", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-corpus-"));
    const jpegPath = path.join(tmpDir, "short-segment.jpg");
    const jpegBuffer = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0, // APP0
      0x00,
      0x02, // length 2 (too short)
      0xff,
      0xd9, // EOI
    ]);
    await fs.writeFile(jpegPath, jpegBuffer);

    const config = buildConfig();
    config.pages[0].originalPath = jpegPath;

    const { bounds } = await estimatePageBounds(config);
    expect(bounds[0].widthPx).toBeGreaterThan(3000);
    expect(bounds[0].heightPx).toBeGreaterThan(3000);
  });
});
