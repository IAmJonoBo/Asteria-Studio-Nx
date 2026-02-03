import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

  it("ExportsScreen shows previous manifests and triggers export", async () => {
    const listRuns = vi.fn().mockResolvedValue([
      { runId: "run-9", projectId: "proj", generatedAt: "", reviewCount: 0 },
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

    await screen.findByText(/Exports/i);
    expect(await screen.findByText(/Previous exports/i)).toBeInTheDocument();
    expect(await screen.findByText(/success/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Export Run/i }));

    expect(await screen.findByText(/Export saved to/i)).toBeInTheDocument();
    expect(exportRun).toHaveBeenCalledWith("run-9", ["png"]);
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
});
