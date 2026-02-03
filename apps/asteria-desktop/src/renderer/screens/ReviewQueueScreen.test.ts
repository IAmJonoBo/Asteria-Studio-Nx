import { describe, expect, it } from "vitest";
import { __testables } from "./ReviewQueueScreen.js";

const { calculateOverlayScale, mapClientPointToOutput, snapBoxToPrior } = __testables;

describe("ReviewQueueScreen geometry helpers", () => {
  it("calculates overlay scale from crop box bounds", () => {
    const scale = calculateOverlayScale(
      { normalization: { cropBox: [0, 0, 99, 199] } } as Parameters<typeof calculateOverlayScale>[0],
      { width: 200, height: 400, path: "preview" }
    );

    expect(scale).toEqual({ x: 2, y: 2 });
  });

  it("maps client coordinates into output space", () => {
    const point = mapClientPointToOutput({
      clientX: 210,
      clientY: 120,
      rect: { left: 10, top: 20, width: 400, height: 200 },
      normalizedWidth: 200,
      normalizedHeight: 100,
      scaleX: 2,
      scaleY: 2,
    });

    expect(point).toEqual({ x: 50, y: 50 });
  });

  it("snaps box edges to priors within threshold", () => {
    const snapped = snapBoxToPrior([10, 10, 100, 100], [12, 8, 100, 96], 3);
    expect(snapped).toEqual([12, 8, 100, 100]);

    const unsnapped = snapBoxToPrior([10, 10, 100, 100], [20, 8, 100, 96], 3);
    expect(unsnapped).toEqual([10, 10, 100, 100]);
  });
});
