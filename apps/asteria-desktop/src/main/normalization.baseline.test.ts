import { describe, expect, it, vi } from "vitest";

vi.mock("./pipeline-core-native.js", () => ({
  getPipelineCoreNative: () => null,
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
    expect(first.textLineCount).toBe(stripeRows.length);
    expect(first.lineConsistency).toBeGreaterThan(0.3);
  });
});
