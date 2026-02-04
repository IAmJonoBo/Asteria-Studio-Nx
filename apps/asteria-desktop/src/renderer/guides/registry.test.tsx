import type { ReactElement } from "react";
import { Children } from "react";
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

  it("shows all labels when zoom is high", () => {
    const zoom = 2.5;
    expect(getGuideLod(zoom)).toEqual({
      showMinorGuides: true,
      labelVisibility: "all",
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
  const getLayerProps = (layer: ReactElement): Record<string, unknown> =>
    layer.props as Record<string, unknown>;

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

    expect(highZoomLayers.map((layer) => getLayerProps(layer)["data-guide-layer"])).toEqual(
      layerIds
    );
  });

  it("applies per-group opacity when rendering guides", () => {
    const guideLayout: GuideLayout = {
      layers: [
        {
          id: "baseline-grid",
          guides: [
            {
              id: "baseline-major",
              axis: "x",
              position: 12,
              kind: "major",
            },
          ],
        },
      ],
    };

    const renderedLayers = renderGuideLayers({
      guideLayout,
      zoom: 1,
      canvasWidth: 200,
      canvasHeight: 200,
      visibleLayers: { "baseline-grid": true },
      groupOpacities: { structural: 0.35 },
    });

    expect(renderedLayers).toHaveLength(1);
    expect(getLayerProps(renderedLayers[0]).opacity).toBeCloseTo(0.35);
  });

  it("can solo a guide group", () => {
    const layerIds = ["baseline-grid", "gutter-bands", "header-footer-bands", "diagnostic-guides"];
    const guideLayout: GuideLayout = {
      layers: layerIds.map((id, index) => ({
        id,
        guides: [
          {
            id: `${id}-major`,
            axis: "x",
            position: 12 + index * 4,
            kind: "major",
          },
        ],
      })),
    };
    const visibleLayers = Object.fromEntries(layerIds.map((id) => [id, true]));

    const soloLayers = renderGuideLayers({
      guideLayout,
      zoom: 1,
      canvasWidth: 200,
      canvasHeight: 200,
      visibleLayers,
      soloGroup: "detected",
    });

    expect(soloLayers.map((layer) => getLayerProps(layer)["data-guide-layer"])).toEqual([
      "gutter-bands",
      "header-footer-bands",
    ]);
  });

  it("renders labels for hovered guides at hover zoom", () => {
    const guideLayout: GuideLayout = {
      layers: [
        {
          id: "baseline-grid",
          guides: [
            {
              id: "label-guide",
              axis: "x",
              position: 24,
              kind: "major",
              label: "Baseline",
            },
          ],
        },
      ],
    };

    const renderedLayers = renderGuideLayers({
      guideLayout,
      zoom: 1.0,
      canvasWidth: 200,
      canvasHeight: 200,
      visibleLayers: { "baseline-grid": true },
      hoveredGuideId: "label-guide",
    });

    const children = Children.toArray(
      getLayerProps(renderedLayers[0]).children as ReactElement | ReactElement[]
    );
    const labels = children.filter(
      (child) =>
        typeof child === "object" && child !== null && (child as ReactElement).type === "text"
    );
    expect(labels).toHaveLength(1);
  });
});
