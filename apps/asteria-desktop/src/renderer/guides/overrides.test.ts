import { describe, expect, it } from "vitest";
import type { GuideLayout } from "../../ipc/contracts.js";
import { applyGuideOverrides } from "./overrides.js";

describe("applyGuideOverrides", () => {
  it("rebuilds baseline grid from overrides", () => {
    const base: GuideLayout = {
      layers: [
        {
          id: "baseline-grid",
          guides: [
            { id: "g1", axis: "y", position: 0, kind: "major" },
            { id: "g2", axis: "y", position: 10, kind: "minor" },
          ],
        },
      ],
    };

    const layout = applyGuideOverrides({
      guideLayout: base,
      overrides: { baselineGrid: { spacingPx: 12, offsetPx: 4 } },
      canvasWidth: 200,
      canvasHeight: 40,
    });

    const baseline = layout?.layers.find((layer) => layer.id === "baseline-grid");
    expect(baseline?.guides[0]?.position).toBe(4);
  });

  it("applies margin overrides", () => {
    const base: GuideLayout = {
      layers: [
        {
          id: "margin-guides",
          guides: [
            { id: "m1", axis: "x", position: 10, kind: "major" },
            { id: "m2", axis: "x", position: 190, kind: "major" },
            { id: "m3", axis: "y", position: 8, kind: "major" },
            { id: "m4", axis: "y", position: 180, kind: "major" },
          ],
        },
      ],
    };

    const layout = applyGuideOverrides({
      guideLayout: base,
      overrides: { margins: { leftPx: 12, topPx: 6 } },
      canvasWidth: 200,
      canvasHeight: 200,
    });

    const margins = layout?.layers.find((layer) => layer.id === "margin-guides");
    expect(margins?.guides.some((guide) => guide.position === 12)).toBe(true);
    expect(margins?.guides.some((guide) => guide.position === 6)).toBe(true);
  });
});
