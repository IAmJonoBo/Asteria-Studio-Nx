import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  IpcResult,
  ProjectSummary,
  RunConfigSnapshot,
  RunProgressEvent,
  RunSummary,
} from "../../ipc/contracts.js";
import { unwrapIpcResultOr } from "../utils/ipc.js";
import { Icon } from "../components/Icon.js";

interface RunsScreenProps {
  selectedRunId?: string;
  selectedRunDir?: string;
  onSelectRun: (runId: string, runDir: string) => void;
  onOpenReviewQueue: () => void;
  onClearSelection?: () => void;
  runProgressById?: Record<string, RunProgressEvent>;
}

export function RunsScreen({
  selectedRunId,
  selectedRunDir,
  onSelectRun,
  onOpenReviewQueue,
  onClearSelection,
  runProgressById,
}: Readonly<RunsScreenProps>): JSX.Element {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runConfig, setRunConfig] = useState<RunConfigSnapshot | null>(null);
  const [runConfigError, setRunConfigError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [deleteBusy, setDeleteBusy] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState<"refresh" | "history" | "delete" | null>(null);
  const selectedRun = runs.find((run) => run.runId === selectedRunId);
  const resolvedConfig = runConfig?.resolvedConfig;
  const projectById = new Map(projects.map((project) => [project.id, project]));

  const formatStageLabel = (stage: string): string =>
    stage
      .split(/[-_]+/)
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");

  const refreshRuns = async (): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const listRuns = windowRef.asteria.ipc["asteria:list-runs"] as
      | (() => Promise<import("../../ipc/contracts.js").IpcResult<RunSummary[]>>)
      | undefined;
    const data: IpcResult<RunSummary[]> = listRuns ? await listRuns() : { ok: true, value: [] };
    if (!data.ok) {
      setError(data.error.message);
      return;
    }
    setError(null);
    setRuns(unwrapIpcResultOr(data, []));
  };

  const handleDeleteRun = async (run: RunSummary): Promise<void> => {
    const projectName = projectById.get(run.projectId)?.name ?? run.projectId;
    const confirmed = globalThis.confirm(
      `Delete run ${run.runId} for ${projectName}? This will remove all artifacts.`
    );
    if (!confirmed) return;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    const deleteRun = windowRef.asteria?.ipc?.["asteria:delete-run"] as
      | ((runId: string) => Promise<import("../../ipc/contracts.js").IpcResult<void>>)
      | undefined;
    if (!deleteRun) return;
    setDeleteBusy((prev) => ({ ...prev, [run.runId]: true }));
    try {
      const result = await deleteRun(run.runId);
      if (!result.ok) throw new Error(result.error.message);
      await refreshRuns();
      if (run.runId === selectedRunId) {
        onClearSelection?.();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete run";
      globalThis.alert(message);
    } finally {
      setDeleteBusy((prev) => ({ ...prev, [run.runId]: false }));
    }
  };

  const handleClearHistory = async (removeArtifacts: boolean): Promise<void> => {
    const message = removeArtifacts
      ? "Delete all run artifacts and clear history? This cannot be undone."
      : "Clear run history? Artifacts will stay on disk but will no longer appear here.";
    const confirmed = globalThis.confirm(message);
    if (!confirmed) return;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    const clearHistory = windowRef.asteria?.ipc?.["asteria:clear-run-history"] as
      | ((
          options?: { removeArtifacts?: boolean }
        ) => Promise<import("../../ipc/contracts.js").IpcResult<{
          removedRuns: number;
          removedArtifacts: boolean;
        }>>)
      | undefined;
    if (!clearHistory) return;
    setBulkBusy(removeArtifacts ? "delete" : "history");
    try {
      const result = await clearHistory({ removeArtifacts });
      if (!result.ok) throw new Error(result.error.message);
      await refreshRuns();
      onClearSelection?.();
      globalThis.alert(
        result.value.removedRuns > 0
          ? `Cleared ${result.value.removedRuns} run${result.value.removedRuns === 1 ? "" : "s"}.`
          : "Run history is already empty."
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear run history";
      globalThis.alert(message);
    } finally {
      setBulkBusy(null);
    }
  };

  const handleRevealRun = async (run: RunSummary): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    const revealPath = windowRef.asteria?.ipc?.["asteria:reveal-path"] as
      | ((targetPath: string) => Promise<import("../../ipc/contracts.js").IpcResult<void>>)
      | undefined;
    if (!revealPath) return;
    try {
      const result = await revealPath(run.runDir);
      if (!result.ok) throw new Error(result.error.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reveal run folder";
      globalThis.alert(message);
    }
  };

  const handleRefreshRuns = async (): Promise<void> => {
    setBulkBusy("refresh");
    try {
      await refreshRuns();
    } finally {
      setBulkBusy(null);
    }
  };

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
          | (() => Promise<import("../../ipc/contracts.js").IpcResult<RunSummary[]>>)
          | undefined;
        const data: IpcResult<RunSummary[]> = listRuns ? await listRuns() : { ok: true, value: [] };
        if (!data.ok) {
          throw new Error(data.error.message);
        }
        if (!cancelled) {
          setRuns(unwrapIpcResultOr(data, []));
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
    const loadProjects = async (): Promise<void> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) return;
      try {
        const listProjects = windowRef.asteria.ipc["asteria:list-projects"] as
          | (() => Promise<import("../../ipc/contracts.js").IpcResult<ProjectSummary[]>>)
          | undefined;
        const data: IpcResult<ProjectSummary[]> = listProjects
          ? await listProjects()
          : { ok: true, value: [] };
        if (!data.ok) return;
        if (!cancelled) {
          setProjects(unwrapIpcResultOr(data, []));
        }
      } catch {
        if (!cancelled) {
          setProjects([]);
        }
      }
    };
    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadRunConfig = async (): Promise<void> => {
      if (!selectedRunId || !selectedRunDir) {
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
          | ((
              runId: string,
              runDir: string
            ) => Promise<import("../../ipc/contracts.js").IpcResult<RunConfigSnapshot | null>>)
          | undefined;
        const snapshotResult: IpcResult<RunConfigSnapshot | null> = getRunConfig
          ? await getRunConfig(selectedRunId, selectedRunDir)
          : { ok: true, value: null };
        if (!snapshotResult.ok) {
          throw new Error(snapshotResult.error.message);
        }
        if (!cancelled) {
          setRunConfig(unwrapIpcResultOr(snapshotResult, null));
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
  }, [selectedRunDir, selectedRunId]);

  if (isLoading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="loader" size={48} />
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
          <Icon name="alert" size={48} />
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
          <Icon name="chart" size={48} />
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
          gap: "16px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Run History</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: "14px" }}>
            Select a run to review flagged pages.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            className="btn btn-secondary"
            onClick={() => void handleRefreshRuns()}
            disabled={bulkBusy !== null}
          >
            {bulkBusy === "refresh" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void handleClearHistory(false)}
            disabled={bulkBusy !== null || runs.length === 0}
          >
            {bulkBusy === "history" ? "Clearing…" : "Clear History"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void handleClearHistory(true)}
            disabled={bulkBusy !== null || runs.length === 0}
          >
            {bulkBusy === "delete" ? "Deleting…" : "Delete All Runs"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        {runs.map((run) => {
          const progressEvent = runProgressById?.[run.runId];
          const showProgress =
            progressEvent && !["success", "error", "cancelled"].includes(run.status ?? "");
          const progressTotal = Math.max(1, progressEvent?.total ?? 1);
          const progressPercent = progressEvent
            ? Math.min(100, Math.round((progressEvent.processed / progressTotal) * 100))
            : null;
          return (
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
                    Project: {projectById.get(run.projectId)?.name ?? run.projectId}
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
                  {showProgress && progressEvent && (
                    <div
                      style={{
                        marginTop: "8px",
                        display: "grid",
                        gap: "6px",
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <div>
                        Live stage: {formatStageLabel(progressEvent.stage)} •{" "}
                        {progressEvent.processed.toLocaleString()} /{" "}
                        {progressEvent.total.toLocaleString()} pages (
                        {progressPercent?.toLocaleString() ?? 0}%)
                      </div>
                      <div
                        style={{
                          height: "6px",
                          background: "var(--bg-surface)",
                          borderRadius: "999px",
                          overflow: "hidden",
                          maxWidth: "240px",
                        }}
                        aria-hidden="true"
                      >
                        <div
                          style={{
                            width: `${progressPercent ?? 0}%`,
                            height: "100%",
                            background: "var(--color-accent)",
                          }}
                        />
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                        Updated {new Date(progressEvent.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  )}
                  {(run.inferredDimensionsMm || run.inferredDpi) && (
                    <div
                      style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-secondary)" }}
                    >
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
                  <div style={{ marginTop: "6px", fontSize: "13px" }}>
                    <strong>{run.reviewCount}</strong> pages in review queue
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onSelectRun(run.runId, run.runDir)}
                    aria-pressed={run.runId === selectedRunId}
                  >
                    {run.runId === selectedRunId ? "Selected" : "Select"}
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      onSelectRun(run.runId, run.runDir);
                      onOpenReviewQueue();
                    }}
                  >
                    Open Review Queue
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleRevealRun(run)}
                  >
                    Reveal Folder
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleDeleteRun(run)}
                    disabled={
                      Boolean(deleteBusy[run.runId]) ||
                      run.status === "running" ||
                      run.status === "queued" ||
                      run.status === "paused" ||
                      run.status === "cancelling"
                    }
                  >
                    {deleteBusy[run.runId] ? "Deleting…" : "Delete Run"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
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
          {selectedRun?.inferredDimensionsMm && (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "8px" }}>
              <strong>Inferred dimensions:</strong> {selectedRun.inferredDimensionsMm.width} ×{" "}
              {selectedRun.inferredDimensionsMm.height} mm
              {selectedRun.dimensionConfidence !== undefined
                ? ` (confidence ${selectedRun.dimensionConfidence.toFixed(2)})`
                : ""}
              {selectedRun.inferredDpi !== undefined && (
                <>
                  {" "}
                  • <strong>Inferred DPI:</strong> {Math.round(selectedRun.inferredDpi)}
                  {selectedRun.dpiConfidence !== undefined
                    ? ` (confidence ${selectedRun.dpiConfidence.toFixed(2)})`
                    : ""}
                </>
              )}
            </div>
          )}
          {runConfig && !resolvedConfig && !runConfigError && (
            <p style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
              Config snapshot missing resolved values for this run.
            </p>
          )}
          {resolvedConfig && (
            <div style={{ display: "grid", gap: "8px", fontSize: "12px" }}>
              <div>
                <strong>Target size:</strong> {resolvedConfig.project.target_dimensions.width} ×{" "}
                {resolvedConfig.project.target_dimensions.height}{" "}
                {resolvedConfig.project.target_dimensions.unit}
              </div>
              <div>
                <strong>DPI:</strong> {resolvedConfig.project.dpi}
              </div>
              <div>
                <strong>Spread split:</strong>{" "}
                {resolvedConfig.steps.spread_split.enabled ? "enabled" : "disabled"} (
                {resolvedConfig.steps.spread_split.confidence_threshold})
              </div>
              <div>
                <strong>QA mask coverage min:</strong> {resolvedConfig.steps.qa.mask_coverage_min}
              </div>
              <div>
                <strong>Semantic threshold (body):</strong>{" "}
                {resolvedConfig.steps.qa.semantic_thresholds.body}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
