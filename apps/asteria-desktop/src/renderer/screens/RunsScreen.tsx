import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { RunConfigSnapshot, RunSummary } from "../../ipc/contracts.js";

interface RunsScreenProps {
  selectedRunId?: string;
  onSelectRun: (runId: string) => void;
  onOpenReviewQueue: () => void;
}

export function RunsScreen({
  selectedRunId,
  onSelectRun,
  onOpenReviewQueue,
}: Readonly<RunsScreenProps>): JSX.Element {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runConfig, setRunConfig] = useState<RunConfigSnapshot | null>(null);
  const [runConfigError, setRunConfigError] = useState<string | null>(null);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadRuns = async (): Promise<void> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) {
        if (!cancelled) {
          setRuns([]);
          setIsLoading(false);
        }
        return;
      }
      try {
        const listRuns = windowRef.asteria.ipc["asteria:list-runs"] as
          | (() => Promise<RunSummary[]>)
          | undefined;
        const data = listRuns ? await listRuns() : [];
        if (!cancelled) {
          setRuns(data);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load runs";
          setError(message);
          setIsLoading(false);
        }
      }
    };
    loadRuns();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadRunConfig = async (): Promise<void> => {
      if (!selectedRunId) {
        setRunConfig(null);
        setRunConfigError(null);
        return;
      }
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) {
        setRunConfig(null);
        setRunConfigError(null);
        return;
      }
      try {
        const getRunConfig = windowRef.asteria.ipc["asteria:get-run-config"] as
          | ((runId: string) => Promise<RunConfigSnapshot | null>)
          | undefined;
        const snapshot = getRunConfig ? await getRunConfig(selectedRunId) : null;
        if (!cancelled) {
          setRunConfig(snapshot);
          setRunConfigError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load run config";
          setRunConfigError(message);
        }
      }
    };
    void loadRunConfig();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  if (isLoading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          ⏳
        </div>
        <h2 className="empty-state-title">Loading runs…</h2>
        <p className="empty-state-description">Fetching recent pipeline runs.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          ⚠️
        </div>
        <h2 className="empty-state-title">Run history unavailable</h2>
        <p className="empty-state-description">{error}</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          📊
        </div>
        <h2 className="empty-state-title">No runs yet</h2>
        <p className="empty-state-description">
          Start a pipeline run from the Projects screen to generate reviewable outputs.
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
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Run History</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: "14px" }}>
            Select a run to review flagged pages.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        {runs.map((run) => (
          <div
            key={run.runId}
            className="card"
            style={{
              borderColor: run.runId === selectedRunId ? "var(--color-accent)" : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ flex: 1 }}>
                <h3 className="card-title" style={{ marginBottom: "6px" }}>
                  {run.runId}
                </h3>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  Project: {run.projectId}
                </div>
                {run.status && (
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    Status: {run.status}
                  </div>
                )}
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {run.generatedAt
                    ? `Generated ${new Date(run.generatedAt).toLocaleString()}`
                    : "Generated time unavailable"}
                </div>
                <div style={{ marginTop: "6px", fontSize: "13px" }}>
                  <strong>{run.reviewCount}</strong> pages in review queue
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onSelectRun(run.runId)}
                  aria-pressed={run.runId === selectedRunId}
                >
                  {run.runId === selectedRunId ? "Selected" : "Select"}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    onSelectRun(run.runId);
                    onOpenReviewQueue();
                  }}
                >
                  Open Review Queue
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedRunId && (
        <div className="card" style={{ marginTop: "16px" }}>
          <h3 className="card-title">Selected run config</h3>
          {runConfigError && (
            <p style={{ color: "var(--color-error)", fontSize: "12px" }}>{runConfigError}</p>
          )}
          {!runConfig && !runConfigError && (
            <p style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
              Config snapshot unavailable for this run.
            </p>
          )}
          {runConfig && (
            <div style={{ display: "grid", gap: "8px", fontSize: "12px" }}>
              <div>
                <strong>Target size:</strong>{" "}
                {runConfig.resolvedConfig.project.target_dimensions.width} ×{" "}
                {runConfig.resolvedConfig.project.target_dimensions.height}{" "}
                {runConfig.resolvedConfig.project.target_dimensions.unit}
              </div>
              <div>
                <strong>DPI:</strong> {runConfig.resolvedConfig.project.dpi}
              </div>
              <div>
                <strong>Spread split:</strong>{" "}
                {runConfig.resolvedConfig.steps.spread_split.enabled ? "enabled" : "disabled"} (
                {runConfig.resolvedConfig.steps.spread_split.confidence_threshold})
              </div>
              <div>
                <strong>QA mask coverage min:</strong>{" "}
                {runConfig.resolvedConfig.steps.qa.mask_coverage_min}
              </div>
              <div>
                <strong>Semantic threshold (body):</strong>{" "}
                {runConfig.resolvedConfig.steps.qa.semantic_thresholds.body}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
