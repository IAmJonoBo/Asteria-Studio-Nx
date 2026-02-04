import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunProgressEvent } from "../../ipc/contracts.js";
import { ExportsScreen } from "./ExportsScreen.js";
import { MonitorScreen } from "./MonitorScreen.js";
import { RunsScreen } from "./RunsScreen.js";
import { SettingsScreen } from "./SettingsScreen.js";

const resetAsteria = (): void => {
  delete (globalThis as typeof globalThis & { asteria?: unknown }).asteria;
};

describe("screen flows", () => {
  afterEach(() => {
    cleanup();
    resetAsteria();
  });

  it("RunsScreen renders run history and config", async () => {
    const onSelectRun = vi.fn();
    const onOpenReviewQueue = vi.fn();
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-1",
        runDir: "/tmp/runs/run-1",
        projectId: "proj",
        generatedAt: new Date("2024-01-01T00:00:00.000Z").toISOString(),
        reviewCount: 2,
        status: "running",
      },
    ]);
    const getRunConfig = vi.fn().mockResolvedValue({
      resolvedConfig: {
        project: {
          target_dimensions: { width: 210, height: 297, unit: "mm" },
          dpi: 400,
        },
        steps: {
          spread_split: { enabled: true, confidence_threshold: 0.7 },
          qa: { mask_coverage_min: 0.5, semantic_thresholds: { body: 0.88 } },
        },
      },
    });

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:get-run-config": getRunConfig,
      },
    };

    const user = userEvent.setup();

    render(
      <RunsScreen
        selectedRunId="run-1"
        selectedRunDir="/tmp/runs/run-1"
        onSelectRun={onSelectRun}
        onOpenReviewQueue={onOpenReviewQueue}
      />
    );

    expect(await screen.findByText(/Run History/i)).toBeInTheDocument();
    expect(screen.getByText(/run-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected run config/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open review queue/i }));
    expect(onSelectRun).toHaveBeenCalledWith("run-1", "/tmp/runs/run-1");
    expect(onOpenReviewQueue).toHaveBeenCalled();
  });

  it("RunsScreen shows empty and error states", async () => {
    const listRunsEmpty = vi.fn().mockResolvedValue([]);
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:list-runs": listRunsEmpty },
    };

    render(<RunsScreen onSelectRun={vi.fn()} onOpenReviewQueue={vi.fn()} />);

    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();

    cleanup();
    const listRunsError = vi.fn().mockRejectedValue(new Error("boom"));
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:list-runs": listRunsError },
    };

    render(<RunsScreen onSelectRun={vi.fn()} onOpenReviewQueue={vi.fn()} />);

    expect(await screen.findByText(/Run history unavailable/i)).toBeInTheDocument();
  });

  it("RunsScreen shows inferred metrics and config-unavailable state", async () => {
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-2",
        runDir: "/tmp/runs/run-2",
        projectId: "proj",
        generatedAt: "",
        reviewCount: 1,
        inferredDimensionsMm: { width: 210, height: 297 },
        inferredDpi: 300,
        dimensionConfidence: 0.82,
        dpiConfidence: 0.7,
      },
    ]);
    const getRunConfig = vi.fn().mockResolvedValue(null);

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:get-run-config": getRunConfig,
      },
    };

    render(
      <RunsScreen
        selectedRunId="run-2"
        selectedRunDir="/tmp/runs/run-2"
        onSelectRun={vi.fn()}
        onOpenReviewQueue={vi.fn()}
      />
    );

    expect(await screen.findByText(/Config snapshot unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Inferred dimensions/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Inferred DPI/i).length).toBeGreaterThan(0);
  });

  it("RunsScreen handles missing IPC and run config errors", async () => {
    render(<RunsScreen onSelectRun={vi.fn()} onOpenReviewQueue={vi.fn()} />);

    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();

    cleanup();
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-err",
        runDir: "/tmp/runs/run-err",
        projectId: "proj",
        generatedAt: "",
        reviewCount: 0,
      },
    ]);
    const getRunConfig = vi.fn().mockRejectedValue("boom");
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:get-run-config": getRunConfig,
      },
    };

    render(
      <RunsScreen
        selectedRunId="run-err"
        selectedRunDir="/tmp/runs/run-err"
        onSelectRun={vi.fn()}
        onOpenReviewQueue={vi.fn()}
      />
    );

    expect(await screen.findByText(/Failed to load run config/i)).toBeInTheDocument();
  });

  it("MonitorScreen shows stage progress updates", async () => {
    let handler: ((event: RunProgressEvent) => void) | null = null;
    const unsubscribe = vi.fn();

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      onRunProgress: (cb: (event: RunProgressEvent) => void): (() => void) => {
        handler = cb;
        return unsubscribe;
      },
    };

    render(<MonitorScreen />);

    await act(async () => {
      handler?.({
        runId: "run-7",
        projectId: "proj",
        stage: "normalize",
        processed: 3,
        total: 10,
        timestamp: new Date().toISOString(),
      });
      handler?.({
        runId: "run-7",
        projectId: "proj",
        stage: "error",
        processed: 3,
        total: 10,
        timestamp: new Date().toISOString(),
      });
    });

    expect(await screen.findByText(/run-7/i)).toBeInTheDocument();
    expect(screen.getByText(/normalize/i)).toBeInTheDocument();
    expect(screen.getByText(/Errors detected/i)).toBeInTheDocument();
  });

  it("MonitorScreen renders inferred metrics and throughput", async () => {
    let handler: ((event: RunProgressEvent) => void) | null = null;
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      onRunProgress: (cb: (event: RunProgressEvent) => void): (() => void) => {
        handler = cb;
        return () => undefined;
      },
    };

    render(<MonitorScreen />);

    await act(async () => {
      handler?.({
        runId: "run-8",
        projectId: "proj",
        stage: "normalize",
        processed: 5,
        total: 10,
        timestamp: new Date().toISOString(),
        inferredDimensionsMm: { width: 210, height: 297 },
        inferredDpi: 300,
        dimensionConfidence: 0.9,
        dpiConfidence: 0.8,
        throughput: 1.5,
      });
    });

    expect(await screen.findByText(/Inferred size/i)).toBeInTheDocument();
    expect(screen.getByText(/Inferred DPI/i)).toBeInTheDocument();
    expect(screen.getByText(/pages\/sec/i)).toBeInTheDocument();
  });

  it("ExportsScreen shows previous manifests and triggers export", async () => {
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-9",
        runDir: "/tmp/runs/run-9",
        projectId: "proj",
        generatedAt: "",
        reviewCount: 0,
      },
    ]);
    const exportRun = vi.fn().mockResolvedValue("/tmp/export");
    const getManifest = vi.fn().mockResolvedValue({
      runId: "run-9",
      status: "success",
      exportedAt: new Date("2024-02-01T00:00:00.000Z").toISOString(),
      sourceRoot: "/data",
      count: 10,
    });

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:export-run": exportRun,
        "asteria:get-run-manifest": getManifest,
      },
    };

    const user = userEvent.setup();

    render(<ExportsScreen />);

    await screen.findByRole("heading", { name: /Exports/i, level: 1 });
    expect(await screen.findByText(/Previous exports/i)).toBeInTheDocument();
    expect(await screen.findByText(/success/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/Export saved to/i)).toBeInTheDocument();
    expect(exportRun).toHaveBeenCalledWith("run-9", "/tmp/runs/run-9", ["png"]);
  });

  it("ExportsScreen handles empty runs and format validation", async () => {
    const listRunsEmpty = vi.fn().mockResolvedValue([]);

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:list-runs": listRunsEmpty },
    };

    render(<ExportsScreen />);

    expect(await screen.findByText(/Run a pipeline to generate exports/i)).toBeInTheDocument();

    cleanup();
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-10",
        runDir: "/tmp/runs/run-10",
        projectId: "proj",
        generatedAt: "",
        reviewCount: 0,
      },
    ]);
    const exportRun = vi.fn();

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:list-runs": listRuns, "asteria:export-run": exportRun },
    };

    const user = userEvent.setup();
    render(<ExportsScreen />);

    const pngCheckbox = await screen.findByRole("checkbox", { name: /png/i });
    await user.click(pngCheckbox);
    await user.click(screen.getByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/Select at least one format/i)).toBeInTheDocument();
  });

  it("ExportsScreen shows export errors", async () => {
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-11",
        runDir: "/tmp/runs/run-11",
        projectId: "proj",
        generatedAt: "",
        reviewCount: 0,
      },
    ]);
    const exportRun = vi.fn().mockRejectedValue(new Error("Export failed"));

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:list-runs": listRuns, "asteria:export-run": exportRun },
    };

    const user = userEvent.setup();
    render(<ExportsScreen />);

    await user.click(await screen.findByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/Export failed/i)).toBeInTheDocument();
  });

  it("ExportsScreen handles missing IPC and list run failures", async () => {
    render(<ExportsScreen />);
    expect(await screen.findByText(/Run a pipeline to generate exports/i)).toBeInTheDocument();

    cleanup();
    const listRuns = vi.fn().mockRejectedValue("boom");
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:list-runs": listRuns },
    };

    render(<ExportsScreen />);
    expect(await screen.findByText(/Failed to load runs/i)).toBeInTheDocument();
  });

  it("SettingsScreen saves and clears overrides", async () => {
    const getConfig = vi.fn().mockResolvedValue({
      baseConfig: {
        project: { target_dimensions: { width: 210, height: 297, unit: "mm" }, dpi: 400 },
        steps: { spread_split: { enabled: false, confidence_threshold: 0.7 } },
      },
      resolvedConfig: {
        project: { target_dimensions: { width: 210, height: 297, unit: "mm" }, dpi: 400 },
        steps: {
          spread_split: {
            enabled: false,
            confidence_threshold: 0.7,
            gutter_min_width_px: 12,
            gutter_max_width_px: 80,
          },
          book_priors: {
            enabled: true,
            sample_pages: 40,
            max_trim_drift_px: 18,
            max_content_drift_px: 24,
            min_confidence: 0.6,
          },
          qa: { mask_coverage_min: 0.5, semantic_thresholds: { body: 0.88 } },
        },
      },
      sources: { configPath: "/tmp/pipeline_config.yaml" },
    });
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:get-pipeline-config": getConfig,
        "asteria:save-project-config": saveConfig,
      },
    };

    const user = userEvent.setup();

    render(<SettingsScreen projectId="proj" />);

    expect(await screen.findByText(/Resolved config/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Save project overrides/i }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /Clear overrides/i }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith("proj", {}));
  });

  it("SettingsScreen shows empty and error states", async () => {
    render(<SettingsScreen projectId="proj" />);
    expect(await screen.findByText(/Config not loaded/i)).toBeInTheDocument();

    cleanup();
    const getConfig = vi.fn().mockRejectedValue(new Error("boom"));
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: { "asteria:get-pipeline-config": getConfig },
    };

    render(<SettingsScreen projectId="proj" />);
    expect(await screen.findByText(/Config error/i)).toBeInTheDocument();
  });

  it("SettingsScreen renders latest inference details and project override sources", async () => {
    const getConfig = vi.fn().mockResolvedValue({
      baseConfig: {
        project: { target_dimensions: { width: 210, height: 297, unit: "mm" }, dpi: 400 },
        steps: { spread_split: { enabled: false, confidence_threshold: 0.7 } },
      },
      resolvedConfig: {
        project: { target_dimensions: { width: 210, height: 297, unit: "mm" }, dpi: 400 },
        steps: {
          spread_split: {
            enabled: false,
            confidence_threshold: 0.7,
            gutter_min_width_px: 12,
            gutter_max_width_px: 80,
          },
          book_priors: {
            enabled: true,
            sample_pages: 40,
            max_trim_drift_px: 18,
            max_content_drift_px: 24,
            min_confidence: 0.6,
          },
          qa: { mask_coverage_min: 0.5, semantic_thresholds: { body: 0.88 } },
        },
      },
      sources: { configPath: "/tmp/pipeline_config.yaml", projectConfigPath: "/tmp/project.yaml" },
    });
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-a",
        projectId: "proj",
        generatedAt: "2024-02-02T00:00:00.000Z",
        inferredDimensionsMm: { width: 200, height: 300 },
        inferredDpi: 280,
        dimensionConfidence: 0.9,
        dpiConfidence: 0.8,
      },
    ]);

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:get-pipeline-config": getConfig,
        "asteria:list-runs": listRuns,
      },
    };

    render(<SettingsScreen />);

    expect(await screen.findByText(/Latest inferred dimensions/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Size:/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/DPI:/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Project override:/i)).toBeInTheDocument();
    expect(screen.getByText(/Select a project to save overrides/i)).toBeInTheDocument();
  });

  it("SettingsScreen handles save errors and invalid inputs", async () => {
    const getConfig = vi.fn().mockResolvedValue({
      baseConfig: {
        project: { target_dimensions: { width: 210, height: 297, unit: "mm" }, dpi: 400 },
        steps: { spread_split: { enabled: false, confidence_threshold: 0.7 } },
      },
      resolvedConfig: {
        project: { target_dimensions: { width: 210, height: 297, unit: "mm" }, dpi: 400 },
        steps: {
          spread_split: {
            enabled: false,
            confidence_threshold: 0.7,
            gutter_min_width_px: 12,
            gutter_max_width_px: 80,
          },
          book_priors: {
            enabled: true,
            sample_pages: 40,
            max_trim_drift_px: 18,
            max_content_drift_px: 24,
            min_confidence: 0.6,
          },
          qa: { mask_coverage_min: 0.5, semantic_thresholds: { body: 0.88 } },
        },
      },
      sources: { configPath: "/tmp/pipeline_config.yaml" },
    });
    const saveConfig = vi.fn().mockRejectedValue("boom");

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:get-pipeline-config": getConfig,
        "asteria:save-project-config": saveConfig,
      },
    };

    const user = userEvent.setup();
    render(<SettingsScreen projectId="proj" />);

    await screen.findByText(/Resolved config/i);
    fireEvent.change(screen.getByLabelText(/Project target width/i), {
      target: { value: "bad" },
    });
    await user.click(screen.getByRole("button", { name: /Save project overrides/i }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalled());
    const overrides = saveConfig.mock.calls[0][1] as {
      project?: { target_dimensions?: { width: number } };
    };
    expect(overrides.project?.target_dimensions?.width).toBe(210);
    expect(await screen.findByText(/Failed to save overrides/i)).toBeInTheDocument();
  });
});
