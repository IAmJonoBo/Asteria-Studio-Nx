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
  const isImporting = importState?.status === "working";
  const importMessage = importState?.message;
  const runBlocked = Boolean(activeRunId);
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
          <div style={{ marginTop: "6px" }}>
            Cancel it in Live Monitor to start another run.
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: "16px" }}>
        {projects.map((project) => (
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
          {recentPages.length > 0 && (
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
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onOpenProject(project.id)}
                  >
                    Open →
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
        ))}
      </div>
    </div>
  );
}
