import { describe, expect, it, vi } from "vitest";

const createRequireMock = vi.fn();

vi.mock("node:module", () => ({
  createRequire: createRequireMock,
  default: { createRequire: createRequireMock },
}));

describe("pipeline-core native loader", () => {
  it("returns a fallback when native module is unavailable", async () => {
    vi.resetModules();
    createRequireMock.mockReset();
    createRequireMock.mockReturnValue(() => {
      throw new Error("missing native module");
    });

    const { getPipelineCoreNative } = await import("./pipeline-core-native.js");
    const fallback = getPipelineCoreNative();
    expect(typeof fallback.estimateSkewAngle).toBe("function");
    expect(typeof fallback.dhash9x8).toBe("function");
  });

  it("fallback algorithms return deterministic outputs", async () => {
    vi.resetModules();
    createRequireMock.mockReset();
    createRequireMock.mockReturnValue(() => {
      throw new Error("missing native module");
    });

    const { getPipelineCoreNative } = await import("./pipeline-core-native.js");
    const fallback = getPipelineCoreNative();

    const width = 8;
    const height = 8;
    const data = Buffer.alloc(width * height, 255);
    for (let x = 0; x < width; x += 1) {
      data[2 * width + x] = 0;
      data[5 * width + x] = 0;
    }
    for (let y = 0; y < height; y += 1) {
      data[y * width + 3] = 0;
    }

    const profileX = fallback.projectionProfileX(data, width, height);
    const profileY = fallback.projectionProfileY(data, width, height);
    expect(profileX).toHaveLength(width);
    expect(profileY).toHaveLength(height);

    const sobel = fallback.sobelMagnitude(data, width, height);
    expect(sobel).toHaveLength(width * height);

    const skew = fallback.estimateSkewAngle(data, width, height);
    expect(Number.isFinite(skew.angle)).toBe(true);
    expect(Number.isFinite(skew.confidence)).toBe(true);

    const baseline = fallback.baselineMetrics(data, width, height);
    expect(baseline.textLineCount).toBeGreaterThanOrEqual(1);
    expect(baseline.lineConsistency).toBeGreaterThanOrEqual(0);

    const columns = fallback.columnMetrics(data, width, height);
    expect(columns.columnCount).toBeGreaterThanOrEqual(1);

    const elements = fallback.detectLayoutElements(data, width, height);
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.some((el) => el.id === "page-bounds")).toBe(true);

    const dhashData = Buffer.alloc(9 * 8);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        dhashData[y * 9 + x] = x * 16;
      }
    }
    const hash = fallback.dhash9x8(dhashData);
    expect(hash).not.toBe("0");
  });

  it("fallback returns zero results for invalid dimensions", async () => {
    vi.resetModules();
    createRequireMock.mockReset();
    createRequireMock.mockReturnValue(() => {
      throw new Error("missing native module");
    });

    const { getPipelineCoreNative } = await import("./pipeline-core-native.js");
    const fallback = getPipelineCoreNative();

    // Zero-width image
    const skew0 = fallback.estimateSkewAngle(Buffer.alloc(0), 0, 10);
    expect(skew0.angle).toBe(0);
    expect(skew0.confidence).toBe(0);

    const baseline0 = fallback.baselineMetrics(Buffer.alloc(0), 0, 10);
    expect(baseline0.textLineCount).toBe(0);
    expect(baseline0.lineConsistency).toBe(0);

    const col0 = fallback.columnMetrics(Buffer.alloc(0), 0, 10);
    expect(col0.columnCount).toBe(0);

    // Uniform image produces too few edge points for skew estimation
    const w = 64;
    const h = 64;
    const uniform = Buffer.alloc(w * h, 128);
    const skewUniform = fallback.estimateSkewAngle(uniform, w, h);
    expect(skewUniform.angle).toBe(0);
    expect(skewUniform.confidence).toBe(0);
  });

  it("returns native module when exports are present", async () => {
    vi.resetModules();
    createRequireMock.mockReset();
    const fake = {
      estimateSkewAngle: vi.fn(() => ({ angle: 0, confidence: 0.5 })),
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
      columnMetrics: vi.fn(() => ({ columnCount: 2, columnSeparation: 0.6 })),
      detectLayoutElements: vi.fn(() => []),
      projectionProfileX: vi.fn(() => [1]),
      projectionProfileY: vi.fn(() => [2]),
      sobelMagnitude: vi.fn(() => [3]),
      dhash9x8: vi.fn(() => "deadbeef"),
    };

    createRequireMock.mockReturnValue(() => fake);

    const { getPipelineCoreNative } = await import("./pipeline-core-native.js");
    expect(getPipelineCoreNative()).toBe(fake);
  });
});
