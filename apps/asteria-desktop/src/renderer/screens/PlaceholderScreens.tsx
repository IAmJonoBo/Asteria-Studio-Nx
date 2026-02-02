import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  RunSummary,
  RunConfigSnapshot,
  PipelineConfigSnapshot,
  PipelineConfigOverrides,
  RunProgressEvent,
} from "../../ipc/contracts";

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

  useEffect(() => {
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

  useEffect(() => {
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

export function MonitorScreen(): JSX.Element {
  const [progressByRun, setProgressByRun] = useState<Record<string, RunProgressEvent>>({});

  useEffect(() => {
    const windowRef: typeof globalThis & {
      asteria?: { onRunProgress?: (handler: (event: RunProgressEvent) => void) => () => void };
    } = globalThis;
    if (!windowRef.asteria?.onRunProgress) return;
    const unsubscribe = windowRef.asteria.onRunProgress((event) => {
      setProgressByRun((prev) => ({ ...prev, [event.runId]: event }));
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const runs = Object.values(progressByRun).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
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
        {runs.map((run) => {
          const total = Math.max(1, run.total || 1);
          const progress = Math.min(100, Math.round((run.processed / total) * 100));
          return (
            <div key={run.runId} className="card">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ExportsScreen(): JSX.Element {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [formats, setFormats] = useState({ png: true, tiff: false, pdf: false });
  const [isExporting, setIsExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadRuns = async (): Promise<void> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) return;
      try {
        const listRuns = windowRef.asteria.ipc["asteria:list-runs"] as
          | (() => Promise<RunSummary[]>)
          | undefined;
        const data = listRuns ? await listRuns() : [];
        if (!cancelled) {
          setRuns(data);
          setSelectedRunId((prev) => prev ?? data[0]?.runId ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load runs";
          setError(message);
        }
      }
    };
    void loadRuns();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleExport = async (): Promise<void> => {
    if (!selectedRunId) return;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const exportRun = windowRef.asteria.ipc["asteria:export-run"] as
      | ((runId: string, formats: Array<"png" | "tiff" | "pdf">) => Promise<string>)
      | undefined;
    if (!exportRun) return;
    const selectedFormats = Object.entries(formats)
      .filter(([, enabled]) => enabled)
      .map(([format]) => format) as Array<"png" | "tiff" | "pdf">;
    if (selectedFormats.length === 0) {
      setError("Select at least one format to export.");
      return;
    }
    setIsExporting(true);
    setExportPath(null);
    setError(null);
    try {
      const path = await exportRun(selectedRunId, selectedFormats);
      setExportPath(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      setError(message);
    } finally {
      setIsExporting(false);
    }
  };

  if (runs.length === 0 && !error) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          📦
        </div>
        <h2 className="empty-state-title">Exports</h2>
        <p className="empty-state-description">
          Run a pipeline to generate exports. Exports package normalized outputs with manifests and
          QA reports.
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
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Exports</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: "14px" }}>
            Package normalized outputs with manifests and QA reports.
          </p>
        </div>
      </div>

      <div className="card" style={{ display: "grid", gap: "16px" }}>
        <div>
          <label
            htmlFor="export-run-select"
            style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)" }}
          >
            Run
          </label>
          <select
            id="export-run-select"
            value={selectedRunId ?? ""}
            onChange={(event) => setSelectedRunId(event.target.value)}
            style={{ width: "100%", padding: "8px", marginTop: "6px" }}
          >
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId} — {run.projectId}
              </option>
            ))}
          </select>
        </div>

        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Formats</legend>
          <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
            {(["png", "tiff", "pdf"] as const).map((format) => (
              <label key={format} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={formats[format]}
                  onChange={(event) =>
                    setFormats((prev) => ({ ...prev, [format]: event.target.checked }))
                  }
                />
                <span style={{ fontSize: "12px" }}>{format.toUpperCase()}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button className="btn btn-primary" onClick={handleExport} disabled={isExporting}>
            {isExporting ? "Exporting…" : "Export Run"}
          </button>
          {exportPath && (
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              Export saved to {exportPath}
            </span>
          )}
        </div>
        {error && <div style={{ color: "var(--color-error)", fontSize: "12px" }}>{error}</div>}
      </div>
    </div>
  );
}

interface SettingsScreenProps {
  projectId?: string;
}

export function SettingsScreen({ projectId }: Readonly<SettingsScreenProps>): JSX.Element {
  const [snapshot, setSnapshot] = useState<PipelineConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formState, setFormState] = useState({
    dpi: "",
    width: "",
    height: "",
    spreadEnabled: false,
    spreadThreshold: "",
    bookPriorsEnabled: false,
    bookPriorsSample: "",
    qaMaskCoverageMin: "",
    qaSemanticBody: "",
  });

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async (): Promise<void> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) {
        if (!cancelled) setSnapshot(null);
        return;
      }
      try {
        const getConfig = windowRef.asteria.ipc["asteria:get-pipeline-config"] as
          | ((id?: string) => Promise<PipelineConfigSnapshot>)
          | undefined;
        const data = getConfig ? await getConfig(projectId) : null;
        if (!cancelled && data) {
          setSnapshot(data);
          setError(null);
          setFormState({
            dpi: String(data.resolvedConfig.project.dpi),
            width: String(data.resolvedConfig.project.target_dimensions.width),
            height: String(data.resolvedConfig.project.target_dimensions.height),
            spreadEnabled: data.resolvedConfig.steps.spread_split.enabled,
            spreadThreshold: String(data.resolvedConfig.steps.spread_split.confidence_threshold),
            bookPriorsEnabled: data.resolvedConfig.steps.book_priors.enabled,
            bookPriorsSample: String(data.resolvedConfig.steps.book_priors.sample_pages),
            qaMaskCoverageMin: String(data.resolvedConfig.steps.qa.mask_coverage_min),
            qaSemanticBody: String(data.resolvedConfig.steps.qa.semantic_thresholds.body),
          });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load config";
          setError(message);
        }
      }
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const parseNumberOrDefault = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const handleSaveOverrides = async (): Promise<void> => {
    if (!projectId || !snapshot) return;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const overrides: PipelineConfigOverrides = {
      project: {
        dpi: parseNumberOrDefault(formState.dpi, snapshot.resolvedConfig.project.dpi),
        target_dimensions: {
          width: parseNumberOrDefault(
            formState.width,
            snapshot.resolvedConfig.project.target_dimensions.width
          ),
          height: parseNumberOrDefault(
            formState.height,
            snapshot.resolvedConfig.project.target_dimensions.height
          ),
          unit: "mm",
        },
      },
      steps: {
        spread_split: {
          enabled: formState.spreadEnabled,
          confidence_threshold: parseNumberOrDefault(
            formState.spreadThreshold,
            snapshot.resolvedConfig.steps.spread_split.confidence_threshold
          ),
          gutter_min_width_px: snapshot.resolvedConfig.steps.spread_split.gutter_min_width_px,
          gutter_max_width_px: snapshot.resolvedConfig.steps.spread_split.gutter_max_width_px,
        },
        book_priors: {
          enabled: formState.bookPriorsEnabled,
          sample_pages: parseNumberOrDefault(
            formState.bookPriorsSample,
            snapshot.resolvedConfig.steps.book_priors.sample_pages
          ),
          max_trim_drift_px: snapshot.resolvedConfig.steps.book_priors.max_trim_drift_px,
          max_content_drift_px: snapshot.resolvedConfig.steps.book_priors.max_content_drift_px,
          min_confidence: snapshot.resolvedConfig.steps.book_priors.min_confidence,
        },
        qa: {
          mask_coverage_min: parseNumberOrDefault(
            formState.qaMaskCoverageMin,
            snapshot.resolvedConfig.steps.qa.mask_coverage_min
          ),
          semantic_thresholds: {
            ...snapshot.resolvedConfig.steps.qa.semantic_thresholds,
            body: parseNumberOrDefault(
              formState.qaSemanticBody,
              snapshot.resolvedConfig.steps.qa.semantic_thresholds.body
            ),
          },
        },
      },
    };
    setSaving(true);
    try {
      const saveConfig = windowRef.asteria.ipc["asteria:save-project-config"] as
        | ((id: string, overrides: PipelineConfigOverrides) => Promise<void>)
        | undefined;
      if (saveConfig) {
        await saveConfig(projectId, overrides);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save overrides";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleClearOverrides = async (): Promise<void> => {
    if (!projectId) return;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    setSaving(true);
    try {
      const saveConfig = windowRef.asteria.ipc["asteria:save-project-config"] as
        | ((id: string, overrides: PipelineConfigOverrides) => Promise<void>)
        | undefined;
      if (saveConfig) {
        await saveConfig(projectId, {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear overrides";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 style={{ margin: "0 0 8px", fontSize: "24px", fontWeight: 600 }}>Settings</h1>
      <p style={{ margin: "0 0 24px", color: "var(--text-secondary)", fontSize: "14px" }}>
        Pipeline configuration is sourced from spec defaults, optional project overrides, and
        environment overrides.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--color-error)" }}>
          <strong style={{ color: "var(--color-error)" }}>Config error</strong>
          <p style={{ marginTop: "8px" }}>{error}</p>
        </div>
      )}

      {!snapshot && !error && (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            🧭
          </div>
          <h2 className="empty-state-title">Config not loaded</h2>
          <p className="empty-state-description">Connect to the pipeline to view config.</p>
        </div>
      )}

      {snapshot && (
        <div style={{ display: "grid", gap: "16px", maxWidth: "860px" }}>
          <div className="card">
            <h3 className="card-title">Defaults (spec)</h3>
            <div style={{ display: "grid", gap: "8px", fontSize: "12px" }}>
              <div>
                <strong>Target size:</strong> {snapshot.baseConfig.project.target_dimensions.width}{" "}
                × {snapshot.baseConfig.project.target_dimensions.height}{" "}
                {snapshot.baseConfig.project.target_dimensions.unit}
              </div>
              <div>
                <strong>DPI:</strong> {snapshot.baseConfig.project.dpi}
              </div>
              <div>
                <strong>Spread split:</strong>{" "}
                {snapshot.baseConfig.steps.spread_split.enabled ? "enabled" : "disabled"} (
                {snapshot.baseConfig.steps.spread_split.confidence_threshold})
              </div>
            </div>
          </div>
          <div className="card">
            <h3 className="card-title">Resolved config</h3>
            <div style={{ display: "grid", gap: "8px", fontSize: "12px" }}>
              <div>
                <strong>Target size:</strong>{" "}
                {snapshot.resolvedConfig.project.target_dimensions.width} ×{" "}
                {snapshot.resolvedConfig.project.target_dimensions.height}{" "}
                {snapshot.resolvedConfig.project.target_dimensions.unit}
              </div>
              <div>
                <strong>DPI:</strong> {snapshot.resolvedConfig.project.dpi}
              </div>
              <div>
                <strong>Spread split:</strong>{" "}
                {snapshot.resolvedConfig.steps.spread_split.enabled ? "enabled" : "disabled"} (
                {snapshot.resolvedConfig.steps.spread_split.confidence_threshold})
              </div>
              <div>
                <strong>QA mask coverage min:</strong>{" "}
                {snapshot.resolvedConfig.steps.qa.mask_coverage_min}
              </div>
              <div>
                <strong>Semantic threshold (body):</strong>{" "}
                {snapshot.resolvedConfig.steps.qa.semantic_thresholds.body}
              </div>
            </div>
            <div style={{ marginTop: "12px", fontSize: "11px", color: "var(--text-tertiary)" }}>
              Source: {snapshot.sources.configPath}
              {snapshot.sources.projectConfigPath
                ? ` • Project override: ${snapshot.sources.projectConfigPath}`
                : ""}
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Project overrides</h3>
            {!projectId && (
              <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                Select a project to save overrides.
              </p>
            )}
            <div style={{ display: "grid", gap: "12px" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ fontSize: "13px", fontWeight: 500 }}>Target DPI</span>
                <input
                  type="number"
                  className="input"
                  value={formState.dpi}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, dpi: event.target.value }))
                  }
                  min={72}
                  max={1200}
                  aria-label="Project target DPI"
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500 }}>Width (mm)</span>
                  <input
                    type="number"
                    className="input"
                    value={formState.width}
                    onChange={(event) =>
                      setFormState((prev) => ({ ...prev, width: event.target.value }))
                    }
                    aria-label="Project target width"
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500 }}>Height (mm)</span>
                  <input
                    type="number"
                    className="input"
                    value={formState.height}
                    onChange={(event) =>
                      setFormState((prev) => ({ ...prev, height: event.target.value }))
                    }
                    aria-label="Project target height"
                  />
                </label>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <input
                  type="checkbox"
                  checked={formState.spreadEnabled}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, spreadEnabled: event.target.checked }))
                  }
                  aria-label="Enable spread split"
                />
                <span style={{ fontSize: "13px" }}>Enable spread split</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ fontSize: "13px", fontWeight: 500 }}>
                  Spread split confidence threshold
                </span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  max={1}
                  className="input"
                  value={formState.spreadThreshold}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, spreadThreshold: event.target.value }))
                  }
                  aria-label="Spread split confidence threshold"
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <input
                  type="checkbox"
                  checked={formState.bookPriorsEnabled}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, bookPriorsEnabled: event.target.checked }))
                  }
                  aria-label="Enable book priors"
                />
                <span style={{ fontSize: "13px" }}>Enable book priors</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ fontSize: "13px", fontWeight: 500 }}>Book priors sample pages</span>
                <input
                  type="number"
                  className="input"
                  value={formState.bookPriorsSample}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, bookPriorsSample: event.target.value }))
                  }
                  aria-label="Book priors sample pages"
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500 }}>
                    QA mask coverage minimum
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    className="input"
                    value={formState.qaMaskCoverageMin}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        qaMaskCoverageMin: event.target.value,
                      }))
                    }
                    aria-label="QA mask coverage minimum"
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500 }}>
                    Semantic threshold (body)
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    className="input"
                    value={formState.qaSemanticBody}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        qaSemanticBody: event.target.value,
                      }))
                    }
                    aria-label="Semantic threshold for body layout"
                  />
                </label>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => void handleSaveOverrides()}
                  disabled={!projectId || saving}
                >
                  {saving ? "Saving…" : "Save project overrides"}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => void handleClearOverrides()}
                  disabled={!projectId || saving}
                >
                  Clear overrides
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
