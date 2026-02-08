import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  IpcResult,
  PipelineConfigOverrides,
  PipelineConfigSnapshot,
  RunSummary,
} from "../../ipc/contracts.js";
import { unwrapIpcResult, unwrapIpcResultOr } from "../utils/ipc.js";
import { Icon } from "../components/Icon.js";

interface SettingsScreenProps {
  projectId?: string;
}

export function SettingsScreen({ projectId }: Readonly<SettingsScreenProps>): JSX.Element {
  const [snapshot, setSnapshot] = useState<PipelineConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [latestInference, setLatestInference] = useState<RunSummary | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const [sizePreset, setSizePreset] = useState<"custom" | "a4" | "a5" | "letter">("custom");
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

  useEffect((): void | (() => void) => {
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
          | ((
              id?: string
            ) => Promise<import("../../ipc/contracts.js").IpcResult<PipelineConfigSnapshot>>)
          | undefined;
        if (!getConfig) {
          if (!cancelled) setSnapshot(null);
          return;
        }
        const data = await getConfig(projectId);
        if (!data.ok) {
          throw new Error(data.error.message);
        }
        const resolved = data.value;
        if (!cancelled && resolved) {
          setSnapshot(resolved);
          setError(null);
          const normalizedWidth = Math.round(
            resolved.resolvedConfig.project.target_dimensions.width
          );
          const normalizedHeight = Math.round(
            resolved.resolvedConfig.project.target_dimensions.height
          );
          const preset =
            normalizedWidth === 210 && normalizedHeight === 297
              ? "a4"
              : normalizedWidth === 148 && normalizedHeight === 210
                ? "a5"
                : normalizedWidth === 216 && normalizedHeight === 279
                  ? "letter"
                  : "custom";
          setSizePreset(preset);
          setFormState({
            dpi: String(resolved.resolvedConfig.project.dpi),
            width: String(resolved.resolvedConfig.project.target_dimensions.width),
            height: String(resolved.resolvedConfig.project.target_dimensions.height),
            spreadEnabled: resolved.resolvedConfig.steps.spread_split.enabled,
            spreadThreshold: String(
              resolved.resolvedConfig.steps.spread_split.confidence_threshold
            ),
            bookPriorsEnabled: resolved.resolvedConfig.steps.book_priors.enabled,
            bookPriorsSample: String(resolved.resolvedConfig.steps.book_priors.sample_pages),
            qaMaskCoverageMin: String(resolved.resolvedConfig.steps.qa.mask_coverage_min),
            qaSemanticBody: String(resolved.resolvedConfig.steps.qa.semantic_thresholds.body),
          });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load config";
          setSnapshot(null);
          setError(message);
        }
      }
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect((): void | (() => void) => {
    let cancelled = false;
    const loadRuns = async (): Promise<void> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) return;
      try {
        const listRuns = windowRef.asteria.ipc["asteria:list-runs"] as
          | (() => Promise<import("../../ipc/contracts.js").IpcResult<RunSummary[]>>)
          | undefined;
        const data: IpcResult<RunSummary[]> = listRuns ? await listRuns() : { ok: true, value: [] };
        const resolvedRuns = unwrapIpcResultOr(data, []);
        const scopedRuns = projectId
          ? resolvedRuns.filter((run) => run.projectId === projectId)
          : resolvedRuns;
        const sortedRuns = [...scopedRuns].sort((a, b) => {
          const aTime = a.generatedAt ? new Date(a.generatedAt).getTime() : 0;
          const bTime = b.generatedAt ? new Date(b.generatedAt).getTime() : 0;
          return bTime - aTime;
        });
        const latestRun = sortedRuns[0];
        if (!cancelled) {
          setLatestInference(latestRun ?? null);
        }
      } catch {
        if (!cancelled) {
          setLatestInference(null);
        }
      }
    };
    void loadRuns();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const parseNumberOrDefault = (value: string, fallback: number): number => {
    if (value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const handlePresetChange = (preset: "custom" | "a4" | "a5" | "letter"): void => {
    setSizePreset(preset);
    if (preset === "custom") return;
    const presetMap = {
      a4: { width: 210, height: 297 },
      a5: { width: 148, height: 210 },
      letter: { width: 216, height: 279 },
    } as const;
    const selection = presetMap[preset];
    setFormState((prev) => ({
      ...prev,
      width: String(selection.width),
      height: String(selection.height),
    }));
  };

  const previewDpi = snapshot
    ? parseNumberOrDefault(formState.dpi, snapshot.resolvedConfig.project.dpi)
    : 0;
  const previewWidth = snapshot
    ? parseNumberOrDefault(formState.width, snapshot.resolvedConfig.project.target_dimensions.width)
    : 1;
  const previewHeight = snapshot
    ? parseNumberOrDefault(
        formState.height,
        snapshot.resolvedConfig.project.target_dimensions.height
      )
    : 1;
  const previewRatio = previewWidth > 0 && previewHeight > 0 ? previewWidth / previewHeight : 1;
  const previewHeightPx = 180;
  const previewWidthPx = Math.max(110, Math.min(220, previewHeightPx * previewRatio));

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
        | ((
            id: string,
            overrides: PipelineConfigOverrides
          ) => Promise<import("../../ipc/contracts.js").IpcResult<void>>)
        | undefined;
      if (saveConfig) {
        const result = await saveConfig(projectId, overrides);
        if (!result.ok) throw new Error(result.error.message);
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
        | ((
            id: string,
            overrides: PipelineConfigOverrides
          ) => Promise<import("../../ipc/contracts.js").IpcResult<void>>)
        | undefined;
      if (saveConfig) {
        const result = await saveConfig(projectId, {});
        if (!result.ok) throw new Error(result.error.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear overrides";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDiagnosticsBundle = async (): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const createBundle = windowRef.asteria.ipc["asteria:create-diagnostics-bundle"] as
      | (() => Promise<import("../../ipc/contracts.js").IpcResult<{ bundlePath: string }>>)
      | undefined;
    const revealPath = windowRef.asteria.ipc["asteria:reveal-path"] as
      | ((path: string) => Promise<import("../../ipc/contracts.js").IpcResult<void>>)
      | undefined;
    if (!createBundle) return;
    setDiagnosticsBusy(true);
    setDiagnosticsStatus(null);
    try {
      const bundleResult = await createBundle();
      const { bundlePath } = unwrapIpcResult(bundleResult, "Create diagnostics bundle");
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard?.writeText) {
        await clipboard.writeText(bundlePath);
      }
      if (revealPath) {
        const revealResult = await revealPath(bundlePath);
        if (!revealResult.ok) throw new Error(revealResult.error.message);
      }
      setDiagnosticsStatus("Diagnostics bundle created and copied to clipboard.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create diagnostics bundle";
      setDiagnosticsStatus(message);
    } finally {
      setDiagnosticsBusy(false);
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
            <Icon name="compass" size={48} />
          </div>
          <h2 className="empty-state-title">Config not loaded</h2>
          <p className="empty-state-description">Connect to the pipeline to view config.</p>
        </div>
      )}

      {snapshot && (
        <div style={{ display: "grid", gap: "16px", maxWidth: "860px" }}>
          {latestInference?.inferredDimensionsMm && (
            <div className="card">
              <h3 className="card-title">Latest inferred dimensions</h3>
              <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
                <div>
                  <strong>Size:</strong> {latestInference.inferredDimensionsMm.width} ×{" "}
                  {latestInference.inferredDimensionsMm.height} mm
                  {latestInference.dimensionConfidence !== undefined
                    ? ` (confidence ${latestInference.dimensionConfidence.toFixed(2)})`
                    : ""}
                </div>
                {latestInference.inferredDpi !== undefined && (
                  <div>
                    <strong>DPI:</strong> {Math.round(latestInference.inferredDpi)}
                    {latestInference.dpiConfidence !== undefined
                      ? ` (confidence ${latestInference.dpiConfidence.toFixed(2)})`
                      : ""}
                  </div>
                )}
              </div>
            </div>
          )}
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

          <div className="card config-builder">
            <div className="config-builder-header">
              <div>
                <h3 className="card-title" style={{ marginBottom: "4px" }}>
                  Config Builder
                </h3>
                <p className="config-hint">
                  Tune the pipeline with guided controls. Values update immediately in the preview,
                  and you can save overrides per project.
                </p>
              </div>
              {!projectId && <span className="config-pill">Select a project to save</span>}
            </div>
            <div className="config-builder-grid">
              <div className="config-builder-controls">
                <div className="config-section">
                  <div className="config-section-title">Target page</div>
                  <label className="config-field">
                    <span>Preset</span>
                    <select
                      className="input"
                      value={sizePreset}
                      onChange={(event) =>
                        handlePresetChange(event.target.value as "custom" | "a4" | "a5" | "letter")
                      }
                      aria-label="Select a target page preset"
                    >
                      <option value="custom">Custom</option>
                      <option value="a4">A4 (210 × 297 mm)</option>
                      <option value="a5">A5 (148 × 210 mm)</option>
                      <option value="letter">US Letter (216 × 279 mm)</option>
                    </select>
                  </label>
                  <div className="config-grid">
                    <label className="config-field">
                      <span>Width (mm)</span>
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
                    <label className="config-field">
                      <span>Height (mm)</span>
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
                  <label className="config-field">
                    <span>DPI</span>
                    <input
                      type="range"
                      min={150}
                      max={600}
                      step={10}
                      value={Number(formState.dpi || previewDpi || 300)}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, dpi: event.target.value }))
                      }
                      aria-label="Project target DPI"
                    />
                    <div className="config-value-row">
                      <span>{formState.dpi || previewDpi} DPI</span>
                      <span className="config-subtle">Recommended 300–450</span>
                    </div>
                  </label>
                </div>

                <div className="config-section">
                  <div className="config-section-title">Layout intelligence</div>
                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={formState.spreadEnabled}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, spreadEnabled: event.target.checked }))
                      }
                      aria-label="Enable spread split"
                    />
                    <div>
                      <span>Enable spread split</span>
                      <small>Detect two-page scans and split automatically.</small>
                    </div>
                  </label>
                  <label className="config-field">
                    <span>Spread confidence threshold</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={Number(formState.spreadThreshold || 0)}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, spreadThreshold: event.target.value }))
                      }
                      aria-label="Spread split confidence threshold"
                    />
                    <div className="config-value-row">
                      <span>{formState.spreadThreshold || "0"}</span>
                      <span className="config-subtle">Higher = fewer splits</span>
                    </div>
                  </label>
                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={formState.bookPriorsEnabled}
                      onChange={(event) =>
                        setFormState((prev) => ({
                          ...prev,
                          bookPriorsEnabled: event.target.checked,
                        }))
                      }
                      aria-label="Enable book priors"
                    />
                    <div>
                      <span>Enable book priors</span>
                      <small>Stabilize trim and content bounds from sample pages.</small>
                    </div>
                  </label>
                  <label className="config-field">
                    <span>Book priors sample pages</span>
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
                </div>

                <div className="config-section">
                  <div className="config-section-title">Quality thresholds</div>
                  <label className="config-field">
                    <span>Mask coverage minimum</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={Number(formState.qaMaskCoverageMin || 0)}
                      onChange={(event) =>
                        setFormState((prev) => ({
                          ...prev,
                          qaMaskCoverageMin: event.target.value,
                        }))
                      }
                      aria-label="QA mask coverage minimum"
                    />
                    <div className="config-value-row">
                      <span>{formState.qaMaskCoverageMin || "0"}</span>
                      <span className="config-subtle">Lower = more warnings</span>
                    </div>
                  </label>
                  <label className="config-field">
                    <span>Semantic threshold (body)</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={Number(formState.qaSemanticBody || 0)}
                      onChange={(event) =>
                        setFormState((prev) => ({
                          ...prev,
                          qaSemanticBody: event.target.value,
                        }))
                      }
                      aria-label="Semantic threshold for body layout"
                    />
                    <div className="config-value-row">
                      <span>{formState.qaSemanticBody || "0"}</span>
                      <span className="config-subtle">Balance recall vs precision</span>
                    </div>
                  </label>
                </div>
              </div>
              <div className="config-builder-preview">
                <div className="config-preview-card">
                  <div className="config-preview-frame" aria-hidden="true">
                    <div
                      className="config-preview-page"
                      style={{ width: `${previewWidthPx}px`, height: `${previewHeightPx}px` }}
                    >
                      <div className="config-preview-guides" />
                    </div>
                  </div>
                  <div className="config-preview-meta">
                    <div>
                      <strong>Target size</strong>
                      <div>
                        {previewWidth} × {previewHeight} mm
                      </div>
                    </div>
                    <div>
                      <strong>DPI</strong>
                      <div>{previewDpi}</div>
                    </div>
                    <div>
                      <strong>Spread split</strong>
                      <div>{formState.spreadEnabled ? "Enabled" : "Disabled"}</div>
                    </div>
                    <div>
                      <strong>QA thresholds</strong>
                      <div>
                        Mask {formState.qaMaskCoverageMin || "0"} • Body{" "}
                        {formState.qaSemanticBody || "0"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="config-actions">
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
          <div className="card">
            <h3 className="card-title">Diagnostics</h3>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              Create a diagnostics bundle to share logs, preferences, and the latest run summary.
            </p>
            {diagnosticsStatus && (
              <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                {diagnosticsStatus}
              </p>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => void handleCreateDiagnosticsBundle()}
              disabled={diagnosticsBusy}
            >
              {diagnosticsBusy ? "Creating…" : "Copy debug bundle"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
