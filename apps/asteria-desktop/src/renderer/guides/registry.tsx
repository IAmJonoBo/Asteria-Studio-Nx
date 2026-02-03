import type { ReactElement } from "react";
import type { GuideLayout, GuideLayerData, GuideLine } from "../../ipc/contracts.js";

export type GuideGroup = "structural" | "detected" | "diagnostic";

export type GuideLod = {
  showMinorGuides: boolean;
  labelVisibility: "none" | "hover" | "all";
};

export type GuideLayerDefinition = {
  id: string;
  group: GuideGroup;
  defaultVisible: boolean;
  renderFn: (context: GuideRenderContext) => ReactElement | null;
  hitTestFn: (context: GuideHitTestContext) => GuideHitTestResult | null;
  editableFn: (context: GuideEditContext) => boolean;
};

export type GuideRenderContext = {
  layer: GuideLayerDefinition;
  layerData?: GuideLayerData;
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  lod: GuideLod;
  palette: string;
  hoveredGuideId?: string;
  activeGuideId?: string;
};

export type GuideHitTestContext = {
  x: number;
  y: number;
  layer: GuideLayerDefinition;
  layerData?: GuideLayerData;
  zoom: number;
};

export type GuideHitTestResult = {
  guideId: string;
  layerId: string;
};

export type GuideEditContext = {
  guideId: string;
  layer: GuideLayerDefinition;
  layerData?: GuideLayerData;
};

export const GUIDE_LOD_THRESHOLDS = {
  minorGuidesZoom: 0.8,
  labelsZoom: 1.6,
};

export const getGuideLod = (zoom: number): GuideLod => {
  if (zoom < GUIDE_LOD_THRESHOLDS.minorGuidesZoom) {
    return { showMinorGuides: false, labelVisibility: "none" };
  }
  if (zoom < GUIDE_LOD_THRESHOLDS.labelsZoom) {
    return { showMinorGuides: true, labelVisibility: "hover" };
  }
  return { showMinorGuides: true, labelVisibility: "all" };
};

const guidePaletteByGroup: Record<GuideGroup, string> = {
  structural: "var(--guide-palette-structural)",
  detected: "var(--guide-palette-detected)",
  diagnostic: "var(--guide-palette-diagnostic)",
};

const renderLinearGuideLayer = (context: GuideRenderContext): ReactElement | null => {
  const {
    layer,
    layerData,
    canvasWidth,
    canvasHeight,
    lod,
    palette,
    hoveredGuideId,
    activeGuideId,
  } = context;
  if (!layerData?.guides?.length) return null;

  const visibleGuides = layerData.guides.filter((guide) => {
    if (guide.kind === "minor") {
      return lod.showMinorGuides;
    }
    return true;
  });

  if (visibleGuides.length === 0) return null;

  const shouldShowLabel = (guide: GuideLine): boolean => {
    if (!guide.label) return false;
    if (lod.labelVisibility === "all") return true;
    if (lod.labelVisibility === "hover") {
      return guide.id === hoveredGuideId || guide.id === activeGuideId;
    }
    return false;
  };

  return (
    <g data-guide-layer={layer.id} stroke={palette} fill="none" pointerEvents="none">
      {visibleGuides.map((guide) => {
        const isMinor = guide.kind === "minor";
        const strokeWidth = isMinor ? "var(--guide-stroke-minor)" : "var(--guide-stroke-major)";
        const strokeDasharray = isMinor ? "var(--guide-dash-minor)" : "var(--guide-dash-solid)";
        if (guide.axis === "x") {
          return (
            <line
              key={guide.id}
              x1={guide.position}
              y1={0}
              x2={guide.position}
              y2={canvasHeight}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
            />
          );
        }
        return (
          <line
            key={guide.id}
            x1={0}
            y1={guide.position}
            x2={canvasWidth}
            y2={guide.position}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
          />
        );
      })}
      {visibleGuides.map((guide) => {
        if (!shouldShowLabel(guide)) return null;
        const labelX = guide.axis === "x" ? guide.position + 4 : 6;
        const labelY = guide.axis === "x" ? 14 : guide.position - 6;
        return (
          <text
            key={`${guide.id}-label`}
            x={labelX}
            y={labelY}
            fontSize={11}
            fill={palette}
            stroke="none"
            textAnchor="start"
          >
            {guide.label}
          </text>
        );
      })}
    </g>
  );
};

const defaultHitTest = (): GuideHitTestResult | null => null;
const defaultEditable = (): boolean => false;

export const guideLayerRegistry: GuideLayerDefinition[] = [
  {
    id: "baseline-grid",
    group: "structural",
    defaultVisible: true,
    renderFn: renderLinearGuideLayer,
    hitTestFn: defaultHitTest,
    editableFn: defaultEditable,
  },
  {
    id: "margin-guides",
    group: "structural",
    defaultVisible: true,
    renderFn: renderLinearGuideLayer,
    hitTestFn: defaultHitTest,
    editableFn: defaultEditable,
  },
  {
    id: "detected-guides",
    group: "detected",
    defaultVisible: false,
    renderFn: renderLinearGuideLayer,
    hitTestFn: defaultHitTest,
    editableFn: defaultEditable,
  },
  {
    id: "diagnostic-guides",
    group: "diagnostic",
    defaultVisible: false,
    renderFn: renderLinearGuideLayer,
    hitTestFn: defaultHitTest,
    editableFn: defaultEditable,
  },
];

export const getDefaultGuideLayerVisibility = (): Record<string, boolean> =>
  guideLayerRegistry.reduce<Record<string, boolean>>((acc, layer) => {
    acc[layer.id] = layer.defaultVisible;
    return acc;
  }, {});

export const renderGuideLayers = ({
  guideLayout,
  zoom,
  canvasWidth,
  canvasHeight,
  hoveredGuideId,
  activeGuideId,
  visibleLayers,
}: {
  guideLayout?: GuideLayout;
  zoom: number;
  canvasWidth: number;
  canvasHeight: number;
  hoveredGuideId?: string;
  activeGuideId?: string;
  visibleLayers?: Record<string, boolean>;
}): ReactElement[] => {
  const lod = getGuideLod(zoom);
  const layerDataMap = new Map<string, GuideLayerData>();
  guideLayout?.layers?.forEach((layer) => {
    layerDataMap.set(layer.id, layer);
  });

  return guideLayerRegistry
    .filter((layer) => visibleLayers?.[layer.id] ?? layer.defaultVisible)
    .map((layer) => {
      const layerData = layerDataMap.get(layer.id);
      const palette = guidePaletteByGroup[layer.group];
      return layer.renderFn({
        layer,
        layerData,
        canvasWidth,
        canvasHeight,
        zoom,
        lod,
        palette,
        hoveredGuideId,
        activeGuideId,
      });
    })
    .filter((entry): entry is ReactElement => entry !== null);
};
