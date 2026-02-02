import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunProgressEvent } from "../../ipc/contracts";
import { ExportsScreen, MonitorScreen, RunsScreen, SettingsScreen } from "./PlaceholderScreens";

const resetAsteria = () => {
  delete (globalThis as typeof globalThis & { asteria?: unknown }).asteria;
};

describe("PlaceholderScreens", () => {
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
        onSelectRun={onSelectRun}
        onOpenReviewQueue={onOpenReviewQueue}
      />
    );

    expect(await screen.findByText(/Run History/i)).toBeInTheDocument();
    expect(screen.getByText(/run-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected run config/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open review queue/i }));
    expect(onSelectRun).toHaveBeenCalledWith("run-1");
    expect(onOpenReviewQueue).toHaveBeenCalled();
  });

  it("RunsScreen shows empty state when no IPC", async () => {
    render(
      <RunsScreen selectedRunId={undefined} onSelectRun={vi.fn()} onOpenReviewQueue={vi.fn()} />
    );

    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();
  });

  it("RunsScreen shows error state when list fails", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": vi.fn().mockRejectedValue(new Error("failed")),
      },
    };

    render(
      <RunsScreen selectedRunId={undefined} onSelectRun={vi.fn()} onOpenReviewQueue={vi.fn()} />
    );

    expect(await screen.findByText(/Run history unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it("MonitorScreen shows progress updates", async () => {
    let handler: ((event: RunProgressEvent) => void) | null = null;
    const unsubscribe = vi.fn();

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      onRunProgress: (cb: (event: RunProgressEvent) => void) => {
        handler = cb;
        return unsubscribe;
      },
    };

    render(<MonitorScreen />);

    await act(async () => {
      handler?.({
        runId: "run-7",
        projectId: "proj",
        stage: "running",
        processed: 3,
        total: 10,
        timestamp: new Date().toISOString(),
      });
    });

    expect(await screen.findByText(/run-7/i)).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("MonitorScreen shows empty state without progress", async () => {
    render(<MonitorScreen />);

    expect(await screen.findByText(/Live Run Monitor/i)).toBeInTheDocument();
    expect(screen.getByText(/Start a run to see live updates/i)).toBeInTheDocument();
  });

  it("ExportsScreen exports selected run", async () => {
    const listRuns = vi
      .fn()
      .mockResolvedValue([{ runId: "run-9", projectId: "proj", generatedAt: "", reviewCount: 0 }]);
    const exportRun = vi.fn().mockResolvedValue("/tmp/export");

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:export-run": exportRun,
      },
    };

    const user = userEvent.setup();

    render(<ExportsScreen />);

    await screen.findByText(/Exports/i);
    await user.click(screen.getByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/Export saved to/i)).toBeInTheDocument();
    expect(exportRun).toHaveBeenCalledWith("run-9", ["png"]);
  });

  it("ExportsScreen requires at least one format", async () => {
    const listRuns = vi
      .fn()
      .mockResolvedValue([{ runId: "run-10", projectId: "proj", generatedAt: "", reviewCount: 0 }]);
    const exportRun = vi.fn();

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:export-run": exportRun,
      },
    };

    const user = userEvent.setup();

    render(<ExportsScreen />);

    await screen.findByText(/Exports/i);
    await user.click(screen.getByLabelText(/PNG/i));
    await user.click(screen.getByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/Select at least one format/i)).toBeInTheDocument();
    expect(exportRun).not.toHaveBeenCalled();
  });

  it("ExportsScreen shows error when list runs fails", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": vi.fn().mockRejectedValue(new Error("list failed")),
      },
    };

    render(<ExportsScreen />);

    expect(await screen.findByText(/list failed/i)).toBeInTheDocument();
  });

  it("ExportsScreen shows empty state without runs", async () => {
    render(<ExportsScreen />);

    expect(await screen.findByText(/Run a pipeline to generate exports/i)).toBeInTheDocument();
  });

  it("ExportsScreen reports export failure", async () => {
    const listRuns = vi
      .fn()
      .mockResolvedValue([{ runId: "run-11", projectId: "proj", generatedAt: "", reviewCount: 0 }]);
    const exportRun = vi.fn().mockRejectedValue(new Error("export failed"));

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:list-runs": listRuns,
        "asteria:export-run": exportRun,
      },
    };

    const user = userEvent.setup();

    render(<ExportsScreen />);

    await screen.findByText(/Exports/i);
    await user.click(screen.getByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/export failed/i)).toBeInTheDocument();
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

  it("SettingsScreen shows load error", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:get-pipeline-config": vi.fn().mockRejectedValue(new Error("config failed")),
      },
    };

    render(<SettingsScreen projectId="proj" />);

    expect(await screen.findByText(/Config error/i)).toBeInTheDocument();
    expect(screen.getByText(/config failed/i)).toBeInTheDocument();
  });

  it("SettingsScreen shows empty state without config", async () => {
    render(<SettingsScreen projectId="proj" />);

    expect(await screen.findByText(/Config not loaded/i)).toBeInTheDocument();
  });
});
