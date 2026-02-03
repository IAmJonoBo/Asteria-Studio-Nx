import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { RunProgressEvent } from "../../ipc/contracts.js";

interface RunProgressState {
  latest: RunProgressEvent;
  stages: Record<string, RunProgressEvent>;
}

const isStageError = (stage: string): boolean => {
  const lowered = stage.toLowerCase();
  return lowered.includes("error") || lowered.includes("cancel");
};

export function MonitorScreen(): JSX.Element {
  const [progressByRun, setProgressByRun] = useState<Record<string, RunProgressState>>({});

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
        return {
          ...prev,
          [event.runId]: { latest: event, stages },
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
          ⚡
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
          const stageEntries = Object.values(runState.stages).sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );

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
                  <div
                    style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-secondary)" }}
                  >
                    {run.processed.toLocaleString()} / {run.total.toLocaleString()} pages
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    {run.throughput ? `${run.throughput.toFixed(1)} pages/sec` : "Calculating…"}
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
                  <div
                    style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "6px" }}
                  >
                    Updated {new Date(run.timestamp).toLocaleTimeString()}
                  </div>
                </div>
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
                        {stageEvent.processed.toLocaleString()} / {stageEvent.total.toLocaleString()}
                      </div>
                      <div>{new Date(stageEvent.timestamp).toLocaleTimeString()}</div>
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
