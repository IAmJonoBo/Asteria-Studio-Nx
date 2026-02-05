import { describe, it, expect } from "vitest";
import type { BaselineGridGuide, PageLayoutElement } from "../../ipc/contracts.js";
import { buildGuideId, createGuideLayout } from "./guide-layout.js";

describe("createGuideLayout", () => {
  it("builds deterministic baseline and margin guides", () => {
    const elements: PageLayoutElement[] = [
      {
        id: "text-1",
        type: "text_block",
        bbox: [10, 20, 180, 80],
        confidence: 0.9,
      },
    ];
    const baselineGrid: BaselineGridGuide = {
      spacingPx: 10,
      offsetPx: 0,
      angleDeg: 0,
      confidence: 0.8,
      source: "auto",
    };

    const layout = createGuideLayout({
      outputWidth: 200,
      outputHeight: 100,
      elements,
      textFeatures: {
        headBandRatio: 0,
        footerBandRatio: 0,
        columnCount: 1,
        columnValleyRatio: 0,
        contentBox: [10, 20, 180, 80],
      },
      baselineGrid,
    });

    const baselineLayer = layout.layers.find((layer) => layer.id === "baseline-grid");
    expect(baselineLayer).toBeTruthy();
    expect(baselineLayer?.guides[0]?.id).toBe(buildGuideId("baseline-grid", "y", "major", 0));

    const marginLayer = layout.layers.find((layer) => layer.id === "margin-guides");
    expect(marginLayer).toBeTruthy();
    const leftMargin = marginLayer?.guides.find((guide) => guide.axis === "x");
    expect(leftMargin?.position).toBe(10);
  });

  it("adds baseline peak markers when snap-to-peaks is enabled", () => {
    const elements: PageLayoutElement[] = [];
    const baselineGrid: BaselineGridGuide = {
      spacingPx: 12,
      offsetPx: 0,
      angleDeg: 0,
      confidence: 0.7,
      source: "auto",
      snapToPeaks: true,
    };

    const layout = createGuideLayout({
      outputWidth: 200,
      outputHeight: 100,
      elements,
      textFeatures: {
        headBandRatio: 0,
        footerBandRatio: 0,
        columnCount: 1,
        columnValleyRatio: 0,
        contentBox: [0, 0, 200, 100],
      },
      baselineGrid,
      baselinePeaks: [0.1, 0.5, 0.9],
    });

    const diagnosticLayer = layout.layers.find((layer) => layer.id === "diagnostic-guides");
    const peakGuides = diagnosticLayer?.guides.filter((guide) => guide.kind === "minor") ?? [];
    expect(peakGuides.length).toBeGreaterThan(0);
  });
});
