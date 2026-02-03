import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../../ipc/contracts.js";
import type { GuideLayout } from "../../ipc/contracts.js";
import { getGuideLod, guidePaletteByGroup, renderGuideLayers } from "./registry.js";

describe("guide registry LOD thresholds", () => {
  it("responds to guide LOD config changes", () => {
    const zoom = 0.8;
    const relaxedConfig = {
      guides: { lod: { major_only_zoom: 0.5, labels_zoom: 1.0 } },
    } as PipelineConfig;
    const strictConfig = {
      guides: { lod: { major_only_zoom: 0.9, labels_zoom: 1.8 } },
    } as PipelineConfig;

    expect(getGuideLod(zoom, relaxedConfig)).toEqual({
      showMinorGuides: true,
      labelVisibility: "hover",
    });
    expect(getGuideLod(zoom, strictConfig)).toEqual({
      showMinorGuides: false,
      labelVisibility: "none",
    });
  });
});

describe("guide registry tokens", () => {
  it("maps guide categories to the spec-defined palette tokens", () => {
    expect(guidePaletteByGroup).toEqual({
      structural: "var(--guide-passive)",
      detected: "var(--guide-major)",
      diagnostic: "var(--guide-hover)",
    });
  });
});

describe("guide registry rendering", () => {
  it("renders explicit guide layers once minor guides are visible", () => {
    const layerIds = [
      "baseline-grid",
      "rulers",
      "margin-guides",
      "column-guides",
      "gutter-bands",
      "header-footer-bands",
      "ornament-anchors",
    ];
    const guideLayout: GuideLayout = {
      layers: layerIds.map((id, index) => ({
        id,
        guides: [
          {
            id: `${id}-minor`,
            axis: "x",
            position: 12 + index * 4,
            kind: "minor",
          },
        ],
      })),
    };
    const visibleLayers = Object.fromEntries(layerIds.map((id) => [id, true]));

    const lowZoomLayers = renderGuideLayers({
      guideLayout,
      zoom: 0.5,
      canvasWidth: 200,
      canvasHeight: 200,
      visibleLayers,
    });
    expect(lowZoomLayers).toHaveLength(0);

    const highZoomLayers = renderGuideLayers({
      guideLayout,
      zoom: 1.0,
      canvasWidth: 200,
      canvasHeight: 200,
      visibleLayers,
    });

    expect(highZoomLayers.map((layer) => layer.props["data-guide-layer"])).toEqual(layerIds);
  });
});
