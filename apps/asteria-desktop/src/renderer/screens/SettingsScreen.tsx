import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  PipelineConfigOverrides,
  PipelineConfigSnapshot,
} from "../../ipc/contracts.js";

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
                <strong>Target size:</strong> {snapshot.baseConfig.project.target_dimensions.width} ×{" "}
                {snapshot.baseConfig.project.target_dimensions.height}{" "}
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
