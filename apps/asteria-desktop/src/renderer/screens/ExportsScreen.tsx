import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { RunManifestSummary, RunSummary } from "../../ipc/contracts.js";

const exportFormats = ["png", "tiff", "pdf"] as const;

type ExportFormat = (typeof exportFormats)[number];

export function ExportsScreen(): JSX.Element {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [formats, setFormats] = useState<Record<ExportFormat, boolean>>({
    png: true,
    tiff: false,
    pdf: false,
  });
  const [isExporting, setIsExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manifests, setManifests] = useState<Record<string, RunManifestSummary | null>>({});

  useEffect((): void | (() => void) => {
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
        const getManifest = windowRef.asteria.ipc["asteria:get-run-manifest"] as
          | ((runId: string) => Promise<RunManifestSummary | null>)
          | undefined;
        if (getManifest && data.length > 0) {
          const manifestEntries = await Promise.all(
            data.map(async (run) => ({
              runId: run.runId,
              manifest: await getManifest(run.runId),
            }))
          );
          if (!cancelled) {
            setManifests(
              manifestEntries.reduce<Record<string, RunManifestSummary | null>>(
                (acc, entry) => ({ ...acc, [entry.runId]: entry.manifest }),
                {}
              )
            );
          }
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

  const exportHistory = useMemo(
    () =>
      runs
        .map((run) => ({ run, manifest: manifests[run.runId] }))
        .filter(({ manifest }) => Boolean(manifest)),
    [runs, manifests]
  );

  const handleExport = async (): Promise<void> => {
    if (!selectedRunId) return;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const exportRun = windowRef.asteria.ipc["asteria:export-run"] as
      | ((runId: string, formats: Array<ExportFormat>) => Promise<string>)
      | undefined;
    if (!exportRun) return;
    const selectedFormats = exportFormats.filter((format) => formats[format]);
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

      <div style={{ display: "grid", gap: "16px" }}>
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
              {exportFormats.map((format) => (
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

        <div className="card" style={{ display: "grid", gap: "12px" }}>
          <h3 className="card-title">Previous exports</h3>
          {exportHistory.length === 0 ? (
            <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              No run manifests available yet.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "8px" }}>
              {exportHistory.map(({ run, manifest }) => (
                <div
                  key={`export-${run.runId}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: "12px",
                    fontSize: "12px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{run.runId}</div>
                    <div style={{ color: "var(--text-secondary)" }}>{run.projectId}</div>
                    <div style={{ color: "var(--text-secondary)" }}>
                      Exported {manifest?.exportedAt ? new Date(manifest.exportedAt).toLocaleString() : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", color: "var(--text-secondary)" }}>
                    <div>Status: {manifest?.status ?? "unknown"}</div>
                    <div>{manifest?.count ?? 0} pages</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
