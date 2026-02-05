import type { GuideLayout, GuideLine, GuideOverrides } from "../../ipc/contracts.js";

type GuideLayer = GuideLayout["layers"][number];

type ApplyGuideOverridesParams = {
  guideLayout?: GuideLayout;
  overrides?: GuideOverrides | null;
  canvasWidth: number;
  canvasHeight: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const roundPosition = (value: number): number => Number(value.toFixed(1));

const buildGuideId = (
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
  label?: string;
}): GuideLine => ({
  id: buildGuideId(params.layerId, params.axis, params.kind, params.position),
  axis: params.axis,
  position: roundPosition(params.position),
  kind: params.kind,
  role: params.role,
  source: "user",
  confidence: 1,
  label: params.label,
});

const sortGuides = (guides: GuideLine[]): GuideLine[] =>
  guides
    .slice()
    .sort((a, b) => (a.axis === b.axis ? a.position - b.position : a.axis.localeCompare(b.axis)));

const getLayer = (layout: GuideLayout | undefined, id: string): GuideLayer | undefined =>
  layout?.layers?.find((layer) => layer.id === id);

const extractPositions = (layer: GuideLayer | undefined, axis: "x" | "y"): number[] => {
  if (!layer?.guides) return [];
  return layer.guides
    .filter((guide) => guide.axis === axis)
    .map((guide) => guide.position)
    .sort((a, b) => a - b);
};

const inferSpacing = (positions: number[]): number | null => {
  if (positions.length < 2) return null;
  const deltas = positions.slice(1).map((pos, idx) => pos - positions[idx]);
  const positive = deltas.filter((delta) => delta > 0).sort((a, b) => a - b);
  if (positive.length === 0) return null;
  return positive[Math.floor(positive.length / 2)] ?? null;
};

const buildBaselineGridLayer = (params: {
  spacingPx?: number | null;
  offsetPx?: number | null;
  canvasHeight: number;
  fallbackLayer?: GuideLayer | undefined;
}): GuideLayer | null => {
  const spacing =
    isFiniteNumber(params.spacingPx) && params.spacingPx > 0
      ? params.spacingPx
      : inferSpacing(extractPositions(params.fallbackLayer, "y"));
  if (!spacing) return null;
  if (params.spacingPx === null) return null;
  const offset = isFiniteNumber(params.offsetPx) ? params.offsetPx : 0;
  const guides: GuideLine[] = [];
  const majorStride = Math.max(1, Math.round(24 / spacing));
  let position = offset;
  while (position < 0) position += spacing;
  let index = 0;
  while (position <= params.canvasHeight) {
    const kind = index % majorStride === 0 ? "major" : "minor";
    guides.push(
      createGuideLine({
        layerId: "baseline-grid",
        axis: "y",
        position,
        kind,
        role: "baseline",
      })
    );
    position += spacing;
    index += 1;
  }
  return { id: "baseline-grid", guides: sortGuides(guides) };
};

const applyMarginOverrides = (params: {
  layer?: GuideLayer;
  overrides?: GuideOverrides;
}): GuideLayer | null => {
  const marginOverrides = params.overrides?.margins;
  if (!marginOverrides && params.layer) return params.layer;
  const existingX = extractPositions(params.layer, "x");
  const existingY = extractPositions(params.layer, "y");

  const left =
    marginOverrides?.leftPx === null
      ? null
      : isFiniteNumber(marginOverrides?.leftPx)
        ? marginOverrides.leftPx
        : existingX[0];
  const right =
    marginOverrides?.rightPx === null
      ? null
      : isFiniteNumber(marginOverrides?.rightPx)
        ? marginOverrides.rightPx
        : existingX[existingX.length - 1];
  const top =
    marginOverrides?.topPx === null
      ? null
      : isFiniteNumber(marginOverrides?.topPx)
        ? marginOverrides.topPx
        : existingY[0];
  const bottom =
    marginOverrides?.bottomPx === null
      ? null
      : isFiniteNumber(marginOverrides?.bottomPx)
        ? marginOverrides.bottomPx
        : existingY[existingY.length - 1];

  const guides: GuideLine[] = [];
  if (isFiniteNumber(left))
    guides.push(
      createGuideLine({
        layerId: "margin-guides",
        axis: "x",
        position: left,
        kind: "major",
        role: "margin",
        label: "Margin L",
      })
    );
  if (isFiniteNumber(right))
    guides.push(
      createGuideLine({
        layerId: "margin-guides",
        axis: "x",
        position: right,
        kind: "major",
        role: "margin",
        label: "Margin R",
      })
    );
  if (isFiniteNumber(top))
    guides.push(
      createGuideLine({
        layerId: "margin-guides",
        axis: "y",
        position: top,
        kind: "major",
        role: "margin",
        label: "Margin T",
      })
    );
  if (isFiniteNumber(bottom))
    guides.push(
      createGuideLine({
        layerId: "margin-guides",
        axis: "y",
        position: bottom,
        kind: "major",
        role: "margin",
        label: "Margin B",
      })
    );

  if (guides.length === 0) return null;
  return { id: "margin-guides", guides: sortGuides(guides) };
};

const applyColumnOverrides = (params: {
  layer?: GuideLayer;
  overrides?: GuideOverrides;
}): GuideLayer | null => {
  const columnOverrides = params.overrides?.columns;
  if (!columnOverrides && params.layer) return params.layer;
  if (columnOverrides?.count !== undefined && (columnOverrides.count ?? 0) <= 1) return null;
  const existingX = extractPositions(params.layer, "x");
  const left =
    columnOverrides?.leftPx === null
      ? null
      : isFiniteNumber(columnOverrides?.leftPx)
        ? columnOverrides.leftPx
        : existingX[0];
  const rightFromOverride =
    columnOverrides?.rightPx === null
      ? null
      : isFiniteNumber(columnOverrides?.rightPx)
        ? columnOverrides.rightPx
        : null;
  const rightFromGutter =
    isFiniteNumber(columnOverrides?.gutterPx) && isFiniteNumber(left)
      ? left + columnOverrides.gutterPx
      : null;
  const right = rightFromOverride ?? rightFromGutter ?? existingX[existingX.length - 1] ?? null;

  const guides: GuideLine[] = [];
  if (isFiniteNumber(left))
    guides.push(
      createGuideLine({
        layerId: "column-guides",
        axis: "x",
        position: left,
        kind: "major",
        role: "column",
        label: "Column",
      })
    );
  if (isFiniteNumber(right))
    guides.push(
      createGuideLine({
        layerId: "column-guides",
        axis: "x",
        position: right,
        kind: "major",
        role: "column",
        label: "Column",
      })
    );
  if (guides.length === 0) return null;
  return { id: "column-guides", guides: sortGuides(guides) };
};

const applyBandOverrides = (params: {
  layer?: GuideLayer;
  layerId: "header-footer-bands" | "gutter-bands";
  axis: "x" | "y";
  role: GuideLine["role"];
  override?: { startPx?: number | null; endPx?: number | null };
  label: string;
}): GuideLayer | null => {
  const override = params.override;
  const existing = extractPositions(params.layer, params.axis);
  if (!override && params.layer) return params.layer;

  const start =
    override?.startPx === null
      ? null
      : isFiniteNumber(override?.startPx)
        ? override.startPx
        : existing[0];
  const end =
    override?.endPx === null
      ? null
      : isFiniteNumber(override?.endPx)
        ? override.endPx
        : existing[existing.length - 1];

  const guides: GuideLine[] = [];
  if (isFiniteNumber(start)) {
    guides.push(
      createGuideLine({
        layerId: params.layerId,
        axis: params.axis,
        position: start,
        kind: "major",
        role: params.role,
        label: params.label,
      })
    );
  }
  if (isFiniteNumber(end)) {
    guides.push(
      createGuideLine({
        layerId: params.layerId,
        axis: params.axis,
        position: end,
        kind: "major",
        role: params.role,
        label: params.label,
      })
    );
  }

  if (guides.length === 0) return null;
  return { id: params.layerId, guides: sortGuides(guides) };
};

export const applyGuideOverrides = (params: ApplyGuideOverridesParams): GuideLayout | undefined => {
  const { guideLayout, overrides, canvasWidth, canvasHeight } = params;
  void canvasWidth;
  if (!guideLayout && !overrides) return guideLayout;
  const layers: GuideLayer[] = [];

  const baselineLayer = buildBaselineGridLayer({
    spacingPx: overrides?.baselineGrid?.spacingPx,
    offsetPx: overrides?.baselineGrid?.offsetPx,
    canvasHeight,
    fallbackLayer: getLayer(guideLayout, "baseline-grid"),
  });
  if (baselineLayer) layers.push(baselineLayer);

  const marginLayer = applyMarginOverrides({
    layer: getLayer(guideLayout, "margin-guides"),
    overrides: overrides ?? undefined,
  });
  if (marginLayer) layers.push(marginLayer);

  const columnLayer = applyColumnOverrides({
    layer: getLayer(guideLayout, "column-guides"),
    overrides: overrides ?? undefined,
  });
  if (columnLayer) layers.push(columnLayer);

  const gutterLayer = applyBandOverrides({
    layer: getLayer(guideLayout, "gutter-bands"),
    layerId: "gutter-bands",
    axis: "x",
    role: "gutter",
    override: overrides?.gutterBand,
    label: "Gutter",
  });
  if (gutterLayer) layers.push(gutterLayer);

  const headerLayer = applyBandOverrides({
    layer: getLayer(guideLayout, "header-footer-bands"),
    layerId: "header-footer-bands",
    axis: "y",
    role: "header-band",
    override: overrides?.headerBand,
    label: "Header",
  });
  const footerLayer = applyBandOverrides({
    layer: headerLayer ?? getLayer(guideLayout, "header-footer-bands"),
    layerId: "header-footer-bands",
    axis: "y",
    role: "footer-band",
    override: overrides?.footerBand,
    label: "Footer",
  });
  const headerFooterGuides =
    footerLayer?.guides && headerLayer?.guides
      ? {
          id: "header-footer-bands",
          guides: sortGuides([...headerLayer.guides, ...footerLayer.guides]),
        }
      : (footerLayer ?? headerLayer);
  if (headerFooterGuides) layers.push(headerFooterGuides);

  // Preserve other layers if no overrides touched them
  const passthrough = guideLayout?.layers?.filter(
    (layer) => !layers.some((existing) => existing.id === layer.id)
  );
  if (passthrough?.length) layers.push(...passthrough);

  return { layers };
};
