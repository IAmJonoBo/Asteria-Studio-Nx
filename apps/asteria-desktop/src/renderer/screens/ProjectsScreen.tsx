import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { ProjectSummary, RunProgressEvent } from "../../ipc/contracts.js";
import { Icon } from "../components/Icon.js";

interface ProjectsScreenProps {
  onImportCorpus: () => void;
  onOpenProject: (projectId: string) => void;
  onStartRun: (project: ProjectSummary) => void;
  projects?: ProjectSummary[];
  isLoading?: boolean;
  error?: string | null;
  importState?: {
    status: "idle" | "working" | "success" | "error";
    message?: string;
  };
  activeRunId?: string;
  activeRunProgress?: RunProgressEvent | null;
}

export function ProjectsScreen({
  onImportCorpus,
  onOpenProject,
  onStartRun,
  projects = [],
  isLoading = false,
  error = null,
  importState,
  activeRunId,
  activeRunProgress,
}: Readonly<ProjectsScreenProps>): JSX.Element {
  const STALE_RUN_AGE_MS = 1000 * 60 * 60 * 24 * 30;
  const isImporting = importState?.status === "working";
  const importMessage = importState?.message;
  const runBlocked = Boolean(activeRunId);
  const [runsByProject, setRunsByProject] = useState<Record<string, Array<{
    runId: string;
    projectId: string;
    generatedAt?: string;
    status?: string;
  }>>>({});
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runOperationByProject, setRunOperationByProject] = useState<Record<string, string>>({});
  const progressTotal = Math.max(1, activeRunProgress?.total ?? 1);
  const progressPercent = activeRunProgress
    ? Math.min(100, Math.round((activeRunProgress.processed / progressTotal) * 100))
    : null;
  const recentPages = activeRunProgress?.recentPageIds ?? [];
  const currentPageId = activeRunProgress?.currentPageId;
  const formatStageLabel = (stage: string): string =>
    stage
      .split(/[-_]+/)
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  const noticeTone =
    importState?.status === "error"
      ? "error"
      : importState?.status === "success"
        ? "success"
        : importState?.status === "working"
        ? "working"
          : "info";

  const loadRuns = useCallback(async (): Promise<void> => {
    const windowRef: typeof globalThis & {
      asteria?: { ipc?: Record<string, unknown> };
    } = globalThis;
    const listRuns = windowRef.asteria?.ipc?.["asteria:list-runs"] as
      | (() => Promise<import("../../ipc/contracts.js").IpcResult<
          Array<{ runId: string; projectId: string; generatedAt?: string; status?: string }>
        >>)
      | undefined;
    if (!listRuns) {
      setRunsByProject({});
      return;
    }
    setRunsLoading(true);
    try {
      const result = await listRuns();
      if (!result.ok) throw new Error(result.error.message);
      const grouped = result.value.reduce<
        Record<string, Array<{ runId: string; projectId: string; generatedAt?: string; status?: string }>>
      >((acc, run) => {
        const group = acc[run.projectId] ?? [];
        group.push({
          runId: run.runId,
          projectId: run.projectId,
          generatedAt: run.generatedAt,
          status: run.status,
        });
        acc[run.projectId] = group;
        return acc;
      }, {});
      Object.values(grouped).forEach((group) =>
        group.sort(
          (a, b) =>
            new Date(b.generatedAt ?? 0).getTime() - new Date(a.generatedAt ?? 0).getTime()
        )
      );
      setRunsByProject(grouped);
      setRunsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load run history";
      setRunsError(message);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!activeRunId) return;
    const intervalId = globalThis.setInterval(() => {
      void loadRuns();
    }, 5000);
    return (): void => {
      globalThis.clearInterval(intervalId);
    };
  }, [activeRunId, loadRuns]);

  const handleDeleteProjectRuns = useCallback(
    async (projectId: string, staleOnly: boolean): Promise<void> => {
      const runs = runsByProject[projectId] ?? [];
      const now = Date.now();
      const targetRuns = runs.filter((run) => {
        if (!staleOnly) return run.runId !== activeRunId;
        const ageMs = now - new Date(run.generatedAt ?? 0).getTime();
        return ageMs >= STALE_RUN_AGE_MS && run.runId !== activeRunId;
      });
      if (targetRuns.length === 0) return;
      const confirmed = globalThis.confirm(
        staleOnly
          ? `Delete ${targetRuns.length} stale run${targetRuns.length === 1 ? "" : "s"} for this project?`
          : `Delete all ${targetRuns.length} run${targetRuns.length === 1 ? "" : "s"} for this project?`
      );
      if (!confirmed) return;
      const windowRef: typeof globalThis & {
        asteria?: { ipc?: Record<string, unknown> };
      } = globalThis;
      const deleteRun = windowRef.asteria?.ipc?.["asteria:delete-run"] as
        | ((runId: string) => Promise<import("../../ipc/contracts.js").IpcResult<void>>)
        | undefined;
      if (!deleteRun) return;
      setRunOperationByProject((prev) => ({
        ...prev,
        [projectId]: staleOnly ? "Deleting stale runs…" : "Deleting runs…",
      }));
      try {
        for (const run of targetRuns) {
          const result = await deleteRun(run.runId);
          if (!result.ok) throw new Error(result.error.message);
        }
        setRunOperationByProject((prev) => ({
          ...prev,
          [projectId]: `Deleted ${targetRuns.length} run${targetRuns.length === 1 ? "" : "s"}.`,
        }));
        await loadRuns();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete project runs";
        setRunOperationByProject((prev) => ({
          ...prev,
          [projectId]: message,
        }));
      }
    },
    [STALE_RUN_AGE_MS, activeRunId, loadRuns, runsByProject]
  );

  const runsMetaByProject = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(runsByProject).map(([projectId, runs]) => {
          const now = Date.now();
          const staleCount = runs.filter(
            (run) => now - new Date(run.generatedAt ?? 0).getTime() >= STALE_RUN_AGE_MS
          ).length;
          return [
            projectId,
            {
              count: runs.length,
              staleCount,
              latest: runs[0],
            },
          ];
        })
      ),
    [STALE_RUN_AGE_MS, runsByProject]
  );
  if (isLoading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="loader" size={48} />
        </div>
        <h2 className="empty-state-title">Loading projects…</h2>
        <p className="empty-state-description">Fetching available corpora.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="alert" size={48} />
        </div>
        <h2 className="empty-state-title">Projects unavailable</h2>
        <p className="empty-state-description">{error}</p>
        <button className="btn btn-primary btn-lg" onClick={onImportCorpus} disabled={isImporting}>
          {isImporting ? "Importing…" : "Import Corpus"}
        </button>
        {importMessage && (
          <div className={`notice notice-${noticeTone}`} role="status">
            {importMessage}
          </div>
        )}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          <Icon name="book" size={48} />
        </div>
        <h2 className="empty-state-title">No projects yet</h2>
        <p className="empty-state-description">
          Import a corpus of scanned pages to get started. Use the directory picker to choose a
          folder of page images, and Asteria will normalize page geometry, detect elements, and
          prepare publication-ready outputs with confidence scoring and QA workflows.
        </p>
        <button className="btn btn-primary btn-lg" onClick={onImportCorpus} disabled={isImporting}>
          {isImporting ? "Importing…" : "Import Corpus"}
        </button>
        {importMessage && (
          <div className={`notice notice-${noticeTone}`} role="status">
            {importMessage}
          </div>
        )}
        <div style={{ marginTop: "24px", fontSize: "12px", color: "var(--text-tertiary)" }}>
          <p style={{ margin: "0 0 8px" }}>
            <strong>What you need:</strong>
          </p>
          <ul
            style={{
              textAlign: "left",
              display: "inline-block",
              margin: 0,
              paddingLeft: "20px",
            }}
          >
            <li>Folder of page images (JPEG, PNG, or TIFF)</li>
            <li>Target dimensions and DPI</li>
            <li>A few minutes to process</li>
          </ul>
        </div>
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
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Projects</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: "14px" }}>
            Manage your corpus libraries and processing workflows with the directory picker
          </p>
        </div>
        <button className="btn btn-primary" onClick={onImportCorpus} disabled={isImporting}>
          {isImporting ? "Importing…" : "Import Corpus"}
        </button>
      </div>
      {importMessage && (
        <div className={`notice notice-${noticeTone}`} role="status">
          {importMessage}
        </div>
      )}
      {runBlocked && (
        <div className="notice notice-working" role="status">
          <div>Run in progress ({activeRunId}).</div>
          {activeRunProgress && (
            <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
              Stage: {formatStageLabel(activeRunProgress.stage)} •{" "}
              {activeRunProgress.processed.toLocaleString()} /{" "}
              {activeRunProgress.total.toLocaleString()} pages ({progressPercent ?? 0}%)
              <div
                style={{
                  marginTop: "6px",
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
            </div>
          )}
          <div style={{ marginTop: "6px" }}>Cancel it in Live Monitor to start another run.</div>
        </div>
      )}

      <div style={{ display: "grid", gap: "16px" }}>
        {projects.map((project) => {
          const projectMeta = runsMetaByProject[project.id] as
            | {
                count: number;
                staleCount: number;
                latest?: { runId: string; generatedAt?: string; status?: string };
              }
            | undefined;
          const runSummaryText = !projectMeta
            ? runsLoading
              ? "Loading run history…"
              : "No tracked runs yet."
            : `${projectMeta.count} run${projectMeta.count === 1 ? "" : "s"} tracked${
                projectMeta.staleCount > 0
                  ? ` • ${projectMeta.staleCount} stale run${projectMeta.staleCount === 1 ? "" : "s"}`
                  : ""
              }${
                projectMeta.latest
                  ? ` • latest ${projectMeta.latest.runId}${
                      projectMeta.latest.status ? ` (${projectMeta.latest.status})` : ""
                    }`
                  : ""
              }`;
          return (
          <div key={project.id} className="card">
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div style={{ flex: 1 }}>
                <h3 className="card-title">{project.name}</h3>
                <p style={{ margin: "0 0 8px", fontSize: "12px", color: "var(--text-secondary)" }}>
                  {project.inputPath}
                </p>
                <div style={{ display: "flex", gap: "12px", fontSize: "13px" }}>
                  <span>
                    <strong>{project.pageCount?.toLocaleString() ?? "—"}</strong> pages
                    {recentPages.length > 0 && activeRunProgress?.projectId === project.id && (
                      <div className="run-progress-activity" style={{ marginTop: "10px" }}>
                        <div className="run-progress-activity-title">Live page stream</div>
                        <div className="run-progress-activity-stream" role="list">
                          {recentPages.map((pageId) => (
                            <div
                              key={`project-run-${pageId}`}
                              className={`run-progress-chip${pageId === currentPageId ? " active" : ""}`}
                              role="listitem"
                            >
                              <span>{pageId}</span>
                              <span>{formatStageLabel(activeRunProgress?.stage ?? "")}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </span>
                  {project.lastRun && (
                    <span style={{ color: "var(--text-secondary)" }}>
                      Last run: {new Date(project.lastRun).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-secondary)" }}>
                  {runSummaryText}
                </div>
                {runOperationByProject[project.id] && (
                  <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
                    {runOperationByProject[project.id]}
                  </div>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: "8px",
                }}
              >
                {project.status === "completed" && (
                  <span className="badge badge-success">Completed</span>
                )}
                {project.status === "processing" && (
                  <span className="badge badge-info">Processing</span>
                )}
                {project.status === "error" && <span className="badge badge-error">Error</span>}
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onOpenProject(project.id)}
                  >
                    Run history
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleDeleteProjectRuns(project.id, true)}
                    disabled={
                      projectMeta?.staleCount === 0 ||
                      Boolean(activeRunId && activeRunProgress?.projectId === project.id)
                    }
                  >
                    Delete stale
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleDeleteProjectRuns(project.id, false)}
                    disabled={
                      projectMeta?.count === 0 ||
                      Boolean(activeRunId && activeRunProgress?.projectId === project.id)
                    }
                  >
                    Delete runs
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onStartRun(project)}
                    disabled={runBlocked}
                  >
                    Start Run
                  </button>
                </div>
              </div>
            </div>
          </div>
          );
        })}
      </div>
      {runsError && (
        <div className="notice notice-error" role="status">
          {runsError}
        </div>
      )}
    </div>
  );
}
