import type { JSX } from "react";
import { useState, useEffect, useRef } from "react";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcut";
import type { ReviewQueue } from "../../ipc/contracts";

interface ReviewPage {
  id: string;
  filename: string;
  reason: string;
  confidence: number;
  thumbnailPath?: string;
  issues: string[];
}

interface ReviewQueueScreenProps {
  runId?: string;
}

type ReviewWorker = {
  postMessage: (message: { pages?: ReviewPage[] }) => void;
  terminate: () => void;
  onmessage: ((event: { data?: { pages?: ReviewPage[] } }) => void) | null;
};

const mapReviewQueue = (queue: ReviewQueue): ReviewPage[] => {
  return queue.items.map((item) => {
    const issues = item.qualityGate?.reasons ?? [];
    const reason = item.reason === "quality-gate" ? "Quality gate" : "Semantic layout";
    const preview = item.previews?.find((entry) => entry.kind === "normalized");
    return {
      id: item.pageId,
      filename: item.filename,
      reason,
      confidence: item.layoutConfidence,
      thumbnailPath: preview?.path,
      issues,
    };
  });
};

const FALLBACK_PAGES: ReviewPage[] = [
  {
    id: "page-001",
    filename: "page-001.jpg",
    reason: "Low crop confidence",
    confidence: 0.45,
    issues: ["Crop box uncertain", "Shadow detected on spine"],
  },
  {
    id: "page-042",
    filename: "page-042.jpg",
    reason: "High skew angle",
    confidence: 0.52,
    issues: ["Skew angle 4.2°", "Baseline inconsistency"],
  },
];

export function ReviewQueueScreen({ runId }: Readonly<ReviewQueueScreenProps>): JSX.Element {
  const [pages, setPages] = useState<ReviewPage[]>([]);
  const [queuePages, setQueuePages] = useState<ReviewPage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [decisions, setDecisions] = useState<Map<string, "accept" | "flag" | "reject">>(new Map());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const listRef = useRef<globalThis.HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const workerRef = useRef<ReviewWorker | null>(null);

  const ITEM_HEIGHT = 86;
  const OVERSCAN = 6;

  useEffect(() => {
    let cancelled = false;
    const loadQueue = async (): Promise<void> => {
      const windowRef: typeof globalThis & {
        asteria?: { ipc?: { [key: string]: (runId: string) => Promise<ReviewQueue> } };
      } = globalThis;
      if (!runId || !windowRef.asteria?.ipc) {
        if (!cancelled) setPages(FALLBACK_PAGES);
        return;
      }
      try {
        const queue = await windowRef.asteria.ipc["asteria:fetch-review-queue"](runId);
        if (cancelled) return;
        setPages(mapReviewQueue(queue));
      } catch {
        if (!cancelled) setPages(FALLBACK_PAGES);
      }
    };
    loadQueue();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
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
      postMessage: (message) => worker.postMessage(message),
      terminate: () => worker.terminate(),
      onmessage: null,
    };
    worker.onmessage = (event) => {
      setQueuePages(event.data?.pages ?? []);
      reviewWorker.onmessage?.(event);
    };
    workerRef.current = reviewWorker;
    return () => {
      reviewWorker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workerRef.current) {
      setQueuePages(pages);
    }
  }, [pages]);

  useEffect(() => {
    if (!workerRef.current) {
      setQueuePages(pages);
      return;
    }
    workerRef.current.postMessage({ pages });
  }, [pages]);

  useEffect(() => {
    if (queuePages.length === 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex > queuePages.length - 1) {
      setSelectedIndex(queuePages.length - 1);
    }
  }, [queuePages, selectedIndex]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const ResizeObserverCtor = globalThis.ResizeObserver;
    if (!ResizeObserverCtor) {
      setViewportHeight(container.clientHeight);
      return;
    }
    const resizeObserver = new ResizeObserverCtor(() => {
      setViewportHeight(container.clientHeight);
    });
    resizeObserver.observe(container);
    setViewportHeight(container.clientHeight);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
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

  const currentPage = queuePages[selectedIndex];
  const getDecisionBadgeClass = (decisionValue: "accept" | "flag" | "reject"): string => {
    if (decisionValue === "accept") return "badge-success";
    if (decisionValue === "flag") return "badge-warning";
    return "badge-error";
  };
  const getConfidenceColor = (confidence: number): string => {
    if (confidence < 0.5) return "var(--color-error)";
    if (confidence < 0.7) return "var(--color-warning)";
    return "var(--color-success)";
  };

  const handleAccept = (): void => {
    if (currentPage) {
      setDecisions((prev) => new Map(prev).set(currentPage.id, "accept"));
      if (selectedIndex < queuePages.length - 1) {
        setSelectedIndex(selectedIndex + 1);
      }
    }
  };

  const handleFlag = (): void => {
    if (currentPage) {
      setDecisions((prev) => new Map(prev).set(currentPage.id, "flag"));
      if (selectedIndex < queuePages.length - 1) {
        setSelectedIndex(selectedIndex + 1);
      }
    }
  };

  const handleReject = (): void => {
    if (currentPage) {
      setDecisions((prev) => new Map(prev).set(currentPage.id, "reject"));
      if (selectedIndex < queuePages.length - 1) {
        setSelectedIndex(selectedIndex + 1);
      }
    }
  };

  const handleUndo = (): void => {
    if (currentPage && decisions.has(currentPage.id)) {
      const newDecisions = new Map(decisions);
      newDecisions.delete(currentPage.id);
      setDecisions(newDecisions);
    }
  };

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
      handler: () => setSelectedIndex(Math.min(selectedIndex + 1, queuePages.length - 1)),
      description: "Next page",
    },
    {
      key: "k",
      handler: () => setSelectedIndex(Math.max(selectedIndex - 1, 0)),
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
      handler: () => setOverlaysVisible(!overlaysVisible),
      description: "Toggle overlays",
    },
    {
      key: "Enter",
      ctrlKey: true,
      handler: () => void handleSubmitReview(),
      description: "Submit review decisions",
    },
  ]);

  if (queuePages.length === 0) {
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

  const decision = currentPage ? decisions.get(currentPage.id) : undefined;
  const hasDecisions = decisions.size > 0;
  const canSubmit = Boolean(runId) && hasDecisions && !isSubmitting;
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
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            {visiblePages.map((page, offset) => {
              const index = startIndex + offset;
              const pageDecision = decisions.get(page.id);
              return (
                <button
                  key={page.id}
                  onClick={() => setSelectedIndex(index)}
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
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main review area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {currentPage && (
          <>
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
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
                  {currentPage.filename}
                </h3>
                <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--text-secondary)" }}>
                  Page {selectedIndex + 1} of {queuePages.length}
                </p>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setOverlaysVisible(!overlaysVisible)}
                  aria-pressed={overlaysVisible}
                >
                  {overlaysVisible ? "Hide" : "Show"} Overlays
                  <kbd style={{ marginLeft: "8px" }}>Space</kbd>
                </button>
              </div>
            </div>

            {/* Image viewer */}
            <div
              style={{
                flex: 1,
                background: "var(--bg-surface)",
                position: "relative",
                overflow: "auto",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "24px",
                  minHeight: "100%",
                }}
              >
                <div
                  style={{
                    background: "#888",
                    width: "600px",
                    height: "800px",
                    borderRadius: "8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: "14px",
                  }}
                >
                  Preview: {currentPage.filename}
                  {overlaysVisible && <div style={{ marginTop: "12px" }}>(Overlays visible)</div>}
                </div>
              </div>
            </div>

            {/* Action panel */}
            <div
              style={{
                padding: "16px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg-primary)",
              }}
            >
              <div style={{ marginBottom: "12px" }}>
                <strong style={{ fontSize: "13px" }}>Issues detected:</strong>
                <ul style={{ margin: "8px 0 0", paddingLeft: "20px", fontSize: "13px" }}>
                  {currentPage.issues.map((issue) => (
                    <li
                      key={`${currentPage.id}-${issue}`}
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>

              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button
                  className={`btn ${decision === "accept" ? "btn-primary" : "btn-secondary"}`}
                  onClick={handleAccept}
                  aria-label="Accept page (A)"
                >
                  Accept <kbd>A</kbd>
                </button>
                <button
                  className={`btn ${decision === "flag" ? "btn-primary" : "btn-secondary"}`}
                  onClick={handleFlag}
                  aria-label="Flag for later review (F)"
                >
                  Flag <kbd>F</kbd>
                </button>
                <button
                  className={`btn ${decision === "reject" ? "btn-primary" : "btn-secondary"}`}
                  onClick={handleReject}
                  aria-label="Reject page (R)"
                >
                  Reject <kbd>R</kbd>
                </button>
                <div style={{ flex: 1 }} />
                {decision && (
                  <button
                    className="btn btn-ghost"
                    onClick={handleUndo}
                    aria-label="Undo decision (U)"
                  >
                    Undo <kbd>U</kbd>
                  </button>
                )}
                <span style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
                  <kbd>J</kbd>/<kbd>K</kbd> navigate
                </span>
                <button
                  className="btn btn-primary"
                  onClick={() => void handleSubmitReview()}
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
          </>
        )}
      </div>
    </div>
  );
}
