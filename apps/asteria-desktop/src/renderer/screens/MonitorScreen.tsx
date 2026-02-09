import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { RunProgressEvent } from "../../ipc/contracts.js";
import { Icon } from "../components/Icon.js";

interface RunProgressState {
  latest: RunProgressEvent;
  stages: Record<string, RunProgressEvent>;
  throughputHistory: Array<{ ts: number; value: number }>;
}

const isStageError = (stage: string): boolean => {
  const lowered = stage.toLowerCase();
  return lowered.includes("error") || lowered.includes("cancel");
};

export function MonitorScreen(): JSX.Element {
  const [progressByRun, setProgressByRun] = useState<Record<string, RunProgressState>>({});
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});

  useEffect((): void | (() => void) => {
    const windowRef: typeof globalThis & {
      asteria?: { onRunProgress?: (handler: (event: RunProgressEvent) => void) => () => void };
    } = globalThis;
    if (!windowRef.asteria?.onRunProgress) return;
    const unsubscribe = windowRef.asteria.onRunProgress((event): void => {
      setProgressByRun((prev) => {
        const current = prev[event.runId];
        const stages = {
          ...(current?.stages ?? {}),
          [event.stage]: event,
        };
        const history = current?.throughputHistory ?? [];
        const nextHistory =
          typeof event.throughput === "number"
            ? [...history, { ts: Date.now(), value: event.throughput }].slice(-30)
            : history;
        return {
          ...prev,
          [event.runId]: { latest: event, stages, throughputHistory: nextHistory },
        };
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const runs = useMemo(
    () =>
      Object.values(progressByRun).sort(
        (a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime()
      ),
    [progressByRun]
  );

  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="bolt" size={48} />
        </div>
        <h2 className="empty-state-title">Live Run Monitor</h2>
        <p className="empty-state-description">
          Monitor active pipeline execution with real-time progress, stage breakdowns, and per-page
          status. Start a run to see live updates.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "24px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Live Monitor</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: "14px" }}>
            Real-time progress updates for active pipeline runs.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        {runs.map((runState) => {
          const run = runState.latest;
          const total = Math.max(1, run.total || 1);
          const progress = Math.min(100, Math.round((run.processed / total) * 100));
          const history = runState.throughputHistory;
          const avgThroughput =
            history.length > 0
              ? history.reduce((sum, entry) => sum + entry.value, 0) / history.length
              : (run.throughput ?? 0);
          const remaining = Math.max(0, total - run.processed);
          const etaSeconds = avgThroughput > 0 ? remaining / avgThroughput : null;
          const stageEntries = Object.values(runState.stages).sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          const hasActiveStage = !["complete", "cancelled", "error"].includes(run.stage);
          const isCancelling = Boolean(cancelling[run.runId]);

          return (
            <div key={run.runId} className="card" style={{ display: "grid", gap: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ flex: 1 }}>
                  <h3 className="card-title" style={{ marginBottom: "6px" }}>
                    {run.runId}
                  </h3>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    Project: {run.projectId}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    Stage: {run.stage}
                  </div>
                  {(run.inferredDimensionsMm || run.inferredDpi) && (
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      {run.inferredDimensionsMm && (
                        <div>
                          Inferred size: {run.inferredDimensionsMm.width} ×{" "}
                          {run.inferredDimensionsMm.height} mm
                          {run.dimensionConfidence !== undefined
                            ? ` (confidence ${run.dimensionConfidence.toFixed(2)})`
                            : ""}
                        </div>
                      )}
                      {run.inferredDpi !== undefined && (
                        <div>
                          Inferred DPI: {Math.round(run.inferredDpi)}
                          {run.dpiConfidence !== undefined
                            ? ` (confidence ${run.dpiConfidence.toFixed(2)})`
                            : ""}
                        </div>
                      )}
                    </div>
                  )}
                  <div
                    style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-secondary)" }}
                  >
                    {run.processed.toLocaleString()} / {run.total.toLocaleString()} pages
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    {avgThroughput > 0
                      ? `${avgThroughput.toFixed(1)} pages/sec (avg)`
                      : "Calculating throughput…"}
                  </div>
                  <div
                    style={{
                      marginTop: "8px",
                      width: "160px",
                      height: "6px",
                      background: "var(--bg-surface)",
                      borderRadius: "999px",
                      overflow: "hidden",
                    }}
                    aria-hidden="true"
                  >
                    <div
                      style={{
                        width: `${progress}%`,
                        height: "100%",
                        background: "var(--color-accent)",
                      }}
                    />
                  </div>
                  {etaSeconds !== null && (
                    <div
                      style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "6px" }}
                    >
                      ETA {Math.max(0, Math.round(etaSeconds))}s
                    </div>
                  )}
                  <div
                    style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "6px" }}
                  >
                    Updated {new Date(run.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              {history.length > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    Throughput history
                  </div>
                  <svg width="160" height="36" viewBox="0 0 160 36" aria-hidden="true">
                    <polyline
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeWidth="2"
                      points={((): string => {
                        const values = history.map((entry) => entry.value);
                        const max = Math.max(...values, 1);
                        const min = Math.min(...values, max);
                        return values
                          .map((value, index) => {
                            const x = (index / Math.max(1, values.length - 1)) * 160;
                            const norm = (value - min) / Math.max(1, max - min);
                            const y = 34 - norm * 30;
                            return `${x.toFixed(1)},${y.toFixed(1)}`;
                          })
                          .join(" ");
                      })()}
                    />
                  </svg>
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Run controls</div>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={!hasActiveStage || isCancelling}
                  onClick={async () => {
                    const confirmed = globalThis.confirm(
                      "Cancel this run and delete its artifacts? This cannot be undone."
                    );
                    if (!confirmed) return;
                    const windowRef: typeof globalThis & {
                      asteria?: { ipc?: Record<string, unknown> };
                    } = globalThis;
                    const cancelRun = windowRef.asteria?.ipc?.["asteria:cancel-run-and-delete"] as (
                      runId: string
                    ) => Promise<import("../../ipc/contracts.js").IpcResult<void>>;
                    if (!cancelRun) return;
                    setCancelling((prev) => ({ ...prev, [run.runId]: true }));
                    try {
                      const result = await cancelRun(run.runId);
                      if (!result.ok) throw new Error(result.error.message);
                    } catch (error) {
                      const message = error instanceof Error ? error.message : "Cancel failed";
                      globalThis.alert(message);
                    } finally {
                      setCancelling((prev) => ({ ...prev, [run.runId]: false }));
                    }
                  }}
                >
                  {isCancelling ? "Cancelling…" : "Cancel & Delete"}
                </button>
              </div>

              <div style={{ display: "grid", gap: "8px" }}>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  Stage breakdown
                </div>
                <div style={{ display: "grid", gap: "6px" }}>
                  {stageEntries.map((stageEvent) => (
                    <div
                      key={`${run.runId}-${stageEvent.stage}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr auto auto",
                        gap: "12px",
                        fontSize: "12px",
                        color: isStageError(stageEvent.stage)
                          ? "var(--color-error)"
                          : "var(--text-secondary)",
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "inherit" }}>{stageEvent.stage}</div>
                      <div>
                        {stageEvent.processed.toLocaleString()} /{" "}
                        {stageEvent.total.toLocaleString()}
                      </div>
                      <div>{new Date(stageEvent.timestamp).toLocaleTimeString()}</div>
                      <div
                        style={{
                          gridColumn: "1 / -1",
                          height: "4px",
                          background: "var(--bg-surface)",
                          borderRadius: "999px",
                          overflow: "hidden",
                        }}
                        aria-hidden="true"
                      >
                        <div
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round(
                                (stageEvent.processed / Math.max(1, stageEvent.total)) * 100
                              )
                            )}%`,
                            height: "100%",
                            background: isStageError(stageEvent.stage)
                              ? "var(--color-error)"
                              : "var(--color-accent)",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                {stageEntries.some((entry) => isStageError(entry.stage)) && (
                  <div style={{ fontSize: "12px", color: "var(--color-error)" }}>
                    Errors detected in recent stages. Review logs for details.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
