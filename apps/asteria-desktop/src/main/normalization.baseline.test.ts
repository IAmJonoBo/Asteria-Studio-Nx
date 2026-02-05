import { describe, expect, it, vi } from "vitest";

const baselineMetrics = vi.fn(() => ({
  lineConsistency: 0.62,
  textLineCount: 7,
  spacingNorm: 0.05,
  spacingMadNorm: 0.004,
  offsetNorm: 0.01,
  angleDeg: 0.12,
  confidence: 0.7,
  peakSharpness: 1.1,
  peaksY: [0.1, 0.2, 0.3],
}));

vi.mock("./pipeline-core-native.js", () => ({
  getPipelineCoreNative: () => ({
    baselineMetrics,
  }),
}));

import { __testables } from "./normalization.js";

type PreviewImage = {
  data: Uint8Array;
  width: number;
  height: number;
  scale: number;
};

const buildStripedPreview = (width: number, height: number, stripeRows: number[]): PreviewImage => {
  const data = new Uint8Array(width * height).fill(255);
  for (const y of stripeRows) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = 0;
    }
  }
  return { data, width, height, scale: 1 };
};

describe("baseline metrics", () => {
  it("detects deterministic baseline peaks", () => {
    const stripeRows = [4, 8, 12, 16, 20, 24, 28];
    const preview = buildStripedPreview(32, 32, stripeRows);

    const first = __testables.estimateBaselineMetrics(preview, 0.12);
    const second = __testables.estimateBaselineMetrics(preview, 0.12);

    expect(second).toEqual(first);
    expect(first.textLineCount).toBe(7);
    expect(first.lineConsistency).toBeGreaterThan(0.1);
    expect(baselineMetrics).toHaveBeenCalledTimes(2);
  });
});
