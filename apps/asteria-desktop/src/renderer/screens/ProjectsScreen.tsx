import type { JSX } from "react";
import { useState } from "react";

interface Project {
  id: string;
  name: string;
  path: string;
  pageCount: number;
  lastRun?: string;
  status: "idle" | "processing" | "completed" | "error";
}

interface ProjectsScreenProps {
  onImportCorpus: () => void;
  onOpenProject: (projectId: string) => void;
  initialProjects?: Project[];
}

export function ProjectsScreen({
  onImportCorpus,
  onOpenProject,
  initialProjects,
}: Readonly<ProjectsScreenProps>): JSX.Element {
  // Mock data - will be replaced with IPC calls
  const [projects] = useState<Project[]>(
    initialProjects ?? [
      {
        id: "mind-myth-magick",
        name: "Mind, Myth and Magick",
        path: "projects/mind-myth-and-magick",
        pageCount: 783,
        lastRun: "2024-01-15T10:30:00Z",
        status: "completed",
      },
    ]
  );

  if (projects.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          📚
        </div>
        <h2 className="empty-state-title">No projects yet</h2>
        <p className="empty-state-description">
          Import a corpus of scanned pages to get started. Asteria will normalize page geometry,
          detect elements, and prepare publication-ready outputs with confidence scoring and QA
          workflows.
        </p>
        <button className="btn btn-primary btn-lg" onClick={onImportCorpus}>
          Import Corpus
        </button>
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
            Manage your corpus libraries and processing workflows
          </p>
        </div>
        <button className="btn btn-primary" onClick={onImportCorpus}>
          Import Corpus
        </button>
      </div>

      <div style={{ display: "grid", gap: "16px" }}>
        {projects.map((project) => (
          <div key={project.id} className="card" style={{ cursor: "pointer" }}>
            <button
              type="button"
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "16px",
                width: "100%",
                border: "none",
                background: "transparent",
                textAlign: "left",
                padding: 0,
                cursor: "pointer",
              }}
              onClick={() => onOpenProject(project.id)}
            >
              <div style={{ flex: 1 }}>
                <h3 className="card-title">{project.name}</h3>
                <p style={{ margin: "0 0 8px", fontSize: "12px", color: "var(--text-secondary)" }}>
                  {project.path}
                </p>
                <div style={{ display: "flex", gap: "12px", fontSize: "13px" }}>
                  <span>
                    <strong>{project.pageCount.toLocaleString()}</strong> pages
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
                <span className="btn btn-secondary btn-sm" aria-hidden="true">
                  Open →
                </span>
              </div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
