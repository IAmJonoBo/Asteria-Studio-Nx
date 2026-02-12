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

  it("applies column overrides with finite values", () => {
    const base: GuideLayout = {
      layers: [
        {
          id: "column-guides",
          guides: [
            { id: "c1", axis: "x", position: 80, kind: "major" },
            { id: "c2", axis: "x", position: 120, kind: "major" },
          ],
        },
      ],
    };

    const layout = applyGuideOverrides({
      guideLayout: base,
      overrides: { columns: { leftPx: 90, rightPx: 110 } },
      canvasWidth: 200,
      canvasHeight: 200,
    });

    const columns = layout?.layers.find((layer) => layer.id === "column-guides");
    expect(columns).toBeTruthy();
    expect(columns?.guides.some((guide) => guide.position === 90)).toBe(true);
    expect(columns?.guides.some((guide) => guide.position === 110)).toBe(true);
  });

  it("removes column layer when overrides nullify both positions", () => {
    const base: GuideLayout = {
      layers: [],
    };

    const layout = applyGuideOverrides({
      guideLayout: base,
      overrides: { columns: { leftPx: null, rightPx: null } },
      canvasWidth: 200,
      canvasHeight: 200,
    });

    const columns = layout?.layers.find((layer) => layer.id === "column-guides");
    expect(columns).toBeUndefined();
  });

  it("applies header/footer band overrides", () => {
    const base: GuideLayout = {
      layers: [
        {
          id: "header-footer-bands",
          guides: [
            { id: "h1", axis: "y", position: 10, kind: "major" },
            { id: "h2", axis: "y", position: 190, kind: "major" },
          ],
        },
      ],
    };

    const layout = applyGuideOverrides({
      guideLayout: base,
      overrides: { headerBand: { startPx: 5, endPx: 15 } },
      canvasWidth: 200,
      canvasHeight: 200,
    });

    const bands = layout?.layers.find((layer) => layer.id === "header-footer-bands");
    expect(bands).toBeTruthy();
    expect(bands?.guides.some((guide) => guide.position === 5)).toBe(true);
    expect(bands?.guides.some((guide) => guide.position === 15)).toBe(true);
  });

  it("returns undefined when no layout and no overrides", () => {
    const layout = applyGuideOverrides({
      guideLayout: undefined,
      overrides: undefined,
      canvasWidth: 200,
      canvasHeight: 200,
    });

    expect(layout).toBeUndefined();
  });
});
