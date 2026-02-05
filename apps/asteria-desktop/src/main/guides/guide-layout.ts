import type {
  BaselineGridGuide,
  GuideLayerData,
  GuideLayout,
  GuideLine,
  PageLayoutElement,
  PageTemplate,
} from "../../ipc/contracts.js";

type Box = [number, number, number, number];

type GuideLayoutContext = {
  outputWidth: number;
  outputHeight: number;
  maskBoxOut?: Box;
  cropBoxOut?: Box;
  elements: PageLayoutElement[];
  textFeatures: {
    headBandRatio: number;
    footerBandRatio: number;
    columnCount: number;
    columnValleyRatio: number;
    contentBox: Box;
  };
  spread?: { gutter?: { startRatio: number; endRatio: number } };
  baselineGrid?: BaselineGridGuide | null;
  baselinePeaks?: number[];
  template?: PageTemplate | null;
  templateConfidence?: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const roundPosition = (value: number): number => Number(value.toFixed(1));

export const buildGuideId = (
  layerId: string,
  axis: "x" | "y",
  kind: "major" | "minor",
  position: number
): string => `${layerId}:${axis}:${kind}:${roundPosition(position)}`;

const createGuideLine = (params: {
  layerId: string;
  axis: "x" | "y";
  position: number;
  kind: "major" | "minor";
  role?: GuideLine["role"];
  source?: GuideLine["source"];
  confidence?: number;
  label?: string;
  locked?: boolean;
}): GuideLine => ({
  id: buildGuideId(params.layerId, params.axis, params.kind, params.position),
  axis: params.axis,
  position: roundPosition(params.position),
  kind: params.kind,
  role: params.role,
  source: params.source,
  confidence: params.confidence,
  label: params.label,
  locked: params.locked,
});

const sortGuides = (guides: GuideLine[]): GuideLine[] =>
  guides
    .slice()
    .sort((a, b) => (a.axis === b.axis ? a.position - b.position : a.axis.localeCompare(b.axis)));

const buildBaselineGridLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const baseline = context.baselineGrid;
  if (!baseline || !isFiniteNumber(baseline.spacingPx)) return null;
  const spacing = Math.max(1, baseline.spacingPx);
  const offset = isFiniteNumber(baseline.offsetPx) ? baseline.offsetPx : 0;
  const guides: GuideLine[] = [];
  const majorStride = Math.max(1, Math.round(24 / spacing));

  let position = offset;
  while (position < 0) position += spacing;
  let index = 0;
  while (position <= context.outputHeight) {
    const kind = index % majorStride === 0 ? "major" : "minor";
    guides.push(
      createGuideLine({
        layerId: "baseline-grid",
        axis: "y",
        position,
        kind,
        role: "baseline",
        source: baseline.source ?? "auto",
        confidence: baseline.confidence,
      })
    );
    position += spacing;
    index += 1;
  }
  if (guides.length === 0) return null;
  return { id: "baseline-grid", guides: sortGuides(guides) };
};

const buildMarginGuidesLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const { outputWidth, outputHeight } = context;
  const templateMargins = context.template?.margins;
  const source = templateMargins ? "template" : "auto";
  const confidence = templateMargins
    ? (context.templateConfidence ?? context.template?.confidence)
    : 0.6;
  const margins = templateMargins
    ? {
        top: clamp(templateMargins.top * outputHeight, 0, outputHeight),
        right: clamp(outputWidth - templateMargins.right * outputWidth, 0, outputWidth),
        bottom: clamp(outputHeight - templateMargins.bottom * outputHeight, 0, outputHeight),
        left: clamp(templateMargins.left * outputWidth, 0, outputWidth),
      }
    : {
        top: context.textFeatures.contentBox[1],
        right: context.textFeatures.contentBox[2],
        bottom: context.textFeatures.contentBox[3],
        left: context.textFeatures.contentBox[0],
      };

  const guides: GuideLine[] = [
    createGuideLine({
      layerId: "margin-guides",
      axis: "x",
      position: margins.left,
      kind: "major",
      role: "margin",
      source,
      confidence,
      label: "Margin L",
    }),
    createGuideLine({
      layerId: "margin-guides",
      axis: "x",
      position: margins.right,
      kind: "major",
      role: "margin",
      source,
      confidence,
      label: "Margin R",
    }),
    createGuideLine({
      layerId: "margin-guides",
      axis: "y",
      position: margins.top,
      kind: "major",
      role: "margin",
      source,
      confidence,
      label: "Margin T",
    }),
    createGuideLine({
      layerId: "margin-guides",
      axis: "y",
      position: margins.bottom,
      kind: "major",
      role: "margin",
      source,
      confidence,
      label: "Margin B",
    }),
  ];

  return { id: "margin-guides", guides: sortGuides(guides) };
};

const buildColumnGuidesLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const templateColumns = context.template?.columns;
  const columnCount = templateColumns?.count ?? context.textFeatures.columnCount;
  if (columnCount < 2) return null;
  const valleyRatio = templateColumns?.valleyRatio ?? context.textFeatures.columnValleyRatio;
  if (!isFiniteNumber(valleyRatio) || valleyRatio <= 0) return null;

  const { outputWidth } = context;
  const [contentLeft, , contentRight] = context.textFeatures.contentBox;
  const contentWidth = Math.max(1, contentRight - contentLeft);
  const gap = clamp(valleyRatio * outputWidth, 1, contentWidth);
  const columnWidth = Math.max(1, (contentWidth - gap) / 2);
  const leftBoundary = contentLeft + columnWidth;
  const rightBoundary = leftBoundary + gap;
  const source = templateColumns ? "template" : "auto";
  const confidence = templateColumns
    ? (context.templateConfidence ?? context.template?.confidence)
    : 0.55;

  const guides: GuideLine[] = [
    createGuideLine({
      layerId: "column-guides",
      axis: "x",
      position: leftBoundary,
      kind: "major",
      role: "column",
      source,
      confidence,
      label: "Column",
    }),
    createGuideLine({
      layerId: "column-guides",
      axis: "x",
      position: rightBoundary,
      kind: "major",
      role: "column",
      source,
      confidence,
      label: "Column",
    }),
  ];

  return { id: "column-guides", guides: sortGuides(guides) };
};

const buildGutterBandsLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const gutter = context.spread?.gutter;
  if (!gutter) return null;
  const start = clamp(gutter.startRatio * context.outputWidth, 0, context.outputWidth);
  const end = clamp(gutter.endRatio * context.outputWidth, 0, context.outputWidth);
  const guides: GuideLine[] = [
    createGuideLine({
      layerId: "gutter-bands",
      axis: "x",
      position: start,
      kind: "major",
      role: "gutter",
      source: "auto",
      confidence: 0.75,
      label: "Gutter",
    }),
    createGuideLine({
      layerId: "gutter-bands",
      axis: "x",
      position: end,
      kind: "major",
      role: "gutter",
      source: "auto",
      confidence: 0.75,
      label: "Gutter",
    }),
  ];
  return { id: "gutter-bands", guides: sortGuides(guides) };
};

const buildHeaderFooterBandsLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const { outputHeight, outputWidth } = context;
  const headerElements = context.elements.filter((el) => el.type === "running_head");
  const footerElements = context.elements.filter((el) => ["folio", "footnote"].includes(el.type));

  const guides: GuideLine[] = [];

  const headerBand = headerElements.length
    ? headerElements.reduce<Box>(
        (acc, element) => [
          Math.min(acc[0], element.bbox[0]),
          Math.min(acc[1], element.bbox[1]),
          Math.max(acc[2], element.bbox[2]),
          Math.max(acc[3], element.bbox[3]),
        ],
        [
          headerElements[0].bbox[0],
          headerElements[0].bbox[1],
          headerElements[0].bbox[2],
          headerElements[0].bbox[3],
        ]
      )
    : context.textFeatures.headBandRatio > 0.1
      ? ([0, 0, outputWidth, outputHeight * 0.12] as Box)
      : null;

  if (headerBand) {
    guides.push(
      createGuideLine({
        layerId: "header-footer-bands",
        axis: "y",
        position: headerBand[1],
        kind: "major",
        role: "header-band",
        source: "auto",
        confidence: 0.6,
        label: "Header",
      }),
      createGuideLine({
        layerId: "header-footer-bands",
        axis: "y",
        position: headerBand[3],
        kind: "major",
        role: "header-band",
        source: "auto",
        confidence: 0.6,
        label: "Header",
      })
    );
  }

  const footerBand = footerElements.length
    ? footerElements.reduce<Box>(
        (acc, element) => [
          Math.min(acc[0], element.bbox[0]),
          Math.min(acc[1], element.bbox[1]),
          Math.max(acc[2], element.bbox[2]),
          Math.max(acc[3], element.bbox[3]),
        ],
        [
          footerElements[0].bbox[0],
          footerElements[0].bbox[1],
          footerElements[0].bbox[2],
          footerElements[0].bbox[3],
        ]
      )
    : context.textFeatures.footerBandRatio > 0.1
      ? ([0, outputHeight * 0.88, outputWidth, outputHeight] as Box)
      : null;

  if (footerBand) {
    guides.push(
      createGuideLine({
        layerId: "header-footer-bands",
        axis: "y",
        position: footerBand[1],
        kind: "major",
        role: "footer-band",
        source: "auto",
        confidence: 0.6,
        label: "Footer",
      }),
      createGuideLine({
        layerId: "header-footer-bands",
        axis: "y",
        position: footerBand[3],
        kind: "major",
        role: "footer-band",
        source: "auto",
        confidence: 0.6,
        label: "Footer",
      })
    );
  }

  if (guides.length === 0) return null;
  return { id: "header-footer-bands", guides: sortGuides(guides) };
};

const buildOrnamentAnchorsLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const ornaments = context.elements.filter((el) => el.type === "ornament");
  if (ornaments.length === 0) return null;
  const guides: GuideLine[] = [];
  ornaments.forEach((ornament) => {
    const centerX = (ornament.bbox[0] + ornament.bbox[2]) / 2;
    const centerY = (ornament.bbox[1] + ornament.bbox[3]) / 2;
    guides.push(
      createGuideLine({
        layerId: "ornament-anchors",
        axis: "x",
        position: centerX,
        kind: "major",
        role: "ornament",
        source: "auto",
        confidence: ornament.confidence,
      }),
      createGuideLine({
        layerId: "ornament-anchors",
        axis: "y",
        position: centerY,
        kind: "major",
        role: "ornament",
        source: "auto",
        confidence: ornament.confidence,
      })
    );
  });

  return { id: "ornament-anchors", guides: sortGuides(guides) };
};

const buildDiagnosticGuidesLayer = (context: GuideLayoutContext): GuideLayerData | null => {
  const guides: GuideLine[] = [];

  if (context.maskBoxOut) {
    const [x0, y0, x1, y1] = context.maskBoxOut;
    guides.push(
      createGuideLine({
        layerId: "diagnostic-guides",
        axis: "x",
        position: x0,
        kind: "major",
        role: "diagnostic",
        source: "auto",
        confidence: 0.4,
        label: "Mask",
      }),
      createGuideLine({
        layerId: "diagnostic-guides",
        axis: "x",
        position: x1,
        kind: "major",
        role: "diagnostic",
        source: "auto",
        confidence: 0.4,
        label: "Mask",
      }),
      createGuideLine({
        layerId: "diagnostic-guides",
        axis: "y",
        position: y0,
        kind: "major",
        role: "diagnostic",
        source: "auto",
        confidence: 0.4,
        label: "Mask",
      }),
      createGuideLine({
        layerId: "diagnostic-guides",
        axis: "y",
        position: y1,
        kind: "major",
        role: "diagnostic",
        source: "auto",
        confidence: 0.4,
        label: "Mask",
      })
    );
  }

  const peaks = context.baselinePeaks ?? [];
  const allowPeaks = context.baselineGrid?.snapToPeaks ?? true;
  if (allowPeaks && peaks.length > 0) {
    const unique = new Set<string>();
    peaks.forEach((peak) => {
      if (!isFiniteNumber(peak)) return;
      const normalized = clamp(peak, 0, 1);
      const position = normalized * context.outputHeight;
      const key = roundPosition(position).toString();
      if (unique.has(key)) return;
      unique.add(key);
      guides.push(
        createGuideLine({
          layerId: "diagnostic-guides",
          axis: "y",
          position,
          kind: "minor",
          role: "diagnostic",
          source: "auto",
          confidence: context.baselineGrid?.confidence,
        })
      );
    });
  }

  if (guides.length === 0) return null;
  return { id: "diagnostic-guides", guides: sortGuides(guides) };
};

export const createGuideLayout = (context: GuideLayoutContext): GuideLayout => {
  const layers: GuideLayerData[] = [];
  const baselineLayer = buildBaselineGridLayer(context);
  if (baselineLayer) layers.push(baselineLayer);

  const marginLayer = buildMarginGuidesLayer(context);
  if (marginLayer) layers.push(marginLayer);
  const columnLayer = buildColumnGuidesLayer(context);
  if (columnLayer) layers.push(columnLayer);

  const gutterLayer = buildGutterBandsLayer(context);
  if (gutterLayer) layers.push(gutterLayer);

  const headerFooterLayer = buildHeaderFooterBandsLayer(context);
  if (headerFooterLayer) layers.push(headerFooterLayer);

  const ornamentLayer = buildOrnamentAnchorsLayer(context);
  if (ornamentLayer) layers.push(ornamentLayer);

  const diagnosticLayer = buildDiagnosticGuidesLayer(context);
  if (diagnosticLayer) layers.push(diagnosticLayer);

  return { layers: layers.filter((layer): layer is GuideLayerData => Boolean(layer)) };
};

export type { GuideLayoutContext };
