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

const isAbsoluteFilePath = (value: string): boolean =>
  value.startsWith("/") || /^[A-Za-z]:\\/.test(value);

const buildRunPreviewPath = (
  runDir: string,
  pageId: string,
  kind: "source" | "normalized"
): string => {
  const separator = runDir.includes("\\") ? "\\" : "/";
  const trimmedRunDir = runDir.replace(/[\\/]+$/, "");
  return `${trimmedRunDir}${separator}previews${separator}${pageId}-${kind}.png`;
};

const derivePreviewDimensions = (
  sidecar: PageLayoutSidecar | null | undefined
): { width: number; height: number } | null => {
  if (!sidecar) return null;
  const cropBox = sidecar.normalization?.cropBox;
  if (cropBox && cropBox.length === 4) {
    return { width: cropBox[2] + 1, height: cropBox[3] + 1 };
  }
  const pageMask = sidecar.normalization?.pageMask;
  if (pageMask && pageMask.length === 4) {
    return { width: pageMask[2] + 1, height: pageMask[3] + 1 };
  }
  const elements = sidecar.elements ?? [];
  if (elements.length === 0) return null;
  const maxX = Math.max(...elements.map((element) => element.bbox[2] ?? 0));
  const maxY = Math.max(...elements.map((element) => element.bbox[3] ?? 0));
  return maxX > 0 && maxY > 0 ? { width: maxX + 1, height: maxY + 1 } : null;
};

const resolvePreviewSrc = (preview?: PreviewRef): string | undefined => {
  if (!preview?.path) return undefined;
  if (preview.path.startsWith("asteria://")) return preview.path;
  const sanitized = preview.path.startsWith("file://") ? preview.path.slice(7) : preview.path;
  if (isAbsoluteFilePath(sanitized)) {
    return `asteria://asset?path=${encodeURIComponent(sanitized)}`;
  }
  return sanitized;
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

const useReviewQueuePages = (
  runId?: string,
  runDir?: string
): { pages: ReviewPage[]; isLoading: boolean } => {
  const [pages, setPages] = useState<ReviewPage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

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
      setIsLoading(true);
      try {
        const queueResult = await windowRef.asteria.ipc["asteria:fetch-review-queue"](
          runId,
          runDir
        );
        if (cancelled) return;
        setPages(mapReviewQueue(unwrapIpcResult(queueResult, "Fetch review queue")));
        setIsLoading(false);
      } catch {
        if (!cancelled) {
          setPages([]);
          setIsLoading(false);
        }
      }
    };
    loadQueue();
    return (): void => {
      cancelled = true;
    };
  }, [runDir, runId]);

  return { pages, isLoading };
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
): { sidecar: PageLayoutSidecar | null; sidecarError: string | null; isLoading: boolean } => {
  const [sidecar, setSidecar] = useState<PageLayoutSidecar | null>(null);
  const [sidecarError, setSidecarError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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
      setIsLoading(true);
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
          setIsLoading(false);
          return;
        }
        setSidecar(sidecarResult.value ?? null);
        setSidecarError(null);
        setIsLoading(false);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load sidecar";
        setSidecarError(message);
        setSidecar(null);
        setIsLoading(false);
      }
    };
    void loadSidecar();
    return (): void => {
      cancelled = true;
    };
  }, [currentPage, runDir, runId]);

  return { sidecar, sidecarError, isLoading };
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
  isQueueLoading: boolean;
  selectedIndex: number;
  decisions: Map<string, DecisionValue>;
  overlaysVisible: boolean;
  showSourcePreview: boolean;
  inspectorOpen: boolean;
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
  isSidecarLoading: boolean;
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
  isBusy: boolean;
  onApplyScopeChange: (scope: TemplateScope) => void;
  onSelectIndex: (index: number) => void;
  onScroll: (scrollTop: number) => void;
  onToggleSelected: (pageId: string) => void;
  onToggleOverlays: () => void;
  onToggleSource: () => void;
  onToggleInspector: () => void;
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
  isQueueLoading,
  selectedIndex,
  decisions,
  overlaysVisible,
  showSourcePreview,
  inspectorOpen,
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
  isSidecarLoading,
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
  isBusy,
  onApplyScopeChange,
  onSelectIndex,
  onScroll,
  onToggleSelected,
  onToggleOverlays,
  onToggleSource,
  onToggleInspector,
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
  const [normalizedLoadedStatus, setNormalizedLoadedStatus] = useState<"loaded" | "error" | null>(
    null
  );
  const [sourceLoadedStatus, setSourceLoadedStatus] = useState<"loaded" | "error" | null>(null);

  const setNormalizedStatus = setNormalizedLoadedStatus;
  const _setSourceStatus = setSourceLoadedStatus;

  const normalizedStatus: "idle" | "loading" | "loaded" | "error" = normalizedSrc
    ? (normalizedLoadedStatus ?? "loading")
    : "idle";
  const sourceStatus: "idle" | "loading" | "loaded" | "error" = sourceSrc
    ? (sourceLoadedStatus ?? "loading")
    : "idle";

  if (isQueueLoading) {
    return (
      <div className="empty-state">
        <div className="review-queue-spinner" aria-hidden="true" />
        <h2 className="empty-state-title">Loading review queue...</h2>
        <p className="empty-state-description">Fetching flagged pages and previews.</p>
      </div>
    );
  }

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
  const interactionDisabled = isBusy || isSidecarLoading;
  const busyMessage = isSubmitting
    ? "Submitting review decisions..."
    : isApplyingOverride
      ? "Applying layout adjustments..."
      : isTemplateActionPending
        ? "Saving template update..."
        : "Processing, please wait.";
  const totalHeight = queuePages.length * ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    queuePages.length - 1,
    Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + OVERSCAN
  );
  const visiblePages = queuePages.slice(startIndex, endIndex + 1);
  const shellClassName = inspectorOpen
    ? "review-queue-shell"
    : "review-queue-shell review-queue--inspector-collapsed";
  const shellBusyClass = isBusy || isSidecarLoading ? " is-busy" : "";

  return (
    <div className={`${shellClassName}${shellBusyClass}`} aria-busy={isBusy || isSidecarLoading}>
      <aside className="review-queue-rail" aria-label="Review queue list">
        <div className="review-queue-rail-header">
          <div>
            <p className="review-queue-rail-title">Review Queue</p>
            <p className="review-queue-rail-subtitle">{queuePages.length} pages need attention</p>
          </div>
          <span className="review-queue-rail-run">Run {runId}</span>
        </div>
        <div
          ref={listRef}
          className="review-queue-rail-list"
          onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        >
          <div className="review-queue-rail-spacer" style={{ height: totalHeight }}>
            {visiblePages.map((page, offset) => {
              const index = startIndex + offset;
              const pageDecision = decisions.get(page.id);
              const isSelected = selectedIds.has(page.id);
              const isActive = index === selectedIndex;
              return (
                <button
                  key={page.id}
                  onClick={() => onSelectIndex(index)}
                  className={`review-queue-item ${isActive ? "is-active" : ""}`}
                  style={{ top: index * ITEM_HEIGHT }}
                  aria-current={isActive}
                >
                  <div className="review-queue-item-inner">
                    <input
                      className="review-queue-item-checkbox"
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelected(page.id)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${page.filename} for batch actions`}
                    />
                    <div className="review-queue-item-body">
                      <div className="review-queue-item-row">
                        <span className="review-queue-item-title">{page.filename}</span>
                        {pageDecision && (
                          <span className={`badge ${getDecisionBadgeClass(pageDecision)}`}>
                            {pageDecision}
                          </span>
                        )}
                      </div>
                      <div className="review-queue-item-reason">{page.reason}</div>
                      <div className="review-queue-item-confidence">
                        <span style={{ color: getConfidenceColor(page.confidence) }}>
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
      </aside>

      <section className="review-queue-workspace">
        <header className="review-queue-toolbar">
          <div>
            <h3 className="review-queue-title">{currentPage.filename}</h3>
            <p className="review-queue-subtitle">
              Page {selectedIndex + 1} of {queuePages.length}
            </p>
          </div>
          <div className="review-queue-toolbar-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={onToggleOverlays}
              aria-pressed={overlaysVisible}
              disabled={interactionDisabled}
            >
              <Icon name="stack" size={16} className="review-queue-btn-icon" />
              {overlaysVisible ? "Hide" : "Show"} Overlays
              <kbd className="review-kbd">Space</kbd>
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={onToggleSource}
              aria-pressed={showSourcePreview}
              disabled={!sourceSrc || interactionDisabled}
            >
              <Icon name="folder" size={16} className="review-queue-btn-icon" />
              {showSourcePreview ? "Hide" : "Show"} Source
            </button>
            <div className="review-queue-toolbar-group">
              <button
                className="btn btn-secondary btn-sm"
                onClick={onZoomOut}
                disabled={interactionDisabled}
              >
                −
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onZoomIn}
                disabled={interactionDisabled}
              >
                +
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onResetView}
                disabled={interactionDisabled}
              >
                Reset <kbd className="review-kbd">0</kbd>
              </button>
              <span className="review-queue-toolbar-metric">{Math.round(zoom * 100)}%</span>
            </div>
            <div className="review-queue-toolbar-divider" />
            <div className="review-queue-toolbar-group">
              <button
                className="btn btn-secondary btn-sm"
                onClick={onRotateLeft}
                disabled={interactionDisabled}
              >
                ⟲ <kbd className="review-kbd">[</kbd>
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onRotateRight}
                disabled={interactionDisabled}
              >
                ⟳ <kbd className="review-kbd">]</kbd>
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onMicroRotateLeft}
                disabled={interactionDisabled}
              >
                −0.1° <kbd className="review-kbd">Alt+[</kbd>
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onMicroRotateRight}
                disabled={interactionDisabled}
              >
                +0.1° <kbd className="review-kbd">Alt+]</kbd>
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onResetRotation}
                disabled={interactionDisabled}
              >
                Reset rotation
              </button>
              <span className="review-queue-toolbar-metric">{rotationDeg.toFixed(1)}°</span>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onToggleInspector}
              aria-expanded={inspectorOpen}
            >
              <Icon name="settings" size={16} className="review-queue-btn-icon" />
              {inspectorOpen ? "Hide" : "Show"} Inspector
            </button>
          </div>
        </header>

        <div className="review-queue-viewer">
          <button
            className="review-queue-canvas"
            aria-label="Preview viewer"
            type="button"
            onMouseDown={onViewerMouseDown}
            onMouseMove={onViewerMouseMove}
            onMouseUp={onViewerMouseUp}
            onMouseLeave={onViewerMouseUp}
            onWheel={onViewerWheel}
            onKeyDown={onViewerKeyDown}
            style={{ cursor: isPanning ? "grabbing" : "grab" }}
            disabled={interactionDisabled}
          >
            <div
              className={`review-queue-canvas-grid ${
                showSourcePreview && sourceSrc ? "is-split" : ""
              }`}
            >
              <div className="review-queue-preview-card">
                {normalizedSrc ? (
                  <div
                    className="review-queue-transform"
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotationDeg}deg)`,
                      transition: isPanning ? "none" : "transform 120ms",
                    }}
                  >
                    <div className="review-queue-preview-frame">
                      <img
                        src={normalizedSrc}
                        alt={`Normalized preview for ${currentPage.filename}`}
                        onLoad={() => setNormalizedStatus("loaded")}
                        onError={() => setNormalizedStatus("error")}
                      />
                      {overlaySvg}
                      {normalizedStatus === "loading" && (
                        <div className="review-queue-preview-status">
                          <div className="review-queue-spinner" aria-hidden="true" />
                          <span>Loading preview...</span>
                        </div>
                      )}
                      {normalizedStatus === "error" && (
                        <div className="review-queue-preview-status">
                          <Icon name="alert" size={18} />
                          <span>Preview unavailable</span>
                        </div>
                      )}
                      {isSidecarLoading && (
                        <div className="review-queue-preview-status">
                          <div className="review-queue-spinner" aria-hidden="true" />
                          <span>Loading layout overlays...</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="review-queue-preview-empty">
                    {isSidecarLoading ? "Loading preview..." : "No normalized preview"}
                  </div>
                )}
              </div>
              {showSourcePreview && sourceSrc && (
                <div className="review-queue-preview-card">
                  <img
                    src={sourceSrc}
                    alt={`Source preview for ${currentPage.filename}`}
                    onLoad={() => setSourceLoadedStatus("loaded")}
                    onError={() => setSourceLoadedStatus("error")}
                  />
                  {sourceStatus === "loading" && (
                    <div className="review-queue-preview-status">
                      <div className="review-queue-spinner" aria-hidden="true" />
                      <span>Loading source...</span>
                    </div>
                  )}
                  {sourceStatus === "error" && (
                    <div className="review-queue-preview-status">
                      <Icon name="alert" size={18} />
                      <span>Source preview unavailable</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {sidecarError && (
              <output className="review-queue-error" role="status">
                {sidecarError}
              </output>
            )}
          </button>
        </div>
      </section>

      <aside
        className={`review-queue-inspector ${inspectorOpen ? "is-open" : "is-collapsed"}`}
        aria-label="Review inspector"
      >
        <div className="review-queue-inspector-header">
          <div>
            <p className="review-queue-inspector-title">Inspector</p>
            <p className="review-queue-inspector-subtitle">Decisions and corrections</p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onToggleInspector}
            aria-expanded={inspectorOpen}
          >
            <Icon name="settings" size={16} className="review-queue-btn-icon" />
            <span className="review-queue-inspector-button-label">
              {inspectorOpen ? "Collapse" : "Expand"}
            </span>
          </button>
        </div>
        <div className="review-queue-inspector-body">
          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Why flagged</div>
            {currentPage.issues.length === 0 ? (
              <p className="review-queue-panel-muted">No automated issues were recorded.</p>
            ) : (
              <ul className="review-queue-issues">
                {currentPage.issues.map((issue) => {
                  const info = getReasonInfo(issue);
                  return (
                    <li key={`${currentPage.id}-${issue}`}>
                      <div className="review-queue-issue-title">{info.label}</div>
                      <div className="review-queue-issue-body">{info.explanation}</div>
                      <div className="review-queue-issue-action">Recommended: {info.action}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Overlay layers</div>
            <div className="review-queue-grid-two">
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
                <label key={layer.key} className="review-queue-toggle">
                  <input
                    type="checkbox"
                    checked={overlayLayers[layer.key as OverlayLayerKey]}
                    onChange={(event) =>
                      onToggleOverlayLayer(layer.key as OverlayLayerKey, event.target.checked)
                    }
                  />
                  <span>{layer.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Guide groups</div>
            <div className="review-queue-panel-stack">
              <label className="review-queue-toggle">
                <input
                  type="checkbox"
                  checked={guidesVisible}
                  onChange={onToggleGuidesVisible}
                  aria-label="Toggle guides"
                />
                <span>Guides enabled</span>
              </label>
              <label className="review-queue-toggle">
                <input
                  type="checkbox"
                  checked={snappingEnabled}
                  onChange={onToggleSnapping}
                  aria-label="Toggle snapping"
                />
                <span>Snapping enabled</span>
              </label>
              {GUIDE_GROUP_ORDER.map((group) => {
                const opacity = guideGroupOpacities[group];
                const isChecked = soloGuideGroup
                  ? soloGuideGroup === group
                  : guideGroupVisibility[group];
                return (
                  <div key={group} className="review-queue-panel-stack">
                    <label className="review-queue-toggle">
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
                      <span>{GUIDE_GROUP_LABELS[group]}</span>
                      {soloGuideGroup === group && <span className="review-queue-tag">Solo</span>}
                    </label>
                    <label className="review-queue-slider">
                      <span>Opacity</span>
                      <div className="review-queue-slider-row">
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
                        <span>{Math.round(opacity * 100)}%</span>
                      </div>
                    </label>
                  </div>
                );
              })}
              <p className="review-queue-panel-hint">Alt-click a group to solo it.</p>
              <div className="review-queue-panel-subtitle">Guide layers</div>
              <div className="review-queue-panel-stack">
                {guideLayerRegistry.map((layer) => (
                  <label key={layer.id} className="review-queue-toggle">
                    <input
                      type="checkbox"
                      checked={guideLayerVisibility[layer.id] ?? layer.defaultVisible}
                      onChange={(event) => onToggleGuideLayer(layer.id, event.target.checked)}
                      aria-label={`${resolveGuideLayerLabel(layer.id)} guide layer`}
                    />
                    <span>{resolveGuideLayerLabel(layer.id)}</span>
                  </label>
                ))}
                <button className="btn btn-secondary btn-sm" onClick={onResetGuideVisibility}>
                  Reset guides visibility
                </button>
              </div>
            </div>
          </section>

          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Batch actions</div>
            <div className="review-queue-panel-row">
              <span className="review-queue-panel-muted">Selected: {selectedCount}</span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onApplyDecisionToSelection("accept")}
                disabled={selectedCount === 0 || interactionDisabled}
              >
                Accept selected
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onApplyDecisionToSelection("flag")}
                disabled={selectedCount === 0 || interactionDisabled}
              >
                Flag selected
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onApplyDecisionToSelection("reject")}
                disabled={selectedCount === 0 || interactionDisabled}
              >
                Reject selected
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onAcceptSameReason}
                disabled={interactionDisabled}
              >
                Accept same reason
              </button>
              <button className="btn btn-secondary btn-sm" disabled>
                Reprocess selected (planned)
              </button>
            </div>
          </section>

          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Adjustments</div>
            <div className="review-queue-panel-stack">
              <div className="review-queue-panel-row">
                <button
                  className={`btn btn-sm ${adjustmentMode === "crop" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => onSetAdjustmentMode(adjustmentMode === "crop" ? null : "crop")}
                  disabled={interactionDisabled}
                >
                  Crop handles
                </button>
                <button
                  className={`btn btn-sm ${adjustmentMode === "trim" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => onSetAdjustmentMode(adjustmentMode === "trim" ? null : "trim")}
                  disabled={interactionDisabled}
                >
                  Trim handles
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={onResetAdjustments}
                  disabled={interactionDisabled}
                >
                  Reset crop/trim
                </button>
              </div>
              <fieldset className="review-queue-fieldset">
                <legend>Apply override scope</legend>
                <div className="review-queue-panel-row">
                  {(["page", "section", "template"] as TemplateScope[]).map((scope) => (
                    <label
                      key={scope}
                      className={`btn btn-sm ${applyScope === scope ? "btn-primary" : "btn-secondary"}`}
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
                <span className="review-queue-panel-hint">
                  Targets: {applyTargetCount} page{applyTargetCount === 1 ? "" : "s"}
                  {applyScope === "template" && templateSummary
                    ? ` in ${templateSummary.label}`
                    : ""}
                  {applyScope === "section" ? " in contiguous block" : ""}
                </span>
              </fieldset>
              <div className="review-queue-panel-row">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onApplyOverride}
                  disabled={isApplyingOverride || interactionDisabled}
                >
                  {isApplyingOverride ? "Applying…" : "Apply override"}
                </button>
                {lastOverrideAppliedAt && (
                  <span className="review-queue-panel-muted">
                    Applied {new Date(lastOverrideAppliedAt).toLocaleTimeString()}
                  </span>
                )}
                {overrideError && <span className="review-queue-panel-error">{overrideError}</span>}
              </div>
              <p className="review-queue-panel-hint">
                Drag on-canvas handles to nudge crop or trim boxes; edges snap to book priors when
                close.
              </p>
            </div>
          </section>

          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Template inspector</div>
            <div className="review-queue-panel-stack">
              <div className="review-queue-card">
                <div className="review-queue-card-title">Template clusters</div>
                <div className="review-queue-card-body">
                  {currentTemplateCluster ? (
                    <span>
                      Assigned cluster: <strong>{currentTemplateCluster.id}</strong> •{" "}
                      {formatLayoutProfileLabel(currentTemplateCluster.pageType)}
                      {templateAssignmentConfidence !== undefined
                        ? ` • ${(templateAssignmentConfidence * 100).toFixed(0)}% confidence`
                        : ""}
                    </span>
                  ) : (
                    <span className="review-queue-panel-muted">
                      No template cluster assignment found for this page.
                    </span>
                  )}
                </div>
                {templateClusters.length > 0 ? (
                  <div className="review-queue-card-grid">
                    {templateClusters.map((cluster) => {
                      const isCurrent = currentTemplateCluster?.id === cluster.id;
                      return (
                        <div
                          key={cluster.id}
                          className={`review-queue-chip ${isCurrent ? "is-current" : ""}`}
                        >
                          <div className="review-queue-chip-title">
                            {cluster.id}
                            {isCurrent ? " • Current" : ""}
                          </div>
                          <div>{formatLayoutProfileLabel(cluster.pageType)}</div>
                          <div>
                            {cluster.pageIds.length} pages • {(cluster.confidence * 100).toFixed(0)}
                            %
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="review-queue-panel-muted">No template clusters available.</div>
                )}
                <div className="review-queue-panel-row">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleTemplateClusterAction("confirm")}
                    disabled={
                      isTemplateActionPending ||
                      interactionDisabled ||
                      (!currentTemplateCluster && !templateAssignmentId)
                    }
                    aria-label="Confirm template cluster"
                  >
                    {isTemplateActionPending ? "Saving…" : "Confirm cluster"}
                  </button>
                  <label className="review-queue-select">
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
                      interactionDisabled ||
                      !selectedTemplateClusterId ||
                      templateClusters.length === 0
                    }
                    aria-label="Correct template cluster"
                  >
                    {isTemplateActionPending ? "Saving…" : "Correct assignment"}
                  </button>
                  {templateActionStatus && (
                    <span className="review-queue-panel-muted">{templateActionStatus}</span>
                  )}
                  {templateActionError && (
                    <span className="review-queue-panel-error">{templateActionError}</span>
                  )}
                </div>
              </div>
              {templateSummary ? (
                <div className="review-queue-card">
                  <div className="review-queue-card-title">Layout template summary</div>
                  <div className="review-queue-card-body">
                    <strong>{templateSummary.label}</strong>
                    <div className="review-queue-panel-muted">
                      {templateSummary.pages.length} pages • Avg{" "}
                      {(templateSummary.averageConfidence * 100).toFixed(0)}% • Min{" "}
                      {(templateSummary.minConfidence * 100).toFixed(0)}%
                    </div>
                    <div className="review-queue-panel-muted">
                      Guide coverage: {(templateSummary.guideCoverage * 100).toFixed(0)}%
                    </div>
                    <div>
                      {templateSummary.issueSummary.length === 0 ? (
                        <span className="review-queue-panel-muted">No recurring issues.</span>
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
                <p className="review-queue-panel-muted">
                  No layout template summary available for this page.
                </p>
              )}
              <div className="review-queue-card">
                <div className="review-queue-card-title">Representative pages</div>
                <div className="review-queue-card-grid">
                  {representativePages.map((page) => {
                    const preview =
                      page.previews.overlay ?? page.previews.normalized ?? page.previews.source;
                    const previewSrc = resolvePreviewSrc(preview);
                    return (
                      <div key={page.id} className="review-queue-thumb">
                        {previewSrc ? (
                          <img src={previewSrc} alt={`Preview for ${page.filename}`} />
                        ) : (
                          <div className="review-queue-panel-muted">No preview</div>
                        )}
                        <div className="review-queue-thumb-label">{page.filename}</div>
                      </div>
                    );
                  })}
                  {representativePages.length === 0 && (
                    <div className="review-queue-panel-muted">
                      No representative pages available.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="review-queue-panel">
            <div className="review-queue-panel-title">Baseline grid</div>
            <div className="review-queue-panel-stack">
              <div className="review-queue-grid-three">
                <label className="review-queue-field">
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
                <label className="review-queue-field">
                  <span>Offset (px)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={baselineOffsetPx ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      const parsed = Number(value);
                      setBaselineOffsetPx(value === "" || !Number.isFinite(parsed) ? null : parsed);
                    }}
                  />
                </label>
                <label className="review-queue-field">
                  <span>Angle (°)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={baselineAngleDeg ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      const parsed = Number(value);
                      setBaselineAngleDeg(value === "" || !Number.isFinite(parsed) ? null : parsed);
                    }}
                  />
                </label>
              </div>
              <div className="review-queue-panel-row">
                <label className="review-queue-toggle">
                  <input
                    type="checkbox"
                    checked={baselineSnapToPeaks}
                    onChange={(event) => setBaselineSnapToPeaks(event.target.checked)}
                  />
                  <span>Snap to peaks</span>
                </label>
                <label className="review-queue-toggle">
                  <input
                    type="checkbox"
                    checked={baselineMarkCorrect}
                    onChange={(event) => setBaselineMarkCorrect(event.target.checked)}
                  />
                  <span>Mark correct</span>
                </label>
              </div>
              <div className="review-queue-panel-row">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onApplyOverride}
                  disabled={isApplyingOverride}
                >
                  {isApplyingOverride ? "Applying…" : "Apply override"}
                </button>
                {lastOverrideAppliedAt && (
                  <span className="review-queue-panel-muted">
                    Applied {new Date(lastOverrideAppliedAt).toLocaleTimeString()}
                  </span>
                )}
                {overrideError && <span className="review-queue-panel-error">{overrideError}</span>}
              </div>
              <p className="review-queue-panel-hint">
                Tune spacing, offset, and angle for the page baseline grid. Snap-to-peaks aligns to
                detected line clusters.
              </p>
            </div>
          </section>

          <section className="review-queue-panel review-queue-panel--decisions">
            <div className="review-queue-panel-title">Decisions</div>
            <div className="review-queue-panel-row">
              <button
                className={`btn ${decision === "accept" ? "btn-primary" : "btn-secondary"}`}
                onClick={onAccept}
                aria-label="Accept page (A)"
                disabled={interactionDisabled}
              >
                Accept <kbd className="review-kbd">A</kbd>
              </button>
              <button
                className={`btn ${decision === "flag" ? "btn-primary" : "btn-secondary"}`}
                onClick={onFlag}
                aria-label="Flag for later review (F)"
                disabled={interactionDisabled}
              >
                Flag <kbd className="review-kbd">F</kbd>
              </button>
              <button
                className={`btn ${decision === "reject" ? "btn-primary" : "btn-secondary"}`}
                onClick={onReject}
                aria-label="Reject page (R)"
                disabled={interactionDisabled}
              >
                Reject <kbd className="review-kbd">R</kbd>
              </button>
              {decision && (
                <button
                  className="btn btn-ghost"
                  onClick={onUndo}
                  aria-label="Undo decision (U)"
                  disabled={interactionDisabled}
                >
                  Undo <kbd className="review-kbd">U</kbd>
                </button>
              )}
            </div>
            <div className="review-queue-panel-row">
              <span className="review-queue-panel-hint">
                <kbd className="review-kbd">J</kbd>/<kbd className="review-kbd">K</kbd> navigate
              </span>
              <button
                className="btn btn-primary"
                onClick={onSubmit}
                disabled={!canSubmit || interactionDisabled}
                aria-disabled={!canSubmit || interactionDisabled}
                aria-label={
                  runId ? "Submit review decisions (Ctrl+Enter)" : "Run ID required to submit"
                }
              >
                {isSubmitting ? "Submitting…" : "Submit Review"}
              </button>
            </div>
            {submitError && <div className="review-queue-panel-error">{submitError}</div>}
          </section>
        </div>
      </aside>
      {(isBusy || isSidecarLoading) && (
        <div className="review-queue-busy-overlay" role="status" aria-live="polite">
          <div className="review-queue-busy-card">
            <div className="review-queue-spinner" aria-hidden="true" />
            <div className="review-queue-busy-title">Processing</div>
            <div className="review-queue-busy-subtitle">{busyMessage}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export function ReviewQueueScreen({
  runId,
  runDir,
}: Readonly<ReviewQueueScreenProps>): JSX.Element {
  const { pages, isLoading: isQueueLoading } = useReviewQueuePages(runId, runDir);
  const queuePages = useQueueWorker(pages);
  const { selectedIndex, setSelectedIndex } = useQueueSelection(queuePages);
  const { listRef, scrollTop, setScrollTop, viewportHeight } = useQueueViewport(selectedIndex);
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [decisions, setDecisions] = useState<Map<string, DecisionValue>>(new Map());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSourcePreview, setShowSourcePreview] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const currentPage = queuePages[selectedIndex];
  const {
    sidecar,
    sidecarError,
    isLoading: isSidecarLoading,
  } = useSidecarData(runId, runDir, currentPage);
  const derivedDimensions = useMemo(() => derivePreviewDimensions(sidecar), [sidecar]);
  const fallbackNormalizedPreview = useMemo((): PreviewRef | undefined => {
    if (!runDir || !currentPage || !derivedDimensions) return undefined;
    return {
      path: buildRunPreviewPath(runDir, currentPage.id, "normalized"),
      width: derivedDimensions.width,
      height: derivedDimensions.height,
    };
  }, [currentPage, derivedDimensions, runDir]);
  const normalizedPreview =
    currentPage?.previews.normalized ?? fallbackNormalizedPreview ?? undefined;
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
  const normalizedSrc =
    resolvePreviewSrc(normalizedPreview) ||
    (runDir && currentPage
      ? resolvePreviewSrc({
          path: buildRunPreviewPath(runDir, currentPage.id, "normalized"),
          width: 0,
          height: 0,
        })
      : undefined);
  const sourceSrc =
    resolvePreviewSrc(sourcePreview) ||
    (runDir && currentPage
      ? resolvePreviewSrc({
          path: buildRunPreviewPath(runDir, currentPage.id, "source"),
          width: 0,
          height: 0,
        })
      : undefined);
  const activeCropBox = cropBox ?? sidecar?.normalization?.cropBox ?? null;
  const activeTrimBox = trimBox ?? null;
  const overlayScale = calculateOverlayScale(
    sidecar,
    normalizedPreview ?? fallbackNormalizedPreview
  );
  const overlayScaleX = overlayScale?.x ?? 1;
  const overlayScaleY = overlayScale?.y ?? 1;
  const overlayPreview = normalizedPreview ?? fallbackNormalizedPreview;
  const overlaySvg = buildOverlaySvg({
    sidecar,
    normalizedPreview: overlayPreview,
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
  const isBusy = isSubmitting || isApplyingOverride || isTemplateActionPending;

  return (
    <ReviewQueueLayout
      runId={runId}
      queuePages={queuePages}
      currentPage={currentPage}
      isQueueLoading={isQueueLoading}
      selectedIndex={selectedIndex}
      decisions={decisions}
      overlaysVisible={overlaysVisible}
      showSourcePreview={showSourcePreview}
      inspectorOpen={inspectorOpen}
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
      isSidecarLoading={isSidecarLoading}
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
      isBusy={isBusy}
      onApplyScopeChange={setApplyScope}
      onSelectIndex={setSelectedIndex}
      onScroll={setScrollTop}
      onToggleSelected={toggleSelected}
      onToggleOverlays={() => setOverlaysVisible(!overlaysVisible)}
      onToggleSource={() => setShowSourcePreview(!showSourcePreview)}
      onToggleInspector={() => setInspectorOpen((prev) => !prev)}
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
