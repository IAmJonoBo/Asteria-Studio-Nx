import type { JSX } from "react";

export function RunsScreen(): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        📊
      </div>
      <h2 className="empty-state-title">Run History</h2>
      <p className="empty-state-description">
        View past pipeline runs, compare results, and restore previous configurations. Each run is
        tracked with a deterministic manifest showing all decisions and outputs.
      </p>
      <button className="btn btn-primary">Start New Run</button>
    </div>
  );
}

export function MonitorScreen(): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        ⚡
      </div>
      <h2 className="empty-state-title">Live Run Monitor</h2>
      <p className="empty-state-description">
        Monitor active pipeline execution with real-time progress, stage breakdowns, and per-page
        status. Pause, resume, or cancel operations with safe checkpointing.
      </p>
    </div>
  );
}

export function ExportsScreen(): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        📦
      </div>
      <h2 className="empty-state-title">Exports</h2>
      <p className="empty-state-description">
        Package normalized outputs with JSON sidecars, manifests, and QA reports. Choose formats
        (PNG, TIFF, PDF) and compression settings for delivery or archival.
      </p>
    </div>
  );
}

export function SettingsScreen(): JSX.Element {
  return (
    <div>
      <h1 style={{ margin: "0 0 8px", fontSize: "24px", fontWeight: 600 }}>Settings</h1>
      <p style={{ margin: "0 0 24px", color: "var(--text-secondary)", fontSize: "14px" }}>
        Configure pipeline defaults, performance, and UI preferences
      </p>

      <div style={{ display: "grid", gap: "16px", maxWidth: "800px" }}>
        <div className="card">
          <h3 className="card-title">Pipeline Defaults</h3>
          <div style={{ display: "grid", gap: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Target DPI</span>
              <input
                type="number"
                className="input"
                defaultValue={400}
                min={72}
                max={1200}
                aria-label="Default DPI for normalization"
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Confidence Threshold</span>
              <input
                type="range"
                min={0}
                max={100}
                defaultValue={50}
                aria-label="Minimum confidence to auto-accept"
              />
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Pages below this confidence route to review queue
              </span>
            </label>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Accessibility</h3>
          <div style={{ display: "grid", gap: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <input type="checkbox" defaultChecked aria-label="Show keyboard shortcuts" />
              <span style={{ fontSize: "13px" }}>Show keyboard shortcuts in tooltips</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <input type="checkbox" aria-label="Enable screen reader optimizations" />
              <span style={{ fontSize: "13px" }}>Enable screen reader optimizations</span>
            </label>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Performance</h3>
          <div style={{ display: "grid", gap: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Max Parallel Pages</span>
              <input
                type="number"
                className="input"
                defaultValue={4}
                min={1}
                max={16}
                aria-label="Maximum pages to process in parallel"
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <input type="checkbox" defaultChecked aria-label="Enable GPU acceleration" />
              <span style={{ fontSize: "13px" }}>Enable GPU acceleration (when available)</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
