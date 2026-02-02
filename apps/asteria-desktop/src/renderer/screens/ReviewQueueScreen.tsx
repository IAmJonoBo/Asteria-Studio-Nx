import type { JSX, KeyboardEvent, MouseEvent, WheelEvent } from "react";
import { useState, useEffect, useRef } from "react";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcut";
import type { ReviewQueue, PageLayoutSidecar } from "../../ipc/contracts";

type PreviewRef = {
  path: string;
  width: number;
  height: number;
};

interface ReviewPage {
  id: string;
  filename: string;
  reason: string;
  confidence: number;
  previews: {
    source?: PreviewRef;
    normalized?: PreviewRef;
    overlay?: PreviewRef;
  };
  issues: string[];
}

interface ReviewQueueScreenProps {
  runId?: string;
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

type ReasonInfo = {
  label: string;
  explanation: string;
  severity: "info" | "warn" | "critical";
  action: string;
};

type OverlayLayersState = {
  pageBounds: boolean;
  cropBox: boolean;
  pageMask: boolean;
  textBlocks: boolean;
  titles: boolean;
  runningHeads: boolean;
  folios: boolean;
  ornaments: boolean;
};

type OverlayLayerKey = keyof OverlayLayersState;

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

const useReviewQueuePages = (runId?: string): ReviewPage[] => {
  const [pages, setPages] = useState<ReviewPage[]>([]);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadQueue = async (): Promise<void> => {
      const windowRef: typeof globalThis & {
        asteria?: { ipc?: { [key: string]: (runId: string) => Promise<ReviewQueue> } };
      } = globalThis;
      if (!runId || !windowRef.asteria?.ipc) {
        if (!cancelled) setPages([]);
        return;
      }
      try {
        const queue = await windowRef.asteria.ipc["asteria:fetch-review-queue"](runId);
        if (cancelled) return;
        setPages(mapReviewQueue(queue));
      } catch {
        if (!cancelled) setPages([]);
      }
    };
    loadQueue();
    return () => {
      cancelled = true;
    };
  }, [runId]);

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
    return () => {
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

const useQueueViewport = (selectedIndex: number) => {
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

const useSidecarData = (runId: string | undefined, currentPage: ReviewPage | undefined) => {
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
            [key: string]: (runId: string, pageId: string) => Promise<PageLayoutSidecar | null>;
          };
        };
      } = globalThis;
      if (!runId || !windowRef.asteria?.ipc) {
        setSidecar(null);
        setSidecarError(null);
        return;
      }
      try {
        const sidecarData = await windowRef.asteria.ipc["asteria:fetch-sidecar"](
          runId,
          currentPage.id
        );
        if (cancelled) return;
        setSidecar(sidecarData ?? null);
        setSidecarError(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load sidecar";
        setSidecarError(message);
        setSidecar(null);
      }
    };
    void loadSidecar();
    return () => {
      cancelled = true;
    };
  }, [currentPage, runId]);

  return { sidecar, sidecarError };
};

type OverlayRenderParams = {
  sidecar: PageLayoutSidecar | null;
  normalizedPreview?: PreviewRef;
  overlaysVisible: boolean;
  overlayLayers: OverlayLayersState;
  overlayScaleX: number;
  overlayScaleY: number;
};

const buildOverlaySvg = ({
  sidecar,
  normalizedPreview,
  overlaysVisible,
  overlayLayers,
  overlayScaleX,
  overlayScaleY,
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

  const cropBox = sidecar.normalization?.cropBox;
  const pageMask = sidecar.normalization?.pageMask;

  return (
    <svg
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      viewBox={`0 0 ${normalizedPreview.width} ${normalizedPreview.height}`}
    >
      {overlayLayers.cropBox && cropBox && (
        <rect
          x={cropBox[0] * overlayScaleX}
          y={cropBox[1] * overlayScaleY}
          width={(cropBox[2] - cropBox[0]) * overlayScaleX}
          height={(cropBox[3] - cropBox[1]) * overlayScaleY}
          fill="none"
          stroke="rgba(34, 197, 94, 0.9)"
          strokeWidth={2}
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
  overlayLayers: OverlayLayersState;
  selectedIds: Set<string>;
  listRef: { current: globalThis.HTMLDivElement | null };
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
  onSelectIndex: (index: number) => void;
  onScroll: (scrollTop: number) => void;
  onToggleSelected: (pageId: string) => void;
  onToggleOverlays: () => void;
  onToggleSource: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetView: () => void;
  onViewerMouseDown: (event: MouseEvent<globalThis.HTMLButtonElement>) => void;
  onViewerMouseMove: (event: MouseEvent<globalThis.HTMLButtonElement>) => void;
  onViewerMouseUp: () => void;
  onViewerWheel: (event: WheelEvent<globalThis.HTMLButtonElement>) => void;
  onViewerKeyDown: (event: KeyboardEvent<globalThis.HTMLButtonElement>) => void;
  onApplyDecisionToSelection: (decision: DecisionValue) => void;
  onAcceptSameReason: () => void;
  onToggleOverlayLayer: (layerKey: OverlayLayerKey, checked: boolean) => void;
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
  overlayLayers,
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
  onSelectIndex,
  onScroll,
  onToggleSelected,
  onToggleOverlays,
  onToggleSource,
  onZoomOut,
  onZoomIn,
  onResetView,
  onViewerMouseDown,
  onViewerMouseMove,
  onViewerMouseUp,
  onViewerWheel,
  onViewerKeyDown,
  onApplyDecisionToSelection,
  onAcceptSameReason,
  onToggleOverlayLayer,
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
          ✓
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
          ref={(node) => {
            listRef.current = node ?? null;
          }}
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
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
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
                  Apply override (planned)
                </button>
                <button className="btn btn-secondary btn-sm" disabled>
                  Reprocess selected (planned)
                </button>
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

export function ReviewQueueScreen({ runId }: Readonly<ReviewQueueScreenProps>): JSX.Element {
  const pages = useReviewQueuePages(runId);
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
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const currentPage = queuePages[selectedIndex];
  const { sidecar, sidecarError } = useSidecarData(runId, currentPage);
  const [overlayLayers, setOverlayLayers] = useState({
    pageBounds: true,
    cropBox: true,
    pageMask: false,
    textBlocks: true,
    titles: true,
    runningHeads: true,
    folios: true,
    ornaments: true,
  });

  const toggleSelected = createToggleSelected(setSelectedIds);
  const applyDecisionToSelection = createApplyDecisionToSelection(selectedIds, setDecisions);
  const acceptSameReason = createAcceptSameReason(currentPage, queuePages, setDecisions);
  const resetView = createResetView(setZoom, setPan);
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

  const handleSubmitReview = async (): Promise<void> => {
    const windowRef: typeof globalThis & {
      asteria?: { ipc?: { [key: string]: (runId: string, payload: unknown) => Promise<unknown> } };
    } = globalThis;
    if (!runId || !windowRef.asteria?.ipc || decisions.size === 0) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const payload = Array.from(decisions.entries()).map(([pageId, decisionValue]) => ({
        pageId,
        decision: decisionValue === "flag" ? "adjust" : decisionValue,
      }));
      await windowRef.asteria.ipc["asteria:submit-review"](runId, payload);
      setDecisions(new Map());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit review";
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  useKeyboardShortcuts([
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
      key: " ",
      handler: (): void => setOverlaysVisible(!overlaysVisible),
      description: "Toggle overlays",
    },
    {
      key: "Enter",
      ctrlKey: true,
      handler: (): void => {
        void handleSubmitReview();
      },
      description: "Submit review decisions",
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

  if (!runId) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          🗂️
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
  const normalizedPreview = currentPage?.previews.normalized;
  const sourcePreview = currentPage?.previews.source;
  const normalizedSrc = resolvePreviewSrc(normalizedPreview);
  const sourceSrc = resolvePreviewSrc(sourcePreview);
  const overlayOutputWidth = sidecar?.normalization?.cropBox
    ? sidecar.normalization.cropBox[2] + 1
    : (normalizedPreview?.width ?? 0);
  const overlayOutputHeight = sidecar?.normalization?.cropBox
    ? sidecar.normalization.cropBox[3] + 1
    : (normalizedPreview?.height ?? 0);
  const overlayScaleX =
    normalizedPreview && overlayOutputWidth > 0 ? normalizedPreview.width / overlayOutputWidth : 1;
  const overlayScaleY =
    normalizedPreview && overlayOutputHeight > 0
      ? normalizedPreview.height / overlayOutputHeight
      : 1;

  const overlaySvg = buildOverlaySvg({
    sidecar,
    normalizedPreview,
    overlaysVisible,
    overlayLayers,
    overlayScaleX,
    overlayScaleY,
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
      overlayLayers={overlayLayers}
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
      onSelectIndex={setSelectedIndex}
      onScroll={setScrollTop}
      onToggleSelected={toggleSelected}
      onToggleOverlays={() => setOverlaysVisible(!overlaysVisible)}
      onToggleSource={() => setShowSourcePreview(!showSourcePreview)}
      onZoomOut={() => zoomBy(-0.1)}
      onZoomIn={() => zoomBy(0.1)}
      onResetView={resetView}
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
      onAccept={handleAccept}
      onFlag={handleFlag}
      onReject={handleReject}
      onUndo={handleUndo}
      onSubmit={() => void handleSubmitReview()}
    />
  );
}
