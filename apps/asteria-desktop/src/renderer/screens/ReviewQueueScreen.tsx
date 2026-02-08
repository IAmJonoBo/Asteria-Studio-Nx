import type { JSX, KeyboardEvent, MouseEvent, WheelEvent, RefObject, PointerEvent } from "react";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcut.js";
import type {
  LayoutProfile,
  ReviewQueue,
  PageLayoutSidecar,
  PageTemplate,
  GuideLayout,
  GuideOverrides,
  GuideLine,
} from "../../ipc/contracts.js";
import type { GuideGroup } from "../guides/registry.js";
import {
  getDefaultGuideLayerVisibility,
  guideLayerRegistry,
  renderGuideLayers,
} from "../guides/registry.js";
import { applyGuideOverrides } from "../guides/overrides.js";
import { snapBoxWithSources, getBoxSnapCandidates } from "../utils/snapping.js";
import type { SnapEdge, SnapSourceConfig } from "../utils/snapping.js";
import { unwrapIpcResult } from "../utils/ipc.js";
import { Icon } from "../components/Icon.js";

type PreviewRef = {
  path: string;
  width: number;
  height: number;
};

interface ReviewPage {
  id: string;
  filename: string;
  layoutProfile: LayoutProfile;
  reason: string;
  confidence: number;
  previews: {
    source?: PreviewRef;
    normalized?: PreviewRef;
    overlay?: PreviewRef;
  };
  issues: string[];
}

type TemplateScope = "page" | "section" | "template";

const APPLY_SCOPE_LABELS: Record<TemplateScope, string> = {
  page: "This page",
  section: "Section",
  template: "Template",
};

const GUIDE_GROUP_LABELS: Record<GuideGroup, string> = {
  structural: "Structural",
  detected: "Detected",
  diagnostic: "Diagnostic",
};

const GUIDE_GROUP_ORDER: GuideGroup[] = ["structural", "detected", "diagnostic"];

const GUIDE_LAYER_LABELS: Record<string, string> = {
  "baseline-grid": "Baseline grid",
  rulers: "Rulers",
  "margin-guides": "Margins",
  "column-guides": "Columns",
  "gutter-bands": "Gutter bands",
  "header-footer-bands": "Header/footer",
  "ornament-anchors": "Ornament anchors",
  "detected-guides": "Detected guides",
  "diagnostic-guides": "Diagnostic",
};

const resolveGuideLayerLabel = (layerId: string): string =>
  GUIDE_LAYER_LABELS[layerId] ??
  layerId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

type TemplateSummary = {
  id: string;
  label: string;
  pages: ReviewPage[];
  averageConfidence: number;
  minConfidence: number;
  issueSummary: Array<{ issue: string; count: number }>;
  guideCoverage: number;
};

interface ReviewQueueScreenProps {
  runId?: string;
  runDir?: string;
}

type DecisionValue = "accept" | "flag" | "reject";
type SetState<T> = (value: T | ((prev: T) => T)) => void;

type ReviewWorker = {
  postMessage: (message: { pages?: ReviewPage[] }) => void;
  terminate: () => void;
  onmessage: ((event: { data?: { pages?: ReviewPage[] } }) => void) | null;
};

const mapReviewQueue = (queue: ReviewQueue): ReviewPage[] => {
  return queue.items.map((item) => {
    const issues = item.qualityGate?.reasons ?? [];
    const reason = item.reason === "quality-gate" ? "Quality gate" : "Semantic layout";
    const source = item.previews?.find((entry) => entry.kind === "source");
    const normalized = item.previews?.find((entry) => entry.kind === "normalized");
    const overlay = item.previews?.find((entry) => entry.kind === "overlay");
    return {
      id: item.pageId,
      filename: item.filename,
      layoutProfile: item.layoutProfile,
      reason,
      confidence: item.layoutConfidence,
      previews: {
        source: source
          ? { path: source.path, width: source.width, height: source.height }
          : undefined,
        normalized: normalized
          ? { path: normalized.path, width: normalized.width, height: normalized.height }
          : undefined,
        overlay: overlay
          ? { path: overlay.path, width: overlay.width, height: overlay.height }
          : undefined,
      },
      issues,
    };
  });
};

const LAYOUT_PROFILE_LABEL_OVERRIDES: Partial<Record<LayoutProfile, string>> = {
  // Example: override for profiles that need special title casing
  // "front-matter": "Front Matter",
};

const formatLayoutProfileLabel = (profile: LayoutProfile): string => {
  const override = LAYOUT_PROFILE_LABEL_OVERRIDES[profile];
  if (override) {
    return override;
  }

  return profile
    .split(/[-\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
};

/**
 * Helper to append a new error message to an existing error string.
 */
const appendError = (existing: string | null, newMessage: string): string => {
  const currentError = existing ?? "";
  const separator = currentError ? "; " : "";
  return `${currentError}${separator}${newMessage}`;
};

const getTemplateKey = (page?: ReviewPage): LayoutProfile => {
  if (!page) {
    // Fallback for unexpected undefined page; keep a distinct bucket.
    return "unknown" as LayoutProfile;
  }

  if (!page.layoutProfile) {
    // Group pages without a layout profile by their reason to avoid
    // collapsing all such pages into a single "unknown" bucket.
    const normalizedReason =
      page.reason?.trim().toLowerCase().replaceAll(/\s+/g, "-") || "no-reason";
    return `unknown-${normalizedReason}` as LayoutProfile;
  }

  return page.layoutProfile;
};

const buildTemplateSummaries = (pages: ReviewPage[]): TemplateSummary[] => {
  const groups = new Map<LayoutProfile, ReviewPage[]>();
  pages.forEach((page) => {
    const key = getTemplateKey(page);
    const group = groups.get(key);
    if (group) {
      group.push(page);
    } else {
      groups.set(key, [page]);
    }
  });

  const summaries: TemplateSummary[] = [];
  groups.forEach((groupPages, key) => {
    const totalConfidence = groupPages.reduce((sum, page) => sum + page.confidence, 0);
    const minConfidence =
      groupPages.length > 0
        ? groupPages.reduce((min, page) => Math.min(min, page.confidence), Number.POSITIVE_INFINITY)
        : 0;
    const issueCounts = new Map<string, number>();
    groupPages.forEach((page) => {
      page.issues.forEach((issue) => {
        issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
      });
    });
    const issueSummary = Array.from(issueCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([issue, count]) => ({ issue, count }));
    const guideCount = groupPages.filter((page) => Boolean(page.previews.overlay)).length;
    summaries.push({
      id: key,
      label: formatLayoutProfileLabel(key),
      pages: groupPages,
      averageConfidence: groupPages.length > 0 ? totalConfidence / groupPages.length : 0,
      minConfidence,
      issueSummary,
      guideCoverage: groupPages.length > 0 ? guideCount / groupPages.length : 0,
    });
  });
  return summaries.sort((a, b) => b.pages.length - a.pages.length);
};

const getRepresentativePages = (summary: TemplateSummary): ReviewPage[] => {
  const pages = [...summary.pages].sort((a, b) => a.confidence - b.confidence);
  const count = pages.length;

  if (count <= 3) {
    return pages;
  }

  const lowIndex = 0;
  const highIndex = count - 1;
  const medianIndex = Math.floor((count - 1) / 2);

  return [pages[lowIndex], pages[medianIndex], pages[highIndex]];
};

const getTemplatePages = (pages: ReviewPage[], templateKey: LayoutProfile): ReviewPage[] =>
  pages.filter((page) => getTemplateKey(page) === templateKey);

/**
 * Returns a contiguous block of pages with the same template as the page at the given index.
 * Assumes pages in the review queue maintain document order; if pages are filtered, sorted,
 * or reordered in the UI, this logic may produce unexpected results.
 */
const getSectionPages = (pages: ReviewPage[], index: number): ReviewPage[] => {
  if (!pages[index]) return [];
  const templateKey = getTemplateKey(pages[index]);
  let start = index;
  let end = index;
  while (start > 0 && getTemplateKey(pages[start - 1]) === templateKey) {
    start -= 1;
  }
  while (end < pages.length - 1 && getTemplateKey(pages[end + 1]) === templateKey) {
    end += 1;
  }
  return pages.slice(start, end + 1);
};

type ReasonInfo = {
  label: string;
  explanation: string;
  severity: "info" | "warn" | "critical";
  action: string;
};

type OverlayLayersState = {
  pageBounds: boolean;
  cropBox: boolean;
  trimBox: boolean;
  pageMask: boolean;
  textBlocks: boolean;
  titles: boolean;
  runningHeads: boolean;
  folios: boolean;
  ornaments: boolean;
};

type OverlayLayerKey = keyof OverlayLayersState;

type GuideGroupVisibility = Record<GuideGroup, boolean>;
type GuideGroupOpacities = Record<GuideGroup, number>;

type Box = [number, number, number, number];

type AdjustmentMode = "crop" | "trim" | null;

type BaselineGridOverrides = {
  spacingPx: number | null;
  offsetPx: number | null;
  angleDeg: number | null;
  snapToPeaks: boolean;
  markCorrect: boolean;
};

type OverlayHandleEdge =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

type OverlayHandle = {
  boxType: "crop" | "trim";
  edge: OverlayHandleEdge;
};

/**
 * Helper for type-safe IPC channel access.
 * Returns undefined if the IPC bridge is not available or the channel doesn't exist.
 */
const getIpcChannel = <TArgs extends unknown[], TReturn>(
  channelName: string
):
  | ((...args: TArgs) => Promise<import("../../ipc/contracts.js").IpcResult<TReturn>>)
  | undefined => {
  const windowRef = globalThis as typeof globalThis & {
    asteria?: {
      ipc?: {
        [key: string]: (...args: unknown[]) => Promise<unknown>;
      };
    };
  };
  const channel = windowRef.asteria?.ipc?.[channelName];
  if (!channel) return undefined;
  return channel as (
    ...args: TArgs
  ) => Promise<import("../../ipc/contracts.js").IpcResult<TReturn>>;
};

type SnapGuideLine = {
  axis: "x" | "y";
  value: number;
  edge: "left" | "right" | "top" | "bottom";
  label?: string;
};

const handleSnapEdges: Record<OverlayHandleEdge, SnapEdge[]> = {
  left: ["left"],
  right: ["right"],
  top: ["top"],
  bottom: ["bottom"],
  "top-left": ["top", "left"],
  "top-right": ["top", "right"],
  "bottom-left": ["bottom", "left"],
  "bottom-right": ["bottom", "right"],
};

const getDecisionBadgeClass = (decisionValue: DecisionValue): string => {
  if (decisionValue === "accept") return "badge-success";
  if (decisionValue === "flag") return "badge-warning";
  return "badge-error";
};

const getConfidenceColor = (confidence: number): string => {
  if (confidence < 0.5) return "var(--color-error)";
  if (confidence < 0.7) return "var(--color-warning)";
  return "var(--color-success)";
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const toOptionalNumber = (value: number | null): number | undefined =>
  value === null ? undefined : value;

const buildBaselineGridOverrides = (
  sidecar: PageLayoutSidecar | null | undefined
): BaselineGridOverrides => {
  const overrides = sidecar?.overrides;
  const guides =
    overrides && typeof overrides === "object" && "guides" in overrides
      ? (overrides.guides as Record<string, unknown> | null)
      : null;
  const baselineGrid =
    guides && typeof guides === "object" && "baselineGrid" in guides
      ? (guides.baselineGrid as Record<string, unknown> | null)
      : null;

  const overrideSpacing =
    baselineGrid && isFiniteNumber(baselineGrid.spacingPx) ? baselineGrid.spacingPx : null;
  const overrideOffset =
    baselineGrid && isFiniteNumber(baselineGrid.offsetPx) ? baselineGrid.offsetPx : null;
  const overrideAngle =
    baselineGrid && isFiniteNumber(baselineGrid.angleDeg) ? baselineGrid.angleDeg : null;
  const overrideSnap =
    baselineGrid && typeof baselineGrid.snapToPeaks === "boolean" ? baselineGrid.snapToPeaks : null;
  const overrideCorrect =
    baselineGrid && typeof baselineGrid.markCorrect === "boolean" ? baselineGrid.markCorrect : null;

  const autoSpacing =
    sidecar?.bookModel?.baselineGrid?.dominantSpacingPx ??
    sidecar?.metrics?.baseline?.medianSpacingPx ??
    null;

  return {
    spacingPx: overrideSpacing ?? (isFiniteNumber(autoSpacing) ? autoSpacing : null),
    offsetPx: overrideOffset,
    angleDeg: overrideAngle,
    snapToPeaks: overrideSnap ?? true,
    markCorrect: overrideCorrect ?? false,
  };
};

const areBaselineGridOverridesEqual = (
  current: BaselineGridOverrides,
  baseline: BaselineGridOverrides | null
): boolean => {
  if (!baseline) return false;
  return (
    current.spacingPx === baseline.spacingPx &&
    current.offsetPx === baseline.offsetPx &&
    current.angleDeg === baseline.angleDeg &&
    current.snapToPeaks === baseline.snapToPeaks &&
    current.markCorrect === baseline.markCorrect
  );
};

const resolvePreviewSrc = (preview?: PreviewRef): string | undefined => {
  if (!preview?.path) return undefined;
  if (preview.path.startsWith("/")) return `file://${preview.path}`;
  return preview.path;
};

const createToggleSelected =
  (setSelectedIds: SetState<Set<string>>) =>
  (pageId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }
      return next;
    });
  };

const createApplyDecisionToSelection =
  (selectedIds: Set<string>, setDecisions: SetState<Map<string, DecisionValue>>) =>
  (decisionValue: DecisionValue): void => {
    if (selectedIds.size === 0) return;
    setDecisions((prev) => {
      const next = new Map(prev);
      selectedIds.forEach((id) => {
        next.set(id, decisionValue);
      });
      return next;
    });
  };

const createAcceptSameReason =
  (
    currentPage: ReviewPage | undefined,
    queuePages: ReviewPage[],
    setDecisions: SetState<Map<string, DecisionValue>>
  ) =>
  (): void => {
    if (!currentPage) return;
    const reason = currentPage.reason;
    setDecisions((prev) => {
      const next = new Map(prev);
      queuePages.forEach((page) => {
        if (page.reason === reason) {
          next.set(page.id, "accept");
        }
      });
      return next;
    });
  };

const createResetView =
  (setZoom: SetState<number>, setPan: SetState<{ x: number; y: number }>) => (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

const createZoomBy =
  (setZoom: SetState<number>) =>
  (delta: number): void => {
    setZoom((prev) => Math.min(4, Math.max(0.5, Number((prev + delta).toFixed(2)))));
  };

const clampBox = (box: Box, bounds: Box, minSize = 12): Box => {
  const [minX, minY, maxX, maxY] = bounds;
  let [x0, y0, x1, y1] = box;

  // Ensure coordinates are ordered
  if (x0 > x1) {
    [x0, x1] = [x1, x0];
  }
  if (y0 > y1) {
    [y0, y1] = [y1, y0];
  }

  // First, clamp each edge independently to the bounds
  x0 = Math.max(minX, Math.min(x0, maxX));
  x1 = Math.max(minX, Math.min(x1, maxX));
  y0 = Math.max(minY, Math.min(y0, maxY));
  y1 = Math.max(minY, Math.min(y1, maxY));

  const width = x1 - x0;
  const height = y1 - y0;

  // Enforce minimum width without re-centering, preferring to grow to the right
  if (width < minSize) {
    const needed = minSize - width;
    if (x1 + needed <= maxX) {
      x1 += needed;
    } else if (x0 - needed >= minX) {
      x0 -= needed;
    } else {
      // Bounds smaller than minSize, fill available width
      x0 = minX;
      x1 = maxX;
    }
  }

  // Enforce minimum height without re-centering, preferring to grow downward
  if (height < minSize) {
    const needed = minSize - height;
    if (y1 + needed <= maxY) {
      y1 += needed;
    } else if (y0 - needed >= minY) {
      y0 -= needed;
    } else {
      // Bounds smaller than minSize, fill available height
      y0 = minY;
      y1 = maxY;
    }
  }

  return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
};

const calculateOverlayScale = (
  currentSidecar: PageLayoutSidecar | null | undefined,
  currentNormalizedPreview: PreviewRef | null | undefined
): { x: number; y: number } | null => {
  if (!currentNormalizedPreview) return null;

  const outputWidth = currentSidecar?.normalization?.cropBox
    ? currentSidecar.normalization.cropBox[2] + 1
    : currentNormalizedPreview.width;
  const outputHeight = currentSidecar?.normalization?.cropBox
    ? currentSidecar.normalization.cropBox[3] + 1
    : currentNormalizedPreview.height;

  return {
    x: outputWidth > 0 ? currentNormalizedPreview.width / outputWidth : 1,
    y: outputHeight > 0 ? currentNormalizedPreview.height / outputHeight : 1,
  };
};

const mapClientPointToOutput = (params: {
  clientX: number;
  clientY: number;
  rect: { left: number; top: number; width: number; height: number };
  normalizedWidth: number;
  normalizedHeight: number;
  scaleX: number;
  scaleY: number;
}): { x: number; y: number } | null => {
  const { clientX, clientY, rect, normalizedWidth, normalizedHeight, scaleX, scaleY } = params;
  if (!rect.width || !rect.height || !scaleX || !scaleY) return null;
  const rawX = ((clientX - rect.left) / rect.width) * normalizedWidth;
  const rawY = ((clientY - rect.top) / rect.height) * normalizedHeight;
  return { x: rawX / scaleX, y: rawY / scaleY };
};

type GuideHit = {
  guideId: string;
  layerId: string;
  axis: "x" | "y";
  role?: GuideLine["role"];
  position: number;
};

const clampGuidePosition = (
  value: number,
  axis: "x" | "y",
  bounds: { w: number; h: number }
): number => Math.max(0, Math.min(value, axis === "x" ? bounds.w : bounds.h));

const hitTestGuides = (params: {
  point: { x: number; y: number };
  guideLayout?: GuideLayout;
  zoom: number;
}): GuideHit | null => {
  const { point, guideLayout, zoom } = params;
  if (!guideLayout?.layers) return null;
  const editableLayerIds = new Set([
    "baseline-grid",
    "margin-guides",
    "column-guides",
    "header-footer-bands",
    "gutter-bands",
  ]);
  const tolerance = Math.max(3, 6 / Math.max(0.5, zoom));
  let best: { hit: GuideHit; distance: number } | null = null;
  for (const layer of guideLayout.layers) {
    if (!editableLayerIds.has(layer.id)) continue;
    for (const guide of layer.guides) {
      if (layer.id === "baseline-grid" && guide.kind === "minor") continue;
      const distance =
        guide.axis === "x"
          ? Math.abs(point.x - guide.position)
          : Math.abs(point.y - guide.position);
      if (distance > tolerance) continue;
      if (!best || distance < best.distance) {
        best = {
          hit: {
            guideId: guide.id,
            layerId: layer.id,
            axis: guide.axis,
            role: guide.role,
            position: guide.position,
          },
          distance,
        };
      }
    }
  }
  return best?.hit ?? null;
};

const getLayerGuidePositions = (params: {
  guideLayout?: GuideLayout;
  layerId: string;
  axis: "x" | "y";
  role?: GuideLine["role"];
}): number[] => {
  const { guideLayout, layerId, axis, role } = params;
  const layer = guideLayout?.layers?.find((entry) => entry.id === layerId);
  if (!layer) return [];
  return layer.guides
    .filter((guide) => guide.axis === axis && (role ? guide.role === role : true))
    .map((guide) => guide.position)
    .sort((a, b) => a - b);
};

const snapBoxToPrior = (prior: Box, box: Box, threshold: number): Box => {
  const [priorLeft, priorTop, priorRight, priorBottom] = prior;
  const [left, top, right, bottom] = box;
  if (Math.abs(left - priorLeft) > threshold || Math.abs(top - priorTop) > threshold) {
    return prior;
  }

  const snappedRight = Math.abs(right - priorRight) <= threshold ? right : priorRight;
  const snappedBottom = Math.abs(bottom - priorBottom) <= threshold ? bottom : priorBottom;

  return [left, top, snappedRight, snappedBottom];
};

const applyHandleDrag = (
  box: Box,
  handle: OverlayHandleEdge,
  deltaX: number,
  deltaY: number
): Box => {
  const [x0, y0, x1, y1] = box;
  switch (handle) {
    case "left":
      return [x0 + deltaX, y0, x1, y1];
    case "right":
      return [x0, y0, x1 + deltaX, y1];
    case "top":
      return [x0, y0 + deltaY, x1, y1];
    case "bottom":
      return [x0, y0, x1, y1 + deltaY];
    case "top-left":
      return [x0 + deltaX, y0 + deltaY, x1, y1];
    case "top-right":
      return [x0, y0 + deltaY, x1 + deltaX, y1];
    case "bottom-left":
      return [x0 + deltaX, y0, x1, y1 + deltaY];
    case "bottom-right":
      return [x0, y0, x1 + deltaX, y1 + deltaY];
    default:
      return box;
  }
};

type SnapGuidesState = {
  guides: Array<{
    axis: "x" | "y";
    value: number;
    edge: "left" | "right" | "top" | "bottom";
    label?: string;
  }>;
  active: boolean;
  tooltip: string | null;
};

const isSameBox = (a: Box | null, b: Box | null): boolean => {
  if (!a || !b) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
};

const hasGuideOverrides = (overrides: GuideOverrides): boolean => {
  const entries = Object.entries(overrides) as Array<[string, unknown]>;
  for (const [, value] of entries) {
    if (value === undefined) continue;
    if (value && typeof value === "object") {
      if (Object.values(value as Record<string, unknown>).some((entry) => entry !== undefined)) {
        return true;
      }
    } else {
      return true;
    }
  }
  return false;
};

export const __testables = {
  applyHandleDrag,
  calculateOverlayScale,
  clampBox,
  hitTestGuides,
  mapClientPointToOutput,
  snapBoxToPrior,
};

const buildTrimBoxFromCrop = (cropBox: Box | null, trimMm?: number, dpi?: number): Box | null => {
  if (!cropBox || trimMm === undefined || trimMm === null || !dpi) return null;
  const trimPx = (trimMm / 25.4) * dpi;
  const width = cropBox[2] - cropBox[0];
  const height = cropBox[3] - cropBox[1];
  const maxTrimPx = Math.min(width, height) / 2;
  const usedTrimPx = Math.min(trimPx, maxTrimPx);
  return [
    cropBox[0] + usedTrimPx,
    cropBox[1] + usedTrimPx,
    cropBox[2] - usedTrimPx,
    cropBox[3] - usedTrimPx,
  ];
};

const formatSnapTooltip = (guides: SnapGuideLine[]): string | null => {
  if (guides.length === 0) return null;
  const labels = Array.from(new Set(guides.map((guide) => guide.label).filter(Boolean)));
  if (labels.length === 0) return "Snapped";
  return `Snapped: ${labels.join(", ")}`;
};

const createDecisionHandler =
  (
    decisionValue: DecisionValue,
    params: {
      currentPage: ReviewPage | undefined;
      queueLength: number;
      selectedIndex: number;
      setSelectedIndex: SetState<number>;
      setDecisions: SetState<Map<string, DecisionValue>>;
    }
  ) =>
  (): void => {
    const page = params.currentPage;
    if (!page) return;
    params.setDecisions((prev) => new Map(prev).set(page.id, decisionValue));
    if (params.selectedIndex < params.queueLength - 1) {
      params.setSelectedIndex(params.selectedIndex + 1);
    }
  };

const createUndoHandler =
  (
    currentPage: ReviewPage | undefined,
    decisions: Map<string, DecisionValue>,
    setDecisions: SetState<Map<string, DecisionValue>>
  ) =>
  (): void => {
    if (!currentPage || !decisions.has(currentPage.id)) return;
    const newDecisions = new Map(decisions);
    newDecisions.delete(currentPage.id);
    setDecisions(newDecisions);
  };

const createViewerMouseDown =
  (
    setIsPanning: SetState<boolean>,
    panOriginRef: { current: { x: number; y: number } | null },
    pan: { x: number; y: number }
  ) =>
  (event: MouseEvent<globalThis.HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    setIsPanning(true);
    panOriginRef.current = {
      x: event.clientX - pan.x,
      y: event.clientY - pan.y,
    };
  };

const createViewerMouseMove =
  (
    isPanning: boolean,
    panOriginRef: { current: { x: number; y: number } | null },
    setPan: SetState<{ x: number; y: number }>
  ) =>
  (event: MouseEvent<globalThis.HTMLButtonElement>): void => {
    if (!isPanning || !panOriginRef.current) return;
    setPan({
      x: event.clientX - panOriginRef.current.x,
      y: event.clientY - panOriginRef.current.y,
    });
  };

const createViewerMouseUp =
  (setIsPanning: SetState<boolean>, panOriginRef: { current: { x: number; y: number } | null }) =>
  (): void => {
    setIsPanning(false);
    panOriginRef.current = null;
  };

const createViewerWheel =
  (zoomBy: (delta: number) => void) =>
  (event: WheelEvent<globalThis.HTMLButtonElement>): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
  };

const createViewerKeyDown =
  (
    zoomBy: (delta: number) => void,
    resetView: () => void,
    setPan: SetState<{ x: number; y: number }>
  ) =>
  (event: KeyboardEvent<globalThis.HTMLButtonElement>): void => {
    if (event.key === "+") {
      event.preventDefault();
      zoomBy(0.1);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(-0.1);
    } else if (event.key === "0") {
      event.preventDefault();
      resetView();
    } else if (event.shiftKey && event.key === "ArrowUp") {
      event.preventDefault();
      setPan((prev) => ({ x: prev.x, y: prev.y + 24 }));
    } else if (event.shiftKey && event.key === "ArrowDown") {
      event.preventDefault();
      setPan((prev) => ({ x: prev.x, y: prev.y - 24 }));
    } else if (event.shiftKey && event.key === "ArrowLeft") {
      event.preventDefault();
      setPan((prev) => ({ x: prev.x + 24, y: prev.y }));
    } else if (event.shiftKey && event.key === "ArrowRight") {
      event.preventDefault();
      setPan((prev) => ({ x: prev.x - 24, y: prev.y }));
    }
  };

const REASON_DICTIONARY: Record<string, ReasonInfo> = {
  "low-mask-coverage": {
    label: "Page edges unclear",
    explanation: "Detected content mask is too small; edges may be cropped or missed.",
    severity: "critical",
    action: "Review crop and padding; reprocess with relaxed mask threshold.",
  },
  "mask-coverage-drop": {
    label: "Mask coverage drop",
    explanation: "Mask coverage is significantly below the book median.",
    severity: "warn",
    action: "Compare with adjacent pages and adjust crop if needed.",
  },
  "low-skew-confidence": {
    label: "Low deskew confidence",
    explanation: "Deskew alignment is uncertain; text baselines may be tilted.",
    severity: "warn",
    action: "Verify rotation or re-run with stronger deskew.",
  },
  "shadow-heavy": {
    label: "Shadow detected",
    explanation: "Strong spine/edge shadow may obscure content.",
    severity: "warn",
    action: "Accept if acceptable or reprocess with shading correction.",
  },
  "noisy-background": {
    label: "Noisy background",
    explanation: "Background variance is high; may affect layout detection.",
    severity: "info",
    action: "Check scan quality or apply denoise/preprocess.",
  },
  "shading-residual-worse": {
    label: "Shading correction regressed",
    explanation: "Shading correction increased residual error.",
    severity: "warn",
    action: "Review shading output; consider disabling shading for this page.",
  },
  "low-shading-confidence": {
    label: "Low shading confidence",
    explanation: "Shading model confidence is below threshold.",
    severity: "info",
    action: "Review shading overlay and decide if acceptable.",
  },
  "book-head-missing": {
    label: "Running head missing",
    explanation: "Expected running head area is not covered by the page mask.",
    severity: "warn",
    action: "Check crop bounds against book priors.",
  },
  "book-folio-missing": {
    label: "Folio missing",
    explanation: "Expected folio band is not covered by the page mask.",
    severity: "warn",
    action: "Verify crop and folio placement.",
  },
  "book-ornament-missing": {
    label: "Ornament missing",
    explanation: "Expected ornament region is not covered by the page mask.",
    severity: "info",
    action: "Review crop; accept if ornament is intentionally missing.",
  },
  "spread-split-low-confidence": {
    label: "Spread split uncertain",
    explanation: "Gutter detection was uncertain for a possible spread.",
    severity: "warn",
    action: "Confirm if this page is a spread before splitting.",
  },
  "potential-baseline-misalignment": {
    label: "Baseline alignment risk",
    explanation: "Skew confidence is low and background noise is high.",
    severity: "warn",
    action: "Review alignment and consider manual correction.",
  },
  "low-baseline-consistency": {
    label: "Baseline consistency low",
    explanation: "Detected baselines are inconsistent across the page.",
    severity: "info",
    action: "Inspect layout or multi-column structure.",
  },
};

const getReasonInfo = (code: string): ReasonInfo => {
  if (code.startsWith("residual-skew-")) {
    return {
      label: "Residual skew",
      explanation: `Residual skew detected (${code.replace("residual-skew-", "")}).`,
      severity: "warn",
      action: "Verify rotation or re-run deskew refinement.",
    };
  }
  return (
    REASON_DICTIONARY[code] ?? {
      label: code,
      explanation: "No additional description available.",
      severity: "info",
      action: "Review manually.",
    }
  );
};

const ITEM_HEIGHT = 86;
const OVERSCAN = 6;

const useReviewQueuePages = (runId?: string, runDir?: string): ReviewPage[] => {
  const [pages, setPages] = useState<ReviewPage[]>([]);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadQueue = async (): Promise<void> => {
      const windowRef: typeof globalThis & {
        asteria?: {
          ipc?: {
            [key: string]: (
              runId: string,
              runDir: string
            ) => Promise<import("../../ipc/contracts.js").IpcResult<ReviewQueue>>;
          };
        };
      } = globalThis;
      if (!runId || !runDir || !windowRef.asteria?.ipc) {
        if (!cancelled) setPages([]);
        return;
      }
      try {
        const queueResult = await windowRef.asteria.ipc["asteria:fetch-review-queue"](
          runId,
          runDir
        );
        if (cancelled) return;
        setPages(mapReviewQueue(unwrapIpcResult(queueResult, "Fetch review queue")));
      } catch {
        if (!cancelled) setPages([]);
      }
    };
    loadQueue();
    return (): void => {
      cancelled = true;
    };
  }, [runDir, runId]);

  return pages;
};

const useQueueWorker = (pages: ReviewPage[]): ReviewPage[] => {
  const [workerPages, setWorkerPages] = useState<ReviewPage[] | null>(null);
  const workerRef = useRef<ReviewWorker | null>(null);

  useEffect((): void | (() => void) => {
    const WorkerCtor = globalThis.Worker;
    if (!WorkerCtor) {
      return;
    }
    const UrlCtor = globalThis.URL;
    if (!UrlCtor) {
      return;
    }
    const worker = new WorkerCtor(new UrlCtor("../workers/reviewQueueWorker.ts", import.meta.url), {
      type: "module",
    });
    const reviewWorker: ReviewWorker = {
      postMessage: (message): void => worker.postMessage(message),
      terminate: (): void => worker.terminate(),
      onmessage: null,
    };
    worker.onmessage = (event: { data?: { pages?: ReviewPage[] } }): void => {
      setWorkerPages(event.data?.pages ?? []);
      reviewWorker.onmessage?.(event);
    };
    workerRef.current = reviewWorker;
    return (): void => {
      reviewWorker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect((): void => {
    const worker = workerRef.current;
    if (!worker) return;
    worker.postMessage({ pages });
  }, [pages]);

  return workerPages ?? pages;
};

const useQueueSelection = (
  queuePages: ReviewPage[]
): { selectedIndex: number; setSelectedIndex: SetState<number> } => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const clampedIndex = queuePages.length === 0 ? 0 : Math.min(selectedIndex, queuePages.length - 1);

  return { selectedIndex: clampedIndex, setSelectedIndex };
};

const useQueueViewport = (
  selectedIndex: number
): {
  listRef: RefObject<globalThis.HTMLDivElement | null>;
  scrollTop: number;
  setScrollTop: SetState<number>;
  viewportHeight: number;
} => {
  const listRef = useRef<globalThis.HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect((): void | (() => void) => {
    const container = listRef.current;
    if (!container) return;
    const ResizeObserverCtor = globalThis.ResizeObserver;
    if (!ResizeObserverCtor) {
      setViewportHeight(container.clientHeight);
      return;
    }
    const resizeObserver = new ResizeObserverCtor((): void => {
      setViewportHeight(container.clientHeight);
    });
    resizeObserver.observe(container);
    setViewportHeight(container.clientHeight);
    return (): void => resizeObserver.disconnect();
  }, []);

  useEffect((): void => {
    const container = listRef.current;
    if (!container) return;
    const top = selectedIndex * ITEM_HEIGHT;
    const bottom = top + ITEM_HEIGHT;
    if (top < container.scrollTop) {
      container.scrollTop = top;
    } else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight;
    }
  }, [selectedIndex]);

  return { listRef, scrollTop, setScrollTop, viewportHeight };
};

const useSidecarData = (
  runId: string | undefined,
  runDir: string | undefined,
  currentPage: ReviewPage | undefined
): { sidecar: PageLayoutSidecar | null; sidecarError: string | null } => {
  const [sidecar, setSidecar] = useState<PageLayoutSidecar | null>(null);
  const [sidecarError, setSidecarError] = useState<string | null>(null);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadSidecar = async (): Promise<void> => {
      if (!currentPage) {
        setSidecar(null);
        setSidecarError(null);
        return;
      }
      const windowRef: typeof globalThis & {
        asteria?: {
          ipc?: {
            [key: string]: (
              runId: string,
              runDir: string,
              pageId: string
            ) => Promise<import("../../ipc/contracts.js").IpcResult<PageLayoutSidecar | null>>;
          };
        };
      } = globalThis;
      if (!runId || !runDir || !windowRef.asteria?.ipc) {
        setSidecar(null);
        setSidecarError(null);
        return;
      }
      try {
        const sidecarResult = await windowRef.asteria.ipc["asteria:fetch-sidecar"](
          runId,
          runDir,
          currentPage.id
        );
        if (cancelled) return;
        if (!sidecarResult.ok) {
          setSidecarError(sidecarResult.error.message);
          setSidecar(null);
          return;
        }
        setSidecar(sidecarResult.value ?? null);
        setSidecarError(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load sidecar";
        setSidecarError(message);
        setSidecar(null);
      }
    };
    void loadSidecar();
    return (): void => {
      cancelled = true;
    };
  }, [currentPage, runDir, runId]);

  return { sidecar, sidecarError };
};

type OverlayRenderParams = {
  sidecar: PageLayoutSidecar | null;
  normalizedPreview?: PreviewRef;
  overlaysVisible: boolean;
  overlayLayers: OverlayLayersState;
  guideLayerVisibility: Record<string, boolean>;
  guideGroupVisibility: GuideGroupVisibility;
  guideGroupOpacities: GuideGroupOpacities;
  soloGuideGroup: GuideGroup | null;
  guideLayout?: GuideLayout;
  overlayScaleX: number;
  overlayScaleY: number;
  zoom: number;
  cropBox: Box | null;
  trimBox: Box | null;
  adjustmentMode: AdjustmentMode;
  snapGuides: SnapGuideLine[];
  showSnapGuides: boolean;
  snapTooltip: string | null;
  overlaySvgRef: RefObject<globalThis.SVGSVGElement | null>;
  onHandlePointerDown: (
    event: PointerEvent<globalThis.SVGCircleElement>,
    handle: OverlayHandle
  ) => void;
  onGuidePointerDown: (event: PointerEvent<globalThis.SVGSVGElement>) => void;
  activeGuideId?: string;
};

const buildOverlaySvg = ({
  sidecar,
  normalizedPreview,
  overlaysVisible,
  overlayLayers,
  guideLayerVisibility,
  guideGroupVisibility,
  guideGroupOpacities,
  soloGuideGroup,
  guideLayout,
  overlayScaleX,
  overlayScaleY,
  zoom,
  cropBox,
  trimBox,
  adjustmentMode,
  snapGuides,
  showSnapGuides,
  snapTooltip,
  overlaySvgRef,
  onHandlePointerDown,
  onGuidePointerDown,
  activeGuideId,
}: OverlayRenderParams): JSX.Element | null => {
  if (!sidecar || !normalizedPreview || !overlaysVisible) return null;

  const scaleBox = (box: [number, number, number, number]): [number, number, number, number] => [
    box[0] * overlayScaleX,
    box[1] * overlayScaleY,
    box[2] * overlayScaleX,
    box[3] * overlayScaleY,
  ];

  const elements = sidecar.elements ?? [];
  const elementColorMap: Record<string, string> = {
    page_bounds: "rgba(59, 130, 246, 0.8)",
    text_block: "rgba(245, 158, 11, 0.8)",
    title: "rgba(236, 72, 153, 0.8)",
    running_head: "rgba(236, 72, 153, 0.8)",
    folio: "rgba(14, 165, 233, 0.8)",
    ornament: "rgba(168, 85, 247, 0.8)",
  };

  const shouldRenderElement = (type: string): boolean => {
    if (type === "page_bounds") return overlayLayers.pageBounds;
    if (type === "text_block") return overlayLayers.textBlocks;
    if (type === "title") return overlayLayers.titles;
    if (type === "running_head") return overlayLayers.runningHeads;
    if (type === "folio") return overlayLayers.folios;
    if (type === "ornament") return overlayLayers.ornaments;
    return false;
  };

  const pageMask = sidecar.normalization?.pageMask;
  const handleSize = 6;
  const handles: Array<{ key: string; x: number; y: number; edge: OverlayHandleEdge }> = [];
  let activeBox: Box | null = null;
  if (adjustmentMode === "crop") {
    activeBox = cropBox;
  } else if (adjustmentMode === "trim") {
    activeBox = trimBox;
  }
  if (activeBox) {
    const [x0, y0, x1, y1] = activeBox;
    const midX = (x0 + x1) / 2;
    const midY = (y0 + y1) / 2;
    handles.push(
      { key: "top-left", x: x0, y: y0, edge: "top-left" },
      { key: "top-right", x: x1, y: y0, edge: "top-right" },
      { key: "bottom-left", x: x0, y: y1, edge: "bottom-left" },
      { key: "bottom-right", x: x1, y: y1, edge: "bottom-right" },
      { key: "top", x: midX, y: y0, edge: "top" },
      { key: "bottom", x: midX, y: y1, edge: "bottom" },
      { key: "left", x: x0, y: midY, edge: "left" },
      { key: "right", x: x1, y: midY, edge: "right" }
    );
  }

  return (
    <svg
      aria-hidden="true"
      ref={overlaySvgRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      viewBox={`0 0 ${normalizedPreview.width} ${normalizedPreview.height}`}
      onPointerDown={onGuidePointerDown}
    >
      {showSnapGuides &&
        snapGuides.map((guide, index) => {
          const isVertical = guide.axis === "x";
          const scaledValue = guide.value * (isVertical ? overlayScaleX : overlayScaleY);
          const glowId = `snap-glow-${index}`;
          return (
            <g key={`${guide.axis}-${guide.value}-${guide.edge}-${index}`} pointerEvents="none">
              <defs>
                <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              {isVertical ? (
                <>
                  <line
                    x1={scaledValue}
                    x2={scaledValue}
                    y1={0}
                    y2={normalizedPreview.height}
                    stroke="var(--snap-glow)"
                    strokeWidth={6}
                    filter={`url(#${glowId})`}
                  />
                  <line
                    x1={scaledValue}
                    x2={scaledValue}
                    y1={0}
                    y2={normalizedPreview.height}
                    stroke="var(--snap-line)"
                    strokeWidth={2}
                  />
                </>
              ) : (
                <>
                  <line
                    x1={0}
                    x2={normalizedPreview.width}
                    y1={scaledValue}
                    y2={scaledValue}
                    stroke="var(--snap-glow)"
                    strokeWidth={6}
                    filter={`url(#${glowId})`}
                  />
                  <line
                    x1={0}
                    x2={normalizedPreview.width}
                    y1={scaledValue}
                    y2={scaledValue}
                    stroke="var(--snap-line)"
                    strokeWidth={2}
                  />
                </>
              )}
            </g>
          );
        })}
      {showSnapGuides && snapTooltip && (
        <g pointerEvents="none">
          <rect
            x={12}
            y={12}
            width={Math.min(320, snapTooltip.length * 7 + 24)}
            height={30}
            rx={8}
            fill="rgba(15, 23, 42, 0.85)"
            stroke="rgba(148, 163, 184, 0.7)"
          />
          <text x={24} y={32} fill="white" fontSize={12} fontFamily="var(--font-body)">
            {snapTooltip}
          </text>
        </g>
      )}
      {renderGuideLayers({
        guideLayout: guideLayout ?? sidecar.guides,
        zoom,
        canvasWidth: normalizedPreview.width,
        canvasHeight: normalizedPreview.height,
        visibleLayers: guideLayerVisibility,
        groupVisibility: guideGroupVisibility,
        groupOpacities: guideGroupOpacities,
        soloGroup: soloGuideGroup,
        activeGuideId,
      })}
      {overlayLayers.cropBox && cropBox && (
        <rect
          x={cropBox[0] * overlayScaleX}
          y={cropBox[1] * overlayScaleY}
          width={(cropBox[2] - cropBox[0]) * overlayScaleX}
          height={(cropBox[3] - cropBox[1]) * overlayScaleY}
          fill="none"
          stroke="rgba(34, 197, 94, 0.9)"
          strokeWidth={2}
          pointerEvents="none"
        />
      )}
      {overlayLayers.trimBox && trimBox && (
        <rect
          x={trimBox[0] * overlayScaleX}
          y={trimBox[1] * overlayScaleY}
          width={(trimBox[2] - trimBox[0]) * overlayScaleX}
          height={(trimBox[3] - trimBox[1]) * overlayScaleY}
          fill="none"
          stroke="rgba(14, 165, 233, 0.85)"
          strokeWidth={2}
          strokeDasharray="6 4"
          pointerEvents="none"
        />
      )}
      {overlayLayers.pageMask && pageMask && (
        <rect
          x={pageMask[0] * overlayScaleX}
          y={pageMask[1] * overlayScaleY}
          width={(pageMask[2] - pageMask[0]) * overlayScaleX}
          height={(pageMask[3] - pageMask[1]) * overlayScaleY}
          fill="none"
          stroke="rgba(14, 165, 233, 0.6)"
          strokeWidth={2}
          pointerEvents="none"
        />
      )}
      {elements
        .filter((element) => shouldRenderElement(element.type))
        .map((element) => {
          const [x0, y0, x1, y1] = scaleBox(element.bbox);
          const color = elementColorMap[element.type] ?? "rgba(99, 102, 241, 0.8)";
          return (
            <rect
              key={`${element.id}-${element.type}`}
              x={x0}
              y={y0}
              width={Math.max(1, x1 - x0)}
              height={Math.max(1, y1 - y0)}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              pointerEvents="none"
            />
          );
        })}
      {activeBox &&
        handles.map((handle) => {
          const boxType = adjustmentMode === "trim" ? "trim" : "crop";
          const edgeLabel = handle.edge
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
          return (
            <circle
              key={`${adjustmentMode}-${handle.key}`}
              cx={handle.x * overlayScaleX}
              cy={handle.y * overlayScaleY}
              r={handleSize}
              fill="var(--bg-primary)"
              stroke="var(--text-primary)"
              strokeWidth={1.5}
              style={{ cursor: "grab" }}
              aria-label={`Drag to adjust ${edgeLabel.toLowerCase()} edge of ${boxType} box`}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => {
                event.stopPropagation();
                onHandlePointerDown(event, {
                  boxType: adjustmentMode === "trim" ? "trim" : "crop",
                  edge: handle.edge,
                });
              }}
            />
          );
        })}
    </svg>
  );
};

type ReviewQueueLayoutProps = {
  runId?: string;
  queuePages: ReviewPage[];
  currentPage: ReviewPage | undefined;
  selectedIndex: number;
  decisions: Map<string, DecisionValue>;
  overlaysVisible: boolean;
  showSourcePreview: boolean;
  zoom: number;
  rotationDeg: number;
  overlayLayers: OverlayLayersState;
  guideLayerVisibility: Record<string, boolean>;
  guidesVisible: boolean;
  guideGroupVisibility: GuideGroupVisibility;
  guideGroupOpacities: GuideGroupOpacities;
  soloGuideGroup: GuideGroup | null;
  snappingEnabled: boolean;
  selectedIds: Set<string>;
  listRef: RefObject<globalThis.HTMLDivElement | null>;
  scrollTop: number;
  viewportHeight: number;
  pan: { x: number; y: number };
  isPanning: boolean;
  sidecarError: string | null;
  normalizedSrc?: string;
  sourceSrc?: string;
  overlaySvg: JSX.Element | null;
  isSubmitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
  adjustmentMode: AdjustmentMode;
  baselineSpacingPx: number | null;
  baselineOffsetPx: number | null;
  baselineAngleDeg: number | null;
  baselineSnapToPeaks: boolean;
  baselineMarkCorrect: boolean;
  setBaselineSpacingPx: (value: number | null) => void;
  setBaselineOffsetPx: (value: number | null) => void;
  setBaselineAngleDeg: (value: number | null) => void;
  setBaselineSnapToPeaks: (value: boolean) => void;
  setBaselineMarkCorrect: (value: boolean) => void;
  cropBox: Box | null;
  trimBox: Box | null;
  isApplyingOverride: boolean;
  overrideError: string | null;
  lastOverrideAppliedAt: string | null;
  applyScope: TemplateScope;
  applyTargetCount: number;
  templateSummary: TemplateSummary | null;
  representativePages: ReviewPage[];
  templateClusters: PageTemplate[];
  currentTemplateCluster: PageTemplate | null;
  templateAssignmentId?: string;
  templateAssignmentConfidence?: number;
  selectedTemplateClusterId: string | null;
  setSelectedTemplateClusterId: (value: string | null) => void;
  handleTemplateClusterAction: (action: "confirm" | "correct") => Promise<void>;
  isTemplateActionPending: boolean;
  templateActionStatus: string | null;
  templateActionError: string | null;
  onApplyScopeChange: (scope: TemplateScope) => void;
  onSelectIndex: (index: number) => void;
  onScroll: (scrollTop: number) => void;
  onToggleSelected: (pageId: string) => void;
  onToggleOverlays: () => void;
  onToggleSource: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetView: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onMicroRotateLeft: () => void;
  onMicroRotateRight: () => void;
  onResetRotation: () => void;
  onSetAdjustmentMode: (mode: AdjustmentMode) => void;
  onResetAdjustments: () => void;
  onApplyOverride: () => void;
  onViewerMouseDown: (event: MouseEvent<globalThis.HTMLButtonElement>) => void;
  onViewerMouseMove: (event: MouseEvent<globalThis.HTMLButtonElement>) => void;
  onViewerMouseUp: () => void;
  onViewerWheel: (event: WheelEvent<globalThis.HTMLButtonElement>) => void;
  onViewerKeyDown: (event: KeyboardEvent<globalThis.HTMLButtonElement>) => void;
  onApplyDecisionToSelection: (decision: DecisionValue) => void;
  onAcceptSameReason: () => void;
  onToggleOverlayLayer: (layerKey: OverlayLayerKey, checked: boolean) => void;
  onToggleGuideGroup: (group: GuideGroup, checked: boolean, event: { altKey?: boolean }) => void;
  onGuideGroupOpacityChange: (group: GuideGroup, opacity: number) => void;
  onToggleGuideLayer: (layerId: string, checked: boolean) => void;
  onResetGuideVisibility: () => void;
  onToggleGuidesVisible: () => void;
  onToggleSnapping: () => void;
  onAccept: () => void;
  onFlag: () => void;
  onReject: () => void;
  onUndo: () => void;
  onSubmit: () => void;
};

const ReviewQueueLayout = ({
  runId,
  queuePages,
  currentPage,
  selectedIndex,
  decisions,
  overlaysVisible,
  showSourcePreview,
  zoom,
  rotationDeg,
  overlayLayers,
  guideLayerVisibility,
  guidesVisible,
  guideGroupVisibility,
  guideGroupOpacities,
  soloGuideGroup,
  snappingEnabled,
  selectedIds,
  listRef,
  scrollTop,
  viewportHeight,
  pan,
  isPanning,
  sidecarError,
  normalizedSrc,
  sourceSrc,
  overlaySvg,
  isSubmitting,
  submitError,
  canSubmit,
  adjustmentMode,
  baselineSpacingPx,
  baselineOffsetPx,
  baselineAngleDeg,
  baselineSnapToPeaks,
  baselineMarkCorrect,
  setBaselineSpacingPx,
  setBaselineOffsetPx,
  setBaselineAngleDeg,
  setBaselineSnapToPeaks,
  setBaselineMarkCorrect,
  cropBox: _cropBox,
  trimBox: _trimBox,
  isApplyingOverride,
  overrideError,
  lastOverrideAppliedAt,
  applyScope,
  applyTargetCount,
  templateSummary,
  representativePages,
  templateClusters,
  currentTemplateCluster,
  templateAssignmentId,
  templateAssignmentConfidence,
  selectedTemplateClusterId,
  setSelectedTemplateClusterId,
  handleTemplateClusterAction,
  isTemplateActionPending,
  templateActionStatus,
  templateActionError,
  onApplyScopeChange,
  onSelectIndex,
  onScroll,
  onToggleSelected,
  onToggleOverlays,
  onToggleSource,
  onZoomOut,
  onZoomIn,
  onResetView,
  onRotateLeft,
  onRotateRight,
  onMicroRotateLeft,
  onMicroRotateRight,
  onResetRotation,
  onSetAdjustmentMode,
  onResetAdjustments,
  onApplyOverride,
  onViewerMouseDown,
  onViewerMouseMove,
  onViewerMouseUp,
  onViewerWheel,
  onViewerKeyDown,
  onApplyDecisionToSelection,
  onAcceptSameReason,
  onToggleOverlayLayer,
  onToggleGuideGroup,
  onGuideGroupOpacityChange,
  onToggleGuideLayer,
  onResetGuideVisibility,
  onToggleGuidesVisible,
  onToggleSnapping,
  onAccept,
  onFlag,
  onReject,
  onUndo,
  onSubmit,
}: ReviewQueueLayoutProps): JSX.Element => {
  if (queuePages.length === 0 || !currentPage) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="check" size={48} />
        </div>
        <h2 className="empty-state-title">No pages need review</h2>
        <p className="empty-state-description">
          All pages passed quality checks. Review pages appear here when confidence scores fall
          below thresholds or when manual verification is needed.
        </p>
      </div>
    );
  }

  const decision = decisions.get(currentPage.id);
  const selectedCount = selectedIds.size;
  const totalHeight = queuePages.length * ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    queuePages.length - 1,
    Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + OVERSCAN
  );
  const visiblePages = queuePages.slice(startIndex, endIndex + 1);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Page list sidebar */}
      <div
        style={{
          width: "300px",
          borderRight: "1px solid var(--border)",
          background: "var(--bg-surface)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 600 }}>Review Queue</h2>
          <p style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
            {queuePages.length} pages need attention
          </p>
        </div>

        <div
          ref={listRef}
          style={{ flex: 1, overflow: "auto", position: "relative" }}
          onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            {visiblePages.map((page, offset) => {
              const index = startIndex + offset;
              const pageDecision = decisions.get(page.id);
              const isSelected = selectedIds.has(page.id);
              return (
                <button
                  key={page.id}
                  onClick={() => onSelectIndex(index)}
                  style={{
                    width: "100%",
                    position: "absolute",
                    top: index * ITEM_HEIGHT,
                    left: 0,
                    right: 0,
                    height: ITEM_HEIGHT,
                    padding: "12px 16px",
                    border: "none",
                    borderBottom: "1px solid var(--border-subtle)",
                    background: index === selectedIndex ? "var(--bg-surface-hover)" : "transparent",
                    color: "var(--text-primary)",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "background 150ms",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelected(page.id)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${page.filename} for batch actions`}
                    />
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: "4px",
                        }}
                      >
                        <span style={{ fontWeight: 500, fontSize: "13px" }}>{page.filename}</span>
                        {pageDecision && (
                          <span
                            className={`badge ${getDecisionBadgeClass(pageDecision)}`}
                            style={{ fontSize: "10px" }}
                          >
                            {pageDecision}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        {page.reason}
                      </div>
                      <div style={{ marginTop: "4px" }}>
                        <span
                          style={{
                            fontSize: "11px",
                            color: getConfidenceColor(page.confidence),
                          }}
                        >
                          {(page.confidence * 100).toFixed(0)}% confidence
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main review area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Toolbar */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-primary)",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>{currentPage.filename}</h3>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--text-secondary)" }}>
              Page {selectedIndex + 1} of {queuePages.length}
            </p>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={onToggleOverlays}
              aria-pressed={overlaysVisible}
            >
              {overlaysVisible ? "Hide" : "Show"} Overlays
              <kbd style={{ marginLeft: "8px" }}>Space</kbd>
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={onToggleSource}
              aria-pressed={showSourcePreview}
              disabled={!sourceSrc}
            >
              {showSourcePreview ? "Hide" : "Show"} Source
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onZoomOut}>
              −
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onZoomIn}>
              +
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onResetView}>
              Reset <kbd>0</kbd>
            </button>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              {Math.round(zoom * 100)}%
            </span>
            <div style={{ width: "1px", background: "var(--border)", margin: "0 4px" }} />
            <button className="btn btn-secondary btn-sm" onClick={onRotateLeft}>
              ⟲ <kbd>[</kbd>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onRotateRight}>
              ⟳ <kbd>]</kbd>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onMicroRotateLeft}>
              −0.1° <kbd>Alt+[</kbd>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onMicroRotateRight}>
              +0.1° <kbd>Alt+]</kbd>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onResetRotation}>
              Reset rotation
            </button>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              {rotationDeg.toFixed(1)}°
            </span>
          </div>
        </div>

        {/* Image viewer */}
        <button
          style={{
            flex: 1,
            background: "var(--bg-surface)",
            position: "relative",
            overflow: "hidden",
            border: "none",
            padding: 0,
            textAlign: "left",
            cursor: isPanning ? "grabbing" : "grab",
          }}
          aria-label="Preview viewer"
          type="button"
          onMouseDown={onViewerMouseDown}
          onMouseMove={onViewerMouseMove}
          onMouseUp={onViewerMouseUp}
          onMouseLeave={onViewerMouseUp}
          onWheel={onViewerWheel}
          onKeyDown={onViewerKeyDown}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                showSourcePreview && sourceSrc ? "minmax(0, 1fr) minmax(0, 1fr)" : "1fr",
              gap: "24px",
              alignItems: "center",
              justifyContent: "center",
              padding: "24px",
              minHeight: "100%",
            }}
          >
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "8px",
                background: "var(--bg-primary)",
                padding: "12px",
                overflow: "hidden",
              }}
            >
              {normalizedSrc ? (
                <div
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotationDeg}deg)`,
                    transformOrigin: "center center",
                    transition: isPanning ? "none" : "transform 120ms",
                    display: "inline-block",
                  }}
                >
                  <div style={{ position: "relative", display: "inline-block" }}>
                    <img
                      src={normalizedSrc}
                      alt={`Normalized preview for ${currentPage.filename}`}
                      style={{ display: "block", maxWidth: "100%", height: "auto" }}
                    />
                    {overlaySvg}
                  </div>
                </div>
              ) : (
                <div style={{ color: "var(--text-secondary)" }}>No normalized preview</div>
              )}
            </div>
            {showSourcePreview && sourceSrc && (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  background: "var(--bg-primary)",
                  padding: "12px",
                }}
              >
                <img
                  src={sourceSrc}
                  alt={`Source preview for ${currentPage.filename}`}
                  style={{ display: "block", maxWidth: "100%", height: "auto" }}
                />
              </div>
            )}
          </div>
          {sidecarError && (
            <output
              style={{
                position: "absolute",
                bottom: "12px",
                right: "12px",
                background: "var(--bg-primary)",
                color: "var(--color-error)",
                border: "1px solid var(--border)",
                padding: "6px 10px",
                fontSize: "11px",
                borderRadius: "6px",
              }}
            >
              {sidecarError}
            </output>
          )}
        </button>

        {/* Action panel */}
        <div
          style={{
            padding: "16px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-primary)",
          }}
        >
          <div style={{ display: "grid", gap: "16px", marginBottom: "12px" }}>
            <div>
              <strong style={{ fontSize: "13px" }}>Why flagged</strong>
              {currentPage.issues.length === 0 ? (
                <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--text-secondary)" }}>
                  No automated issues were recorded for this page.
                </p>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "12px" }}>
                  {currentPage.issues.map((issue) => {
                    const info = getReasonInfo(issue);
                    return (
                      <li key={`${currentPage.id}-${issue}`} style={{ marginBottom: "6px" }}>
                        <div style={{ fontWeight: 600 }}>{info.label}</div>
                        <div style={{ color: "var(--text-secondary)" }}>{info.explanation}</div>
                        <div style={{ color: "var(--text-tertiary)" }}>
                          Recommended: {info.action}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <strong style={{ fontSize: "13px" }}>Overlay layers</strong>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "8px",
                  marginTop: "8px",
                }}
              >
                {[
                  { key: "pageBounds", label: "Page bounds" },
                  { key: "cropBox", label: "Crop box" },
                  { key: "trimBox", label: "Trim box" },
                  { key: "pageMask", label: "Page mask" },
                  { key: "textBlocks", label: "Text blocks" },
                  { key: "titles", label: "Titles" },
                  { key: "runningHeads", label: "Running heads" },
                  { key: "folios", label: "Folios" },
                  { key: "ornaments", label: "Ornaments" },
                ].map((layer) => (
                  <label
                    key={layer.key}
                    style={{ display: "flex", alignItems: "center", gap: "8px" }}
                  >
                    <input
                      type="checkbox"
                      checked={overlayLayers[layer.key as OverlayLayerKey]}
                      onChange={(event) =>
                        onToggleOverlayLayer(layer.key as OverlayLayerKey, event.target.checked)
                      }
                    />
                    <span style={{ fontSize: "12px" }}>{layer.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <strong style={{ fontSize: "13px" }}>Guide groups</strong>
              <div style={{ marginTop: "8px", display: "grid", gap: "10px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="checkbox"
                    checked={guidesVisible}
                    onChange={onToggleGuidesVisible}
                    aria-label="Toggle guides"
                  />
                  <span style={{ fontSize: "12px" }}>Guides enabled</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="checkbox"
                    checked={snappingEnabled}
                    onChange={onToggleSnapping}
                    aria-label="Toggle snapping"
                  />
                  <span style={{ fontSize: "12px" }}>Snapping enabled</span>
                </label>
                {GUIDE_GROUP_ORDER.map((group) => {
                  const opacity = guideGroupOpacities[group];
                  const isChecked = soloGuideGroup
                    ? soloGuideGroup === group
                    : guideGroupVisibility[group];
                  return (
                    <div key={group} style={{ display: "grid", gap: "6px" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(event) => {
                            const nativeEvent = event.nativeEvent as unknown as MouseEvent;
                            onToggleGuideGroup(group, event.target.checked, {
                              altKey: nativeEvent.altKey,
                            });
                          }}
                          aria-label={`${GUIDE_GROUP_LABELS[group]} guide visibility`}
                        />
                        <span style={{ fontSize: "12px" }}>{GUIDE_GROUP_LABELS[group]}</span>
                        {soloGuideGroup === group && (
                          <span style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>
                            Solo
                          </span>
                        )}
                      </label>
                      <label style={{ display: "grid", gap: "4px", fontSize: "11px" }}>
                        <span style={{ color: "var(--text-secondary)" }}>Opacity</span>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={opacity}
                            onChange={(event) =>
                              onGuideGroupOpacityChange(group, Number(event.target.value))
                            }
                            aria-label={`${GUIDE_GROUP_LABELS[group]} guide opacity`}
                          />
                          <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                            {Math.round(opacity * 100)}%
                          </span>
                        </div>
                      </label>
                    </div>
                  );
                })}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: "11px", color: "var(--text-tertiary)" }}>
                Alt-click a group to solo it.
              </p>
              <div style={{ marginTop: "12px" }}>
                <strong style={{ fontSize: "12px" }}>Guide layers</strong>
                <div style={{ marginTop: "8px", display: "grid", gap: "6px" }}>
                  {guideLayerRegistry.map((layer) => (
                    <label key={layer.id} style={{ display: "flex", gap: "8px" }}>
                      <input
                        type="checkbox"
                        checked={guideLayerVisibility[layer.id] ?? layer.defaultVisible}
                        onChange={(event) => onToggleGuideLayer(layer.id, event.target.checked)}
                        aria-label={`${resolveGuideLayerLabel(layer.id)} guide layer`}
                      />
                      <span style={{ fontSize: "12px" }}>{resolveGuideLayerLabel(layer.id)}</span>
                    </label>
                  ))}
                </div>
                <div style={{ marginTop: "8px" }}>
                  <button className="btn btn-secondary btn-sm" onClick={onResetGuideVisibility}>
                    Reset guides visibility
                  </button>
                </div>
              </div>
            </div>

            <div>
              <strong style={{ fontSize: "13px" }}>Batch actions</strong>
              <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  Selected: {selectedCount}
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onApplyDecisionToSelection("accept")}
                  disabled={selectedCount === 0}
                >
                  Accept selected
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onApplyDecisionToSelection("flag")}
                  disabled={selectedCount === 0}
                >
                  Flag selected
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onApplyDecisionToSelection("reject")}
                  disabled={selectedCount === 0}
                >
                  Reject selected
                </button>
                <button className="btn btn-secondary btn-sm" onClick={onAcceptSameReason}>
                  Accept all with same reason
                </button>
                <button className="btn btn-secondary btn-sm" disabled>
                  Reprocess selected (planned)
                </button>
              </div>
            </div>

            <div>
              <strong style={{ fontSize: "13px" }}>Adjustments</strong>
              <div style={{ marginTop: "8px", display: "grid", gap: "8px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  <button
                    className={`btn btn-sm ${adjustmentMode === "crop" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => onSetAdjustmentMode(adjustmentMode === "crop" ? null : "crop")}
                  >
                    Crop handles
                  </button>
                  <button
                    className={`btn btn-sm ${adjustmentMode === "trim" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => onSetAdjustmentMode(adjustmentMode === "trim" ? null : "trim")}
                  >
                    Trim handles
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={onResetAdjustments}>
                    Reset crop/trim
                  </button>
                </div>
                <fieldset
                  style={{ display: "grid", gap: "6px", border: "none", margin: 0, padding: 0 }}
                >
                  <legend style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    Apply override scope
                  </legend>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {(["page", "section", "template"] as TemplateScope[]).map((scope) => (
                      <label
                        key={scope}
                        className={`btn btn-sm ${applyScope === scope ? "btn-primary" : "btn-secondary"}`}
                        style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                      >
                        <input
                          type="radio"
                          name="apply-scope"
                          value={scope}
                          checked={applyScope === scope}
                          onChange={() => onApplyScopeChange(scope)}
                        />
                        {APPLY_SCOPE_LABELS[scope]}
                      </label>
                    ))}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                    Targets: {applyTargetCount} page{applyTargetCount === 1 ? "" : "s"}
                    {applyScope === "template" && templateSummary
                      ? ` in ${templateSummary.label}`
                      : ""}
                    {applyScope === "section" ? " in contiguous block" : ""}
                  </span>
                </fieldset>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}
                >
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={onApplyOverride}
                    disabled={isApplyingOverride}
                  >
                    {isApplyingOverride ? "Applying…" : "Apply override"}
                  </button>
                  {lastOverrideAppliedAt && (
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      Applied {new Date(lastOverrideAppliedAt).toLocaleTimeString()}
                    </span>
                  )}
                  {overrideError && (
                    <span style={{ fontSize: "11px", color: "var(--color-error)" }}>
                      {overrideError}
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Drag the on-canvas handles to nudge crop or trim boxes; edges snap to book priors
                  when close.
                </p>
              </div>
            </div>

            <div>
              <strong style={{ fontSize: "13px" }}>Template inspector</strong>
              <div style={{ marginTop: "8px", display: "grid", gap: "12px" }}>
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    padding: "10px",
                    background: "var(--bg-surface)",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "12px" }}>Template clusters</div>
                  <div style={{ marginTop: "6px", fontSize: "12px" }}>
                    {currentTemplateCluster ? (
                      <span>
                        Assigned cluster: <strong>{currentTemplateCluster.id}</strong> •{" "}
                        {formatLayoutProfileLabel(currentTemplateCluster.pageType)}
                        {templateAssignmentConfidence !== undefined
                          ? ` • ${(templateAssignmentConfidence * 100).toFixed(0)}% confidence`
                          : ""}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>
                        No template cluster assignment found for this page.
                      </span>
                    )}
                  </div>
                  {templateClusters.length > 0 ? (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                        gap: "8px",
                        marginTop: "8px",
                      }}
                    >
                      {templateClusters.map((cluster) => {
                        const isCurrent = currentTemplateCluster?.id === cluster.id;
                        return (
                          <div
                            key={cluster.id}
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: "6px",
                              padding: "8px",
                              background: isCurrent ? "var(--bg-primary)" : "var(--bg-surface)",
                              display: "grid",
                              gap: "4px",
                            }}
                          >
                            <div style={{ fontWeight: 600, fontSize: "12px" }}>
                              {cluster.id}
                              {isCurrent ? " • Current" : ""}
                            </div>
                            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                              {formatLayoutProfileLabel(cluster.pageType)}
                            </div>
                            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                              {cluster.pageIds.length} pages •{" "}
                              {(cluster.confidence * 100).toFixed(0)}% confidence
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div
                      style={{ marginTop: "8px", fontSize: "11px", color: "var(--text-secondary)" }}
                    >
                      No template clusters available in the sidecar.
                    </div>
                  )}
                  <div
                    style={{
                      marginTop: "10px",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleTemplateClusterAction("confirm")}
                      disabled={
                        isTemplateActionPending ||
                        (!currentTemplateCluster && !templateAssignmentId)
                      }
                      aria-label="Confirm template cluster"
                    >
                      {isTemplateActionPending ? "Saving…" : "Confirm cluster"}
                    </button>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "11px",
                      }}
                    >
                      <span>Correct to</span>
                      <select
                        value={selectedTemplateClusterId ?? ""}
                        onChange={(event) => setSelectedTemplateClusterId(event.target.value)}
                        disabled={templateClusters.length === 0}
                        aria-label="Template cluster selection"
                      >
                        <option value="" disabled>
                          Select cluster
                        </option>
                        {templateClusters.map((cluster) => (
                          <option key={cluster.id} value={cluster.id}>
                            {cluster.id} • {formatLayoutProfileLabel(cluster.pageType)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleTemplateClusterAction("correct")}
                      disabled={
                        isTemplateActionPending ||
                        !selectedTemplateClusterId ||
                        templateClusters.length === 0
                      }
                      aria-label="Correct template cluster"
                    >
                      {isTemplateActionPending ? "Saving…" : "Correct assignment"}
                    </button>
                    {templateActionStatus && (
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        {templateActionStatus}
                      </span>
                    )}
                    {templateActionError && (
                      <span style={{ fontSize: "11px", color: "var(--color-error)" }}>
                        {templateActionError}
                      </span>
                    )}
                  </div>
                </div>
                {templateSummary ? (
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Layout template summary
                    </div>
                    <div
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "10px",
                        background: "var(--bg-surface)",
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>
                        {templateSummary.label}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          marginTop: "4px",
                        }}
                      >
                        {templateSummary.pages.length} pages • Avg{" "}
                        {(templateSummary.averageConfidence * 100).toFixed(0)}% confidence • Min{" "}
                        {(templateSummary.minConfidence * 100).toFixed(0)}%
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          marginTop: "4px",
                        }}
                      >
                        Guide coverage: {(templateSummary.guideCoverage * 100).toFixed(0)}%
                      </div>
                      <div style={{ marginTop: "6px", fontSize: "12px" }}>
                        {templateSummary.issueSummary.length === 0 ? (
                          <span style={{ color: "var(--text-secondary)" }}>
                            No recurring issues.
                          </span>
                        ) : (
                          <span>
                            Common issues:{" "}
                            {templateSummary.issueSummary
                              .map((entry) => `${entry.issue} (${entry.count})`)
                              .join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
                    No layout template summary available for this page.
                  </p>
                )}
                <div>
                  <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                    Representative pages (guides overlay)
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(120px, 150px))",
                      gap: "8px",
                    }}
                  >
                    {representativePages.map((page) => {
                      const preview =
                        page.previews.overlay ?? page.previews.normalized ?? page.previews.source;
                      const previewSrc = resolvePreviewSrc(preview);
                      return (
                        <div
                          key={page.id}
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: "6px",
                            padding: "6px",
                            background: "var(--bg-primary)",
                          }}
                        >
                          {previewSrc ? (
                            <img
                              src={previewSrc}
                              alt={`Preview for ${page.filename}`}
                              style={{ display: "block", width: "100%", height: "auto" }}
                            />
                          ) : (
                            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                              No preview
                            </div>
                          )}
                          <div
                            style={{
                              fontSize: "10px",
                              color: "var(--text-tertiary)",
                              marginTop: "4px",
                            }}
                          >
                            {page.filename}
                          </div>
                        </div>
                      );
                    })}
                    {representativePages.length === 0 && (
                      <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        No representative pages available.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <strong style={{ fontSize: "13px" }}>Baseline grid</strong>
              <div style={{ marginTop: "8px", display: "grid", gap: "8px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: "8px",
                  }}
                >
                  <label style={{ display: "grid", gap: "4px", fontSize: "11px" }}>
                    <span>Spacing (px)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={baselineSpacingPx ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        const parsed = Number(value);
                        setBaselineSpacingPx(
                          value === "" || !Number.isFinite(parsed) ? null : parsed
                        );
                      }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "4px", fontSize: "11px" }}>
                    <span>Offset (px)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={baselineOffsetPx ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        const parsed = Number(value);
                        setBaselineOffsetPx(
                          value === "" || !Number.isFinite(parsed) ? null : parsed
                        );
                      }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "4px", fontSize: "11px" }}>
                    <span>Angle (°)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={baselineAngleDeg ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        const parsed = Number(value);
                        setBaselineAngleDeg(
                          value === "" || !Number.isFinite(parsed) ? null : parsed
                        );
                      }}
                    />
                  </label>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <input
                      type="checkbox"
                      checked={baselineSnapToPeaks}
                      onChange={(event) => setBaselineSnapToPeaks(event.target.checked)}
                    />
                    <span style={{ fontSize: "12px" }}>Snap to peaks</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <input
                      type="checkbox"
                      checked={baselineMarkCorrect}
                      onChange={(event) => setBaselineMarkCorrect(event.target.checked)}
                    />
                    <span style={{ fontSize: "12px" }}>Mark correct</span>
                  </label>
                </div>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}
                >
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={onApplyOverride}
                    disabled={isApplyingOverride}
                  >
                    {isApplyingOverride ? "Applying…" : "Apply override"}
                  </button>
                  {lastOverrideAppliedAt && (
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      Applied {new Date(lastOverrideAppliedAt).toLocaleTimeString()}
                    </span>
                  )}
                  {overrideError && (
                    <span style={{ fontSize: "11px", color: "var(--color-error)" }}>
                      {overrideError}
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Tune spacing, offset, and angle for the page baseline grid. Snap-to-peaks aligns
                  to detected line clusters, and mark-correct confirms the guide for training.
                </p>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              className={`btn ${decision === "accept" ? "btn-primary" : "btn-secondary"}`}
              onClick={onAccept}
              aria-label="Accept page (A)"
            >
              Accept <kbd>A</kbd>
            </button>
            <button
              className={`btn ${decision === "flag" ? "btn-primary" : "btn-secondary"}`}
              onClick={onFlag}
              aria-label="Flag for later review (F)"
            >
              Flag <kbd>F</kbd>
            </button>
            <button
              className={`btn ${decision === "reject" ? "btn-primary" : "btn-secondary"}`}
              onClick={onReject}
              aria-label="Reject page (R)"
            >
              Reject <kbd>R</kbd>
            </button>
            <div style={{ flex: 1 }} />
            {decision && (
              <button className="btn btn-ghost" onClick={onUndo} aria-label="Undo decision (U)">
                Undo <kbd>U</kbd>
              </button>
            )}
            <span style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
              <kbd>J</kbd>/<kbd>K</kbd> navigate
            </span>
            <button
              className="btn btn-primary"
              onClick={onSubmit}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              aria-label={
                runId ? "Submit review decisions (Ctrl+Enter)" : "Run ID required to submit"
              }
            >
              {isSubmitting ? "Submitting…" : "Submit Review"}
            </button>
          </div>
        </div>
        {submitError && (
          <div
            role="alert"
            style={{
              padding: "8px 16px",
              background: "var(--bg-surface)",
              color: "var(--color-error)",
              borderBottom: "1px solid var(--border)",
              fontSize: "12px",
            }}
          >
            {submitError}
          </div>
        )}
      </div>
    </div>
  );
};

export function ReviewQueueScreen({
  runId,
  runDir,
}: Readonly<ReviewQueueScreenProps>): JSX.Element {
  const pages = useReviewQueuePages(runId, runDir);
  const queuePages = useQueueWorker(pages);
  const { selectedIndex, setSelectedIndex } = useQueueSelection(queuePages);
  const { listRef, scrollTop, setScrollTop, viewportHeight } = useQueueViewport(selectedIndex);
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [decisions, setDecisions] = useState<Map<string, DecisionValue>>(new Map());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSourcePreview, setShowSourcePreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const currentPage = queuePages[selectedIndex];
  const { sidecar, sidecarError } = useSidecarData(runId, runDir, currentPage);
  const normalizedPreview = currentPage?.previews.normalized;
  const sourcePreview = currentPage?.previews.source;
  const [adjustmentMode, setAdjustmentMode] = useState<AdjustmentMode>(null);
  const [cropBox, setCropBox] = useState<Box | null>(null);
  const [trimBox, setTrimBox] = useState<Box | null>(null);
  const [isApplyingOverride, setIsApplyingOverride] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [lastOverrideAppliedAt, setLastOverrideAppliedAt] = useState<string | null>(null);
  const [applyScope, setApplyScope] = useState<TemplateScope>("page");
  const [baselineSpacingPx, setBaselineSpacingPx] = useState<number | null>(null);
  const [baselineOffsetPx, setBaselineOffsetPx] = useState<number | null>(null);
  const [baselineAngleDeg, setBaselineAngleDeg] = useState<number | null>(null);
  const [baselineSnapToPeaks, setBaselineSnapToPeaks] = useState(true);
  const [baselineMarkCorrect, setBaselineMarkCorrect] = useState(false);
  const [guideOverridesDraft, setGuideOverridesDraft] = useState<GuideOverrides>({});
  const [activeGuideId, setActiveGuideId] = useState<string | undefined>(undefined);
  const overlaySvgRef = useRef<globalThis.SVGSVGElement | null>(null);
  const [snapGuidesState, setSnapGuidesState] = useState<SnapGuidesState>({
    guides: [],
    active: false,
    tooltip: null,
  });
  const [isDraggingHandle, setIsDraggingHandle] = useState(false);
  const [_isDraggingGuide, setIsDraggingGuide] = useState(false);
  const [snapTemporarilyDisabled, setSnapTemporarilyDisabled] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [guidesVisible, setGuidesVisible] = useState(true);
  const resetView = createResetView(setZoom, setPan);
  const guideOverrides =
    sidecar?.overrides && typeof sidecar.overrides === "object" && "guides" in sidecar.overrides
      ? (sidecar.overrides.guides as GuideOverrides | null)
      : null;
  const runtimeGuideOverrides = useMemo((): GuideOverrides => {
    const baselineGrid =
      baselineSpacingPx !== null ||
      baselineOffsetPx !== null ||
      baselineAngleDeg !== null ||
      baselineSnapToPeaks !== undefined ||
      baselineMarkCorrect !== undefined
        ? {
            spacingPx: toOptionalNumber(baselineSpacingPx),
            offsetPx: toOptionalNumber(baselineOffsetPx),
            angleDeg: toOptionalNumber(baselineAngleDeg),
            snapToPeaks: baselineSnapToPeaks,
            markCorrect: baselineMarkCorrect,
          }
        : undefined;
    return {
      ...guideOverridesDraft,
      ...(baselineGrid ? { baselineGrid } : {}),
    };
  }, [
    baselineAngleDeg,
    baselineMarkCorrect,
    baselineOffsetPx,
    baselineSnapToPeaks,
    baselineSpacingPx,
    guideOverridesDraft,
  ]);
  const effectiveGuideLayout = useMemo(
    (): GuideLayout | undefined =>
      applyGuideOverrides({
        guideLayout: sidecar?.guides,
        overrides: runtimeGuideOverrides ?? guideOverrides ?? undefined,
        canvasWidth: normalizedPreview?.width ?? 0,
        canvasHeight: normalizedPreview?.height ?? 0,
      }),
    [
      guideOverrides,
      normalizedPreview?.height,
      normalizedPreview?.width,
      runtimeGuideOverrides,
      sidecar?.guides,
    ]
  );

  useEffect((): void | (() => void) => {
    const listener = (): void => {
      setOverlaysVisible((prev) => !prev);
    };
    globalThis.addEventListener("asteria:toggle-overlays", listener);
    return () => {
      globalThis.removeEventListener("asteria:toggle-overlays", listener);
    };
  }, []);
  useEffect((): void | (() => void) => {
    const toggleGuides = (): void => setGuidesVisible((prev) => !prev);
    const toggleSnapping = (): void => setSnapEnabled((prev) => !prev);
    const resetViewEvent = (): void => resetView();
    const toggleRulers = (): void => {
      setGuideLayerVisibility((prev) => ({
        ...prev,
        rulers: !(prev.rulers ?? true),
      }));
      setGuidesVisible(true);
    };
    globalThis.addEventListener("asteria:toggle-guides", toggleGuides);
    globalThis.addEventListener("asteria:toggle-snapping", toggleSnapping);
    globalThis.addEventListener("asteria:reset-view", resetViewEvent);
    globalThis.addEventListener("asteria:toggle-rulers", toggleRulers);
    return () => {
      globalThis.removeEventListener("asteria:toggle-guides", toggleGuides);
      globalThis.removeEventListener("asteria:toggle-snapping", toggleSnapping);
      globalThis.removeEventListener("asteria:reset-view", resetViewEvent);
      globalThis.removeEventListener("asteria:toggle-rulers", toggleRulers);
    };
  }, [resetView]);
  const dragHandleRef = useRef<{
    handle: OverlayHandle;
    start: { x: number; y: number };
    box: Box;
    target: globalThis.Element;
    pointerId: number;
  } | null>(null);
  const guideDragRef = useRef<{
    hit: GuideHit;
    start: { x: number; y: number };
    baseOffset?: number | null;
  } | null>(null);
  const baselineBoxesRef = useRef<{ crop: Box | null; trim: Box | null }>({
    crop: null,
    trim: null,
  });
  const baselineRotationRef = useRef(0);
  const baselineGuidesRef = useRef<BaselineGridOverrides | null>(null);
  const [overlayLayers, setOverlayLayers] = useState({
    pageBounds: true,
    cropBox: true,
    trimBox: true,
    pageMask: false,
    textBlocks: true,
    titles: true,
    runningHeads: true,
    folios: true,
    ornaments: true,
  });
  const [guideGroupVisibility, setGuideGroupVisibility] = useState<GuideGroupVisibility>({
    structural: true,
    detected: true,
    diagnostic: true,
  });
  const [guideGroupOpacities, setGuideGroupOpacities] = useState<GuideGroupOpacities>({
    structural: 1,
    detected: 1,
    diagnostic: 1,
  });
  const [soloGuideGroup, setSoloGuideGroup] = useState<GuideGroup | null>(null);
  const [guideLayerVisibility, setGuideLayerVisibility] = useState<Record<string, boolean>>(() =>
    getDefaultGuideLayerVisibility()
  );
  const effectiveGuideGroupVisibility = useMemo<GuideGroupVisibility>(() => {
    if (guidesVisible) return guideGroupVisibility;
    return { structural: false, detected: false, diagnostic: false };
  }, [guidesVisible, guideGroupVisibility]);
  const snapSources = useMemo((): SnapSourceConfig[] => {
    const templateCandidates = [
      ...(sidecar?.bookModel?.runningHeadTemplates?.flatMap((template) =>
        getBoxSnapCandidates(
          template.bbox,
          template.confidence ?? 1,
          "Template: running head",
          "templates"
        )
      ) ?? []),
      ...(sidecar?.bookModel?.ornamentLibrary?.flatMap((ornament) =>
        getBoxSnapCandidates(
          ornament.bbox,
          ornament.confidence ?? 1,
          "Template: ornament",
          "templates"
        )
      ) ?? []),
    ];

    const detectedCandidates =
      sidecar?.elements?.flatMap((element) =>
        getBoxSnapCandidates(
          element.bbox,
          element.confidence ?? 1,
          `Detected: ${element.type.replace("_", " ")}`,
          "detected"
        )
      ) ?? [];

    const baselineCandidates = [
      ...(baselineBoxesRef.current.crop
        ? getBoxSnapCandidates(baselineBoxesRef.current.crop, 1, "Baseline: crop", "baseline")
        : []),
      ...(baselineBoxesRef.current.trim
        ? getBoxSnapCandidates(baselineBoxesRef.current.trim, 1, "Baseline: trim", "baseline")
        : []),
    ];

    return [
      {
        id: "templates",
        priority: 4,
        minConfidence: 0.4,
        weight: 1.2,
        radius: 10,
        label: "Templates",
        candidates: templateCandidates,
      },
      {
        id: "detected",
        priority: 3,
        minConfidence: 0.5,
        weight: 1,
        radius: 8,
        label: "Detected elements",
        candidates: detectedCandidates,
      },
      {
        id: "baseline",
        priority: 2,
        minConfidence: 0.1,
        weight: 0.9,
        radius: 12,
        label: "Baseline",
        candidates: baselineCandidates,
      },
      {
        id: "user-guides",
        priority: 5,
        minConfidence: 0,
        weight: 1.5,
        radius: 14,
        label: "User guides",
        candidates: [],
      },
    ];
  }, [sidecar]);

  const templateSummaries = useMemo(() => buildTemplateSummaries(queuePages), [queuePages]);
  const templateKey = getTemplateKey(currentPage);
  const templateSummary = templateSummaries.find((summary) => summary.id === templateKey) ?? null;
  const templatePages = currentPage ? getTemplatePages(queuePages, templateKey) : [];
  const sectionPages = currentPage ? getSectionPages(queuePages, selectedIndex) : [];
  let applyTargets: ReviewPage[] = [];
  if (applyScope === "page") {
    applyTargets = currentPage ? [currentPage] : [];
  } else if (applyScope === "section") {
    applyTargets = sectionPages;
  } else {
    applyTargets = templatePages;
  }
  const applyTargetCount = applyTargets.length;
  const representativePages = templateSummary ? getRepresentativePages(templateSummary) : [];
  const templateClusters = useMemo(() => sidecar?.bookModel?.pageTemplates ?? [], [sidecar]);
  const templateAssignmentId = sidecar?.templateId;
  const templateAssignmentConfidence = sidecar?.templateConfidence;
  const currentTemplateCluster = useMemo(() => {
    if (!currentPage) return null;
    if (templateAssignmentId) {
      return templateClusters.find((template) => template.id === templateAssignmentId) ?? null;
    }
    return templateClusters.find((template) => template.pageIds.includes(currentPage.id)) ?? null;
  }, [currentPage, templateAssignmentId, templateClusters]);
  const [selectedTemplateClusterId, setSelectedTemplateClusterId] = useState<string | null>(null);
  const [templateActionStatus, setTemplateActionStatus] = useState<string | null>(null);
  const [templateActionError, setTemplateActionError] = useState<string | null>(null);
  const [isTemplateActionPending, setIsTemplateActionPending] = useState(false);

  useEffect(() => {
    if (currentTemplateCluster?.id) {
      setSelectedTemplateClusterId(currentTemplateCluster.id);
      return;
    }
    if (templateClusters.length > 0) {
      setSelectedTemplateClusterId(templateClusters[0].id);
      return;
    }
    setSelectedTemplateClusterId(null);
  }, [currentTemplateCluster?.id, templateClusters]);

  const toggleSelected = createToggleSelected(setSelectedIds);
  const applyDecisionToSelection = createApplyDecisionToSelection(selectedIds, setDecisions);
  const acceptSameReason = createAcceptSameReason(currentPage, queuePages, setDecisions);
  const zoomBy = createZoomBy(setZoom);
  const handleAccept = createDecisionHandler("accept", {
    currentPage,
    queueLength: queuePages.length,
    selectedIndex,
    setSelectedIndex,
    setDecisions,
  });
  const handleFlag = createDecisionHandler("flag", {
    currentPage,
    queueLength: queuePages.length,
    selectedIndex,
    setSelectedIndex,
    setDecisions,
  });
  const handleReject = createDecisionHandler("reject", {
    currentPage,
    queueLength: queuePages.length,
    selectedIndex,
    setSelectedIndex,
    setDecisions,
  });
  const handleUndo = createUndoHandler(currentPage, decisions, setDecisions);
  const handleViewerMouseDown = createViewerMouseDown(setIsPanning, panOriginRef, pan);
  const handleViewerMouseMove = createViewerMouseMove(isPanning, panOriginRef, setPan);
  const handleViewerMouseUp = createViewerMouseUp(setIsPanning, panOriginRef);
  const handleViewerWheel = createViewerWheel(zoomBy);
  const handleViewerKeyDown = createViewerKeyDown(zoomBy, resetView, setPan);
  const rotateBy = (delta: number): void => {
    setRotationDeg((prev) => Number((prev + delta).toFixed(1)));
  };
  const resetRotation = (): void => setRotationDeg(0);
  const resetAdjustments = (): void => {
    setCropBox(baselineBoxesRef.current.crop);
    setTrimBox(baselineBoxesRef.current.trim);
    setRotationDeg(baselineRotationRef.current);
    setAdjustmentMode(null);
  };
  const handleGuideGroupToggle = (
    group: GuideGroup,
    checked: boolean,
    event: { altKey?: boolean }
  ): void => {
    if (!guidesVisible && checked) {
      setGuidesVisible(true);
    }
    if (event.altKey) {
      setSoloGuideGroup((prev) => (prev === group ? null : group));
      return;
    }
    if (soloGuideGroup) {
      setSoloGuideGroup(null);
    }
    setGuideGroupVisibility((prev) => ({ ...prev, [group]: checked }));
  };
  const handleGuideGroupOpacityChange = (group: GuideGroup, opacity: number): void => {
    const clamped = Math.max(0, Math.min(1, opacity));
    setGuideGroupOpacities((prev) => ({ ...prev, [group]: clamped }));
  };
  const handleGuideLayerToggle = (layerId: string, checked: boolean): void => {
    if (!guidesVisible && checked) {
      setGuidesVisible(true);
    }
    setGuideLayerVisibility((prev) => ({ ...prev, [layerId]: checked }));
  };
  const handleResetGuideVisibility = (): void => {
    setGuideLayerVisibility(getDefaultGuideLayerVisibility());
    setGuideGroupVisibility({ structural: true, detected: true, diagnostic: true });
    setGuideGroupOpacities({ structural: 1, detected: 1, diagnostic: 1 });
    setSoloGuideGroup(null);
    setGuidesVisible(true);
  };

  useEffect(() => {
    const handleKeyChange = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Control" || event.key === "Meta") {
        setSnapTemporarilyDisabled(event.type === "keydown");
      }
    };
    globalThis.addEventListener?.("keydown", handleKeyChange);
    globalThis.addEventListener?.("keyup", handleKeyChange);
    return (): void => {
      globalThis.removeEventListener?.("keydown", handleKeyChange);
      globalThis.removeEventListener?.("keyup", handleKeyChange);
    };
  }, []);

  const handleSetAdjustmentMode = (mode: AdjustmentMode): void => {
    if (mode === "crop" && !cropBox) {
      // Initialize default crop box if none exists (using full normalized image bounds)
      if (normalizedPreview) {
        const defaultCrop: Box = [0, 0, normalizedPreview.width - 1, normalizedPreview.height - 1];
        setCropBox(defaultCrop);
      }
    } else if (mode === "trim" && !trimBox) {
      // Initialize default trim box if none exists (10% margin from crop box)
      const baseCrop =
        cropBox ||
        (normalizedPreview
          ? [0, 0, normalizedPreview.width - 1, normalizedPreview.height - 1]
          : null);
      if (baseCrop) {
        const width = baseCrop[2] - baseCrop[0];
        const height = baseCrop[3] - baseCrop[1];
        const margin = Math.min(width, height) * 0.1;
        const defaultTrim: Box = [
          baseCrop[0] + margin,
          baseCrop[1] + margin,
          baseCrop[2] - margin,
          baseCrop[3] - margin,
        ];
        setTrimBox(defaultTrim);
        if (!cropBox) {
          setCropBox(baseCrop);
        }
      }
    }
    setAdjustmentMode(mode);
  };

  useEffect(() => {
    const baseCropBox = sidecar?.normalization?.cropBox ?? null;
    const rawTrimBox = buildTrimBoxFromCrop(
      baseCropBox,
      sidecar?.normalization?.trim,
      sidecar?.dpi
    );
    const baseTrimBox = baseCropBox && rawTrimBox ? clampBox(rawTrimBox, baseCropBox) : null;
    const baselineGrid = buildBaselineGridOverrides(sidecar);
    baselineBoxesRef.current = {
      crop: baseCropBox,
      trim: baseTrimBox ?? null,
    };
    baselineGuidesRef.current = baselineGrid;
    setCropBox(baseCropBox);
    setTrimBox(baseTrimBox ?? null);
    setRotationDeg(0);
    setBaselineSpacingPx(baselineGrid.spacingPx);
    setBaselineOffsetPx(baselineGrid.offsetPx);
    setBaselineAngleDeg(baselineGrid.angleDeg);
    setBaselineSnapToPeaks(baselineGrid.snapToPeaks);
    setBaselineMarkCorrect(baselineGrid.markCorrect);
    const existingGuideOverrides =
      sidecar?.overrides && typeof sidecar.overrides === "object" && "guides" in sidecar.overrides
        ? (sidecar.overrides.guides as GuideOverrides | null)
        : null;
    setGuideOverridesDraft({
      ...(existingGuideOverrides ?? {}),
      baselineGrid: undefined,
    });
    setActiveGuideId(undefined);
    baselineRotationRef.current = 0;
    setAdjustmentMode(null);
    setOverrideError(null);
    setLastOverrideAppliedAt(null);
  }, [currentPage?.id, sidecar]);

  const getOverlayScale = useCallback((): { x: number; y: number } | null => {
    return calculateOverlayScale(sidecar, normalizedPreview);
  }, [sidecar, normalizedPreview]);

  const getSvgPoint = useCallback(
    (
      event:
        | globalThis.PointerEvent
        | PointerEvent<globalThis.SVGCircleElement>
        | PointerEvent<globalThis.SVGSVGElement>
    ): { x: number; y: number } | null => {
      // Note: The SVG overlay is nested inside the rotated container (the div with the rotate
      // transform), so it rotates with the image. getBoundingClientRect() accounts for all CSS
      // transforms (rotation, zoom, pan), so pointer coordinates are correctly mapped even when rotated.
      const svg = overlaySvgRef.current;
      if (!svg || !normalizedPreview) return null;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const scale = getOverlayScale();
      if (!scale) return null;
      return mapClientPointToOutput({
        clientX: event.clientX,
        clientY: event.clientY,
        rect,
        normalizedWidth: normalizedPreview.width,
        normalizedHeight: normalizedPreview.height,
        scaleX: scale.x,
        scaleY: scale.y,
      });
    },
    [getOverlayScale, normalizedPreview]
  );

  const handleHandlePointerDown = (
    event: PointerEvent<globalThis.SVGCircleElement>,
    handle: OverlayHandle
  ): void => {
    const point = getSvgPoint(event);
    if (!point) return;
    const targetBox = handle.boxType === "trim" ? trimBox : cropBox;
    if (!targetBox) return;
    dragHandleRef.current = {
      handle,
      start: point,
      box: targetBox,
      target: event.currentTarget,
      pointerId: event.pointerId,
    };
    setIsDraggingHandle(true);
    setSnapGuidesState((prev) => ({ ...prev, active: true }));
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleGuidePointerDown = (event: PointerEvent<globalThis.SVGSVGElement>): void => {
    if (!normalizedPreview || !effectiveGuideLayout) return;
    if (dragHandleRef.current) return;
    const point = getSvgPoint(event);
    if (!point) return;
    const hit = hitTestGuides({ point, guideLayout: effectiveGuideLayout, zoom });
    if (!hit) return;
    event.stopPropagation();
    event.preventDefault();
    guideDragRef.current = {
      hit,
      start: point,
      baseOffset: baselineOffsetPx ?? 0,
    };
    setActiveGuideId(hit.guideId);
    setIsDraggingGuide(true);
    setGuidesVisible(true);
  };

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      if (!dragHandleRef.current || !normalizedPreview) return;
      const point = getSvgPoint(event);
      if (!point) return;
      const { handle, start, box } = dragHandleRef.current;
      const deltaX = point.x - start.x;
      const deltaY = point.y - start.y;
      const outputWidth = sidecar?.normalization?.cropBox
        ? sidecar.normalization.cropBox[2] + 1
        : normalizedPreview.width;
      const outputHeight = sidecar?.normalization?.cropBox
        ? sidecar.normalization.cropBox[3] + 1
        : normalizedPreview.height;
      const bounds: Box = [0, 0, outputWidth - 1, outputHeight - 1];
      const dragged = clampBox(applyHandleDrag(box, handle.edge, deltaX, deltaY), bounds);
      const snapDisabled =
        !snapEnabled || snapTemporarilyDisabled || event.ctrlKey || event.metaKey;
      const snapEdges = handleSnapEdges[handle.edge];
      const snapResult = snapDisabled
        ? { box: dragged, guides: [], applied: false }
        : snapBoxWithSources({
            box: dragged,
            edges: snapEdges,
            sources: snapSources,
          });
      setSnapGuidesState({
        guides: snapResult.guides,
        active: true,
        tooltip: formatSnapTooltip(snapResult.guides),
      });
      const snapped = snapResult.box;
      if (handle.boxType === "trim") {
        setTrimBox(snapped);
      } else {
        setCropBox(snapped);
      }
    };

    const handlePointerUp = (): void => {
      if (dragHandleRef.current) {
        const { target, pointerId } = dragHandleRef.current;
        target.releasePointerCapture(pointerId);
        dragHandleRef.current = null;
      }
      setIsDraggingHandle(false);
      setSnapGuidesState({ guides: [], active: false, tooltip: null });
    };

    globalThis.addEventListener?.("pointermove", handlePointerMove);
    globalThis.addEventListener?.("pointerup", handlePointerUp);
    return (): void => {
      globalThis.removeEventListener?.("pointermove", handlePointerMove);
      globalThis.removeEventListener?.("pointerup", handlePointerUp);
    };
  }, [
    getSvgPoint,
    normalizedPreview,
    sidecar?.normalization?.cropBox,
    snapSources,
    snapTemporarilyDisabled,
    snapEnabled,
  ]);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      if (!guideDragRef.current || !normalizedPreview) return;
      const point = getSvgPoint(event);
      if (!point) return;
      const { hit, start, baseOffset } = guideDragRef.current;
      const delta = hit.axis === "x" ? point.x - start.x : point.y - start.y;
      const bounds = { w: normalizedPreview.width - 1, h: normalizedPreview.height - 1 };
      const nextPos = clampGuidePosition(hit.position + delta, hit.axis, bounds);

      if (hit.layerId === "baseline-grid") {
        setBaselineOffsetPx((baseOffset ?? 0) + delta);
        return;
      }

      if (hit.layerId === "margin-guides") {
        const xPositions = getLayerGuidePositions({
          guideLayout: effectiveGuideLayout,
          layerId: "margin-guides",
          axis: "x",
        });
        const yPositions = getLayerGuidePositions({
          guideLayout: effectiveGuideLayout,
          layerId: "margin-guides",
          axis: "y",
        });
        const left = xPositions[0];
        const right = xPositions[xPositions.length - 1];
        const top = yPositions[0];
        const bottom = yPositions[yPositions.length - 1];
        setGuideOverridesDraft((prev) => ({
          ...prev,
          margins: {
            ...prev.margins,
            ...(hit.axis === "x"
              ? {
                  [Math.abs(hit.position - left) <= Math.abs(hit.position - right)
                    ? "leftPx"
                    : "rightPx"]: nextPos,
                }
              : {
                  [Math.abs(hit.position - top) <= Math.abs(hit.position - bottom)
                    ? "topPx"
                    : "bottomPx"]: nextPos,
                }),
          },
        }));
        return;
      }

      if (hit.layerId === "column-guides") {
        const xPositions = getLayerGuidePositions({
          guideLayout: effectiveGuideLayout,
          layerId: "column-guides",
          axis: "x",
        });
        const left = xPositions[0];
        const right = xPositions[xPositions.length - 1];
        setGuideOverridesDraft((prev) => ({
          ...prev,
          columns: {
            ...prev.columns,
            [Math.abs(hit.position - left) <= Math.abs(hit.position - right)
              ? "leftPx"
              : "rightPx"]: nextPos,
          },
        }));
        return;
      }

      if (hit.layerId === "gutter-bands") {
        const xPositions = getLayerGuidePositions({
          guideLayout: effectiveGuideLayout,
          layerId: "gutter-bands",
          axis: "x",
        });
        const start = xPositions[0];
        const end = xPositions[xPositions.length - 1];
        setGuideOverridesDraft((prev) => ({
          ...prev,
          gutterBand: {
            ...prev.gutterBand,
            [Math.abs(hit.position - start) <= Math.abs(hit.position - end) ? "startPx" : "endPx"]:
              nextPos,
          },
        }));
        return;
      }

      if (hit.layerId === "header-footer-bands") {
        const headerPositions = getLayerGuidePositions({
          guideLayout: effectiveGuideLayout,
          layerId: "header-footer-bands",
          axis: "y",
          role: "header-band",
        });
        const footerPositions = getLayerGuidePositions({
          guideLayout: effectiveGuideLayout,
          layerId: "header-footer-bands",
          axis: "y",
          role: "footer-band",
        });
        if (hit.role === "header-band") {
          const start = headerPositions[0];
          const end = headerPositions[headerPositions.length - 1];
          setGuideOverridesDraft((prev) => ({
            ...prev,
            headerBand: {
              ...prev.headerBand,
              [Math.abs(hit.position - start) <= Math.abs(hit.position - end)
                ? "startPx"
                : "endPx"]: nextPos,
            },
          }));
        } else if (hit.role === "footer-band") {
          const start = footerPositions[0];
          const end = footerPositions[footerPositions.length - 1];
          setGuideOverridesDraft((prev) => ({
            ...prev,
            footerBand: {
              ...prev.footerBand,
              [Math.abs(hit.position - start) <= Math.abs(hit.position - end)
                ? "startPx"
                : "endPx"]: nextPos,
            },
          }));
        }
      }
    };

    const handlePointerUp = (): void => {
      if (!guideDragRef.current) return;
      guideDragRef.current = null;
      setIsDraggingGuide(false);
      setActiveGuideId(undefined);
    };

    globalThis.addEventListener?.("pointermove", handlePointerMove);
    globalThis.addEventListener?.("pointerup", handlePointerUp);
    return (): void => {
      globalThis.removeEventListener?.("pointermove", handlePointerMove);
      globalThis.removeEventListener?.("pointerup", handlePointerUp);
    };
  }, [effectiveGuideLayout, getSvgPoint, normalizedPreview, zoom, baselineOffsetPx]);

  const handleSubmitReview = async (): Promise<void> => {
    const windowRef: typeof globalThis & {
      asteria?: {
        ipc?: {
          [key: string]: (
            runId: string,
            runDir: string,
            payload: unknown
          ) => Promise<import("../../ipc/contracts.js").IpcResult<unknown>>;
        };
      };
    } = globalThis;
    if (!runId || !runDir || !windowRef.asteria?.ipc || decisions.size === 0) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const payload = Array.from(decisions.entries()).map(([pageId, decisionValue]) => ({
        pageId,
        decision: decisionValue === "flag" ? "adjust" : decisionValue,
      }));
      const submitResult = await windowRef.asteria.ipc["asteria:submit-review"](
        runId,
        runDir,
        payload
      );
      unwrapIpcResult(submitResult, "Submit review");
      setDecisions(new Map());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit review";
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApplyOverride = async (): Promise<void> => {
    if (!runId || !runDir || !currentPage) return;
    const overrides: Record<string, unknown> = {};
    const normalization: Record<string, unknown> = {};
    const baselineGridOverrides: BaselineGridOverrides = {
      spacingPx: baselineSpacingPx ?? null,
      offsetPx: baselineOffsetPx ?? null,
      angleDeg: baselineAngleDeg ?? null,
      snapToPeaks: baselineSnapToPeaks,
      markCorrect: baselineMarkCorrect,
    };
    const baselineGrid = {
      spacingPx: toOptionalNumber(baselineGridOverrides.spacingPx),
      offsetPx: toOptionalNumber(baselineGridOverrides.offsetPx),
      angleDeg: toOptionalNumber(baselineGridOverrides.angleDeg),
      snapToPeaks: baselineGridOverrides.snapToPeaks,
      markCorrect: baselineGridOverrides.markCorrect,
    };
    const guideOverrides: GuideOverrides = { ...guideOverridesDraft };
    if (rotationDeg !== baselineRotationRef.current) {
      normalization.rotationDeg = rotationDeg;
    }
    if (cropBox && !isSameBox(cropBox, baselineBoxesRef.current.crop)) {
      normalization.cropBox = cropBox;
    }
    // NOTE: Trim box overrides are persisted as absolute coordinates, independent of
    // the computed trim margin. This allows per-page manual trim adjustments that
    // don't follow the book-wide trim margin setting. The normalization pipeline
    // will use the override trimBox directly instead of deriving it from cropBox + trimMm.
    if (trimBox && !isSameBox(trimBox, baselineBoxesRef.current.trim)) {
      normalization.trimBox = trimBox;
    }
    if (Object.keys(normalization).length > 0) {
      overrides.normalization = normalization;
    }
    if (!areBaselineGridOverridesEqual(baselineGridOverrides, baselineGuidesRef.current)) {
      guideOverrides.baselineGrid = baselineGrid;
    }
    if (hasGuideOverrides(guideOverrides)) {
      overrides.guides = guideOverrides;
    }
    if (Object.keys(overrides).length === 0) {
      setOverrideError("No changes to save — adjustments match current values");
      return;
    }
    if (applyTargets.length === 0) {
      setOverrideError("No pages available for the selected apply scope.");
      return;
    }

    const applyOverrideChannel = getIpcChannel<
      [runId: string, runDir: string, pageId: string, overrides: Record<string, unknown>],
      void
    >("asteria:apply-override");
    if (!applyOverrideChannel) {
      setOverrideError("IPC unavailable.");
      return;
    }
    setIsApplyingOverride(true);
    setOverrideError(null);
    const appliedAt = new Date().toISOString();
    try {
      const failures: string[] = [];
      for (const targetPage of applyTargets) {
        try {
          const result = await applyOverrideChannel(runId, runDir, targetPage.id, overrides);
          unwrapIpcResult(result, "Apply override");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to apply override";
          failures.push(`${targetPage.filename}: ${message}`);
        }
      }
      if (failures.length > 0) {
        const remainingCount = failures.length - 1;
        const suffix = remainingCount === 1 ? "" : "s";
        const failureSummary =
          failures.length === 1
            ? failures[0]
            : `${failures[0]} (and ${remainingCount} other error${suffix})`;
        // Log all failures so the full list is visible for debugging.
        console.error("Failed to apply overrides for some pages:", failures);
        setOverrideError(
          `Applied with ${failures.length} error${failures.length === 1 ? "" : "s"}: ${failureSummary}`
        );
      } else {
        setLastOverrideAppliedAt(appliedAt);
        baselineBoxesRef.current = {
          crop: cropBox,
          trim: trimBox,
        };
        baselineRotationRef.current = rotationDeg;
        baselineGuidesRef.current = baselineGridOverrides;
      }
      if (applyScope !== "page") {
        const recordTemplateTrainingChannel = getIpcChannel<
          [runId: string, signal: Record<string, unknown>],
          void
        >("asteria:record-template-training");
        if (recordTemplateTrainingChannel) {
          try {
            const result = await recordTemplateTrainingChannel(runId, {
              templateId: templateKey,
              scope: applyScope,
              appliedAt,
              pages: applyTargets.map((page) => page.id),
              overrides,
              sourcePageId: currentPage.id,
              layoutProfile: currentPage.layoutProfile,
            });
            unwrapIpcResult(result, "Record template training");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Failed to record template training signal";
            setOverrideError(appendError(overrideError, `Training signal error: ${message}`));
          }
        }
      }
      if (applyScope !== "page" && failures.length === 0) {
        setOverrideError(
          appendError(
            overrideError,
            `Overrides applied to multiple pages. Other pages in this ${applyScope} may show stale data until you refresh the review queue.`
          )
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply override";
      setOverrideError(message);
    } finally {
      setIsApplyingOverride(false);
    }
  };

  const handleTemplateClusterAction = async (action: "confirm" | "correct"): Promise<void> => {
    if (!runId || !currentPage) return;
    const recordTemplateTrainingChannel = getIpcChannel<
      [runId: string, signal: Record<string, unknown>],
      void
    >("asteria:record-template-training");
    if (!recordTemplateTrainingChannel) {
      setTemplateActionError("IPC unavailable.");
      return;
    }
    const templateId =
      action === "confirm" ? (currentTemplateCluster?.id ?? templateAssignmentId) : null;
    const targetTemplateId =
      action === "correct" ? (selectedTemplateClusterId ?? null) : templateId;
    const resolvedTemplateId = action === "confirm" ? templateId : targetTemplateId;
    if (!resolvedTemplateId) {
      setTemplateActionError("No template cluster selected.");
      return;
    }
    setTemplateActionError(null);
    setTemplateActionStatus(null);
    setIsTemplateActionPending(true);
    const appliedAt = new Date().toISOString();
    const targetCluster =
      templateClusters.find((cluster) => cluster.id === resolvedTemplateId) ?? null;
    const overrides = {
      templateCluster: {
        action,
        fromTemplateId: templateAssignmentId ?? currentTemplateCluster?.id ?? null,
        toTemplateId: targetTemplateId,
        assignmentConfidence: templateAssignmentConfidence ?? null,
        clusterConfidence: targetCluster?.confidence ?? null,
      },
    };
    try {
      const result = await recordTemplateTrainingChannel(runId, {
        templateId: resolvedTemplateId,
        scope: "template",
        appliedAt,
        pages: [currentPage.id],
        overrides,
        sourcePageId: currentPage.id,
        layoutProfile: currentPage.layoutProfile,
      });
      unwrapIpcResult(result, "Record template training");
      setTemplateActionStatus(
        action === "confirm" ? "Template assignment confirmed." : "Template correction saved."
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to record template training signal";
      setTemplateActionError(message);
    } finally {
      setIsTemplateActionPending(false);
    }
  };

  useKeyboardShortcuts([
    // Navigation
    {
      key: "j",
      handler: (): void => setSelectedIndex(Math.min(selectedIndex + 1, queuePages.length - 1)),
      description: "Next page",
    },
    {
      key: "k",
      handler: (): void => setSelectedIndex(Math.max(selectedIndex - 1, 0)),
      description: "Previous page",
    },

    // Decision actions
    {
      key: "a",
      handler: handleAccept,
      description: "Accept page",
    },
    {
      key: "f",
      handler: handleFlag,
      description: "Flag for review",
    },
    {
      key: "r",
      handler: handleReject,
      description: "Reject page",
    },
    {
      key: "u",
      handler: handleUndo,
      description: "Undo last decision",
    },
    {
      key: "Enter",
      ctrlKey: true,
      handler: (): void => {
        void handleSubmitReview();
      },
      description: "Submit review decisions",
    },

    // View controls
    {
      key: " ",
      handler: (): void => setOverlaysVisible(!overlaysVisible),
      description: "Toggle overlays",
    },
    {
      key: "g",
      handler: (): void => setGuidesVisible((prev) => !prev),
      description: "Toggle guides",
    },
    {
      key: "g",
      shiftKey: true,
      handler: (): void => {
        setGuideLayerVisibility((prev) => ({
          ...prev,
          rulers: !(prev.rulers ?? true),
        }));
        setGuidesVisible(true);
      },
      description: "Toggle rulers",
    },
    {
      key: "s",
      handler: (): void => setSnapEnabled((prev) => !prev),
      description: "Toggle snapping",
    },
    {
      key: "+",
      handler: (): void => zoomBy(0.1),
      description: "Zoom in",
    },
    {
      key: "-",
      handler: (): void => zoomBy(-0.1),
      description: "Zoom out",
    },
    {
      key: "0",
      handler: resetView,
      description: "Reset view",
    },

    // Rotation controls
    {
      key: "[",
      handler: (): void => rotateBy(-0.5),
      description: "Rotate counterclockwise",
    },
    {
      key: "]",
      handler: (): void => rotateBy(0.5),
      description: "Rotate clockwise",
    },
    {
      key: "[",
      altKey: true,
      handler: (): void => rotateBy(-0.1),
      description: "Micro-rotate counterclockwise",
    },
    {
      key: "]",
      altKey: true,
      handler: (): void => rotateBy(0.1),
      description: "Micro-rotate clockwise",
    },

    // Pan controls
    {
      key: "ArrowUp",
      shiftKey: true,
      handler: (): void => setPan((prev) => ({ x: prev.x, y: prev.y + 24 })),
      description: "Pan up",
    },
    {
      key: "ArrowDown",
      shiftKey: true,
      handler: (): void => setPan((prev) => ({ x: prev.x, y: prev.y - 24 })),
      description: "Pan down",
    },
    {
      key: "ArrowLeft",
      shiftKey: true,
      handler: (): void => setPan((prev) => ({ x: prev.x + 24, y: prev.y })),
      description: "Pan left",
    },
    {
      key: "ArrowRight",
      shiftKey: true,
      handler: (): void => setPan((prev) => ({ x: prev.x - 24, y: prev.y })),
      description: "Pan right",
    },
  ]);

  if (!runId || !runDir) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="stack" size={48} />
        </div>
        <h2 className="empty-state-title">Select a run to review</h2>
        <p className="empty-state-description">
          Choose a run from Run History to load its review queue.
        </p>
      </div>
    );
  }

  const hasDecisions = decisions.size > 0;
  const canSubmit = Boolean(runId) && hasDecisions && !isSubmitting;
  const normalizedSrc = resolvePreviewSrc(normalizedPreview);
  const sourceSrc = resolvePreviewSrc(sourcePreview);
  const activeCropBox = cropBox ?? sidecar?.normalization?.cropBox ?? null;
  const activeTrimBox = trimBox ?? null;
  const overlayScale = calculateOverlayScale(sidecar, normalizedPreview);
  const overlayScaleX = overlayScale?.x ?? 1;
  const overlayScaleY = overlayScale?.y ?? 1;
  const overlaySvg = buildOverlaySvg({
    sidecar,
    normalizedPreview,
    overlaysVisible,
    overlayLayers,
    guideLayerVisibility,
    guideGroupVisibility: effectiveGuideGroupVisibility,
    guideGroupOpacities,
    soloGuideGroup,
    guideLayout: effectiveGuideLayout ?? undefined,
    overlayScaleX,
    overlayScaleY,
    zoom,
    cropBox: activeCropBox,
    trimBox: activeTrimBox,
    adjustmentMode,
    snapGuides: snapGuidesState.guides,
    showSnapGuides: isDraggingHandle && snapGuidesState.active && snapEnabled,
    snapTooltip: snapGuidesState.tooltip,
    overlaySvgRef,
    onHandlePointerDown: handleHandlePointerDown,
    onGuidePointerDown: handleGuidePointerDown,
    activeGuideId,
  });

  return (
    <ReviewQueueLayout
      runId={runId}
      queuePages={queuePages}
      currentPage={currentPage}
      selectedIndex={selectedIndex}
      decisions={decisions}
      overlaysVisible={overlaysVisible}
      showSourcePreview={showSourcePreview}
      zoom={zoom}
      rotationDeg={rotationDeg}
      overlayLayers={overlayLayers}
      guideLayerVisibility={guideLayerVisibility}
      guidesVisible={guidesVisible}
      guideGroupVisibility={guideGroupVisibility}
      guideGroupOpacities={guideGroupOpacities}
      soloGuideGroup={soloGuideGroup}
      snappingEnabled={snapEnabled}
      selectedIds={selectedIds}
      listRef={listRef}
      scrollTop={scrollTop}
      viewportHeight={viewportHeight}
      pan={pan}
      isPanning={isPanning}
      sidecarError={sidecarError}
      normalizedSrc={normalizedSrc}
      sourceSrc={sourceSrc}
      overlaySvg={overlaySvg}
      isSubmitting={isSubmitting}
      submitError={submitError}
      canSubmit={canSubmit}
      adjustmentMode={adjustmentMode}
      baselineSpacingPx={baselineSpacingPx}
      baselineOffsetPx={baselineOffsetPx}
      baselineAngleDeg={baselineAngleDeg}
      baselineSnapToPeaks={baselineSnapToPeaks}
      baselineMarkCorrect={baselineMarkCorrect}
      setBaselineSpacingPx={setBaselineSpacingPx}
      setBaselineOffsetPx={setBaselineOffsetPx}
      setBaselineAngleDeg={setBaselineAngleDeg}
      setBaselineSnapToPeaks={setBaselineSnapToPeaks}
      setBaselineMarkCorrect={setBaselineMarkCorrect}
      cropBox={activeCropBox}
      trimBox={activeTrimBox}
      isApplyingOverride={isApplyingOverride}
      overrideError={overrideError}
      lastOverrideAppliedAt={lastOverrideAppliedAt}
      applyScope={applyScope}
      applyTargetCount={applyTargetCount}
      templateSummary={templateSummary}
      representativePages={representativePages}
      templateClusters={templateClusters}
      currentTemplateCluster={currentTemplateCluster}
      templateAssignmentId={templateAssignmentId}
      templateAssignmentConfidence={templateAssignmentConfidence}
      selectedTemplateClusterId={selectedTemplateClusterId}
      setSelectedTemplateClusterId={setSelectedTemplateClusterId}
      handleTemplateClusterAction={handleTemplateClusterAction}
      isTemplateActionPending={isTemplateActionPending}
      templateActionStatus={templateActionStatus}
      templateActionError={templateActionError}
      onApplyScopeChange={setApplyScope}
      onSelectIndex={setSelectedIndex}
      onScroll={setScrollTop}
      onToggleSelected={toggleSelected}
      onToggleOverlays={() => setOverlaysVisible(!overlaysVisible)}
      onToggleSource={() => setShowSourcePreview(!showSourcePreview)}
      onZoomOut={() => zoomBy(-0.1)}
      onZoomIn={() => zoomBy(0.1)}
      onResetView={resetView}
      onRotateLeft={() => rotateBy(-0.5)}
      onRotateRight={() => rotateBy(0.5)}
      onMicroRotateLeft={() => rotateBy(-0.1)}
      onMicroRotateRight={() => rotateBy(0.1)}
      onResetRotation={resetRotation}
      onSetAdjustmentMode={handleSetAdjustmentMode}
      onResetAdjustments={resetAdjustments}
      onApplyOverride={() => void handleApplyOverride()}
      onViewerMouseDown={handleViewerMouseDown}
      onViewerMouseMove={handleViewerMouseMove}
      onViewerMouseUp={handleViewerMouseUp}
      onViewerWheel={handleViewerWheel}
      onViewerKeyDown={handleViewerKeyDown}
      onApplyDecisionToSelection={applyDecisionToSelection}
      onAcceptSameReason={acceptSameReason}
      onToggleOverlayLayer={(layerKey, checked) =>
        setOverlayLayers((prev) => ({
          ...prev,
          [layerKey]: checked,
        }))
      }
      onToggleGuideGroup={handleGuideGroupToggle}
      onGuideGroupOpacityChange={handleGuideGroupOpacityChange}
      onToggleGuideLayer={handleGuideLayerToggle}
      onResetGuideVisibility={handleResetGuideVisibility}
      onToggleGuidesVisible={() => setGuidesVisible((prev) => !prev)}
      onToggleSnapping={() => setSnapEnabled((prev) => !prev)}
      onAccept={handleAccept}
      onFlag={handleFlag}
      onReject={handleReject}
      onUndo={handleUndo}
      onSubmit={() => void handleSubmitReview()}
    />
  );
}
