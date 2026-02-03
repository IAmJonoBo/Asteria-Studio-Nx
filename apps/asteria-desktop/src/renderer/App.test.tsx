import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  it("loads projects list", async () => {
    const windowRef = globalThis as typeof globalThis & {
      asteria?: {
        ipc: Record<string, unknown>;
        onRunProgress?: (handler: (event: { runId: string; stage: string }) => void) => () => void;
      };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([
          {
            id: "mind-myth-magick",
            name: "Mind, Myth and Magick",
            path: "/projects/mind-myth-and-magick",
            inputPath: "/projects/mind-myth-and-magick/input/raw",
            status: "completed",
          },
        ]),
      },
    };

    render(<App />);

    expect(await screen.findByRole("heading", { name: /projects/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/manage your corpus libraries/i)).toBeInTheDocument();
    expect(await screen.findByText(/Mind, Myth and Magick/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("starts a run from projects", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: {
        ipc: Record<string, unknown>;
        onRunProgress?: (handler: (event: { runId: string; stage: string }) => void) => () => void;
      };
    };
    const previousAsteria = windowRef.asteria;
    const scanCorpus = vi.fn().mockResolvedValue({
      projectId: "mind-myth-magick",
      pages: [
        { id: "p1", filename: "page.png", originalPath: "/tmp/page.png", confidenceScores: {} },
      ],
      targetDpi: 300,
      targetDimensionsMm: { width: 210, height: 297 },
    });
    const analyzeCorpus = vi.fn().mockResolvedValue({
      targetDimensionsMm: { width: 210, height: 297 },
      dpi: 300,
      inferredDimensionsMm: { width: 210, height: 297 },
      inferredDpi: 300,
      dimensionConfidence: 0.9,
      dpiConfidence: 0.85,
    });
    const startRun = vi.fn().mockResolvedValue({ runId: "run-42", runDir: "/tmp/runs/run-42" });
    const listRuns = vi.fn().mockResolvedValue([]);
    const confirmMock = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([
          {
            id: "mind-myth-magick",
            name: "Mind, Myth and Magick",
            path: "/projects/mind-myth-and-magick",
            inputPath: "/projects/mind-myth-and-magick/input/raw",
            status: "completed",
          },
        ]),
        "asteria:scan-corpus": scanCorpus,
        "asteria:analyze-corpus": analyzeCorpus,
        "asteria:start-run": startRun,
        "asteria:list-runs": listRuns,
      },
    };

    render(<App />);

    const startRunButton = await screen.findByRole("button", { name: /start run/i });
    await user.click(startRunButton);

    expect(scanCorpus).toHaveBeenCalledWith("/projects/mind-myth-and-magick/input/raw", {
      projectId: "mind-myth-magick",
    });
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "mind-myth-magick" })
    );
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();

    confirmMock.mockRestore();
    windowRef.asteria = previousAsteria;
  });

  it("selects a project and navigates to runs", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([
          {
            id: "mind-myth-magick",
            name: "Mind, Myth and Magick",
            path: "/projects/mind-myth-and-magick",
            inputPath: "/projects/mind-myth-and-magick/input/raw",
            status: "completed",
          },
        ]),
        "asteria:list-runs": vi.fn().mockResolvedValue([]),
      },
    };

    render(<App />);

    const openButton = await screen.findByRole("button", { name: /open →/i });
    await user.click(openButton);

    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("selects a run and loads its review queue", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: {
        ipc: Record<string, unknown>;
        onRunProgress?: (handler: (event: { runId: string; stage: string }) => void) => () => void;
      };
    };
    const previousAsteria = windowRef.asteria;
    const listRuns = vi.fn().mockResolvedValue([
      {
        runId: "run-123",
        runDir: "/tmp/runs/run-123",
        projectId: "project-a",
        generatedAt: "2026-01-01",
        reviewCount: 1,
      },
    ]);
    const fetchReviewQueue = vi.fn().mockResolvedValue({
      runId: "run-123",
      projectId: "project-a",
      generatedAt: "2026-01-01",
      items: [
        {
          pageId: "page-123",
          filename: "page-123.jpg",
          layoutProfile: "body",
          layoutConfidence: 0.6,
          reason: "semantic-layout",
          qualityGate: { accepted: true, reasons: [] },
          previews: [{ kind: "normalized", path: "/tmp/norm.png", width: 16, height: 16 }],
        },
      ],
    });

    const onRunProgress = vi.fn(
      (handler: (event: { runId: string; stage: string }) => void): (() => void) => {
        handler({ runId: "run-123", stage: "complete" });
        return () => {};
      }
    );
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
        "asteria:list-runs": listRuns,
        "asteria:fetch-review-queue": fetchReviewQueue,
      },
      onRunProgress,
    };

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: /review queue/i })[0]);

    expect(fetchReviewQueue).toHaveBeenCalledWith("run-123", "/tmp/runs/run-123");
    const pageEntries = await screen.findAllByText(/page-123\.jpg/i);
    expect(pageEntries.length).toBeGreaterThan(0);

    windowRef.asteria = previousAsteria;
  });

  it("shows error state when projects list fails", async () => {
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockRejectedValue(new Error("load failed")),
      },
    };

    render(<App />);

    expect(await screen.findByText(/Projects unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/load failed/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("renders empty state when IPC unavailable", async () => {
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = undefined;

    render(<App />);

    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("navigates to monitor, exports, and settings screens", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
      },
    };

    render(<App />);

    await user.click(screen.getByRole("button", { name: /Live Monitor/i }));
    expect(await screen.findByText(/Live Run Monitor/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Exports/i }));
    expect(await screen.findByText(/Run a pipeline to generate exports/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Settings/i }));
    expect(await screen.findByText(/Config not loaded/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("imports a corpus and reloads projects", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "new-project",
          name: "New Project",
          path: "/projects/new",
          inputPath: "/projects/new/input/raw",
          status: "idle",
        },
      ]);
    const importCorpus = vi.fn().mockResolvedValue({
      id: "new-project",
      name: "New Project",
      path: "/projects/new",
      inputPath: "/projects/new/input/raw",
      status: "idle",
    });

    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": listProjects,
        "asteria:import-corpus": importCorpus,
      },
    };

    const originalPrompt = globalThis.prompt;
    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = vi
      .fn()
      .mockImplementationOnce(() => "/tmp/corpus")
      .mockImplementationOnce(() => "New Project");

    render(<App />);

    const importButton = await screen.findByRole("button", { name: /import corpus/i });
    await user.click(importButton);

    expect(importCorpus).toHaveBeenCalledWith({ inputPath: "/tmp/corpus", name: "New Project" });
    expect(await screen.findByText(/New Project/i)).toBeInTheDocument();

    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = originalPrompt;
    windowRef.asteria = previousAsteria;
  }, 10000);

  it("alerts when import corpus fails", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    const alertMock = vi.fn();
    const originalAlert = globalThis.alert;
    globalThis.alert = alertMock;

    const importCorpus = vi.fn().mockRejectedValue(new Error("import failed"));
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
        "asteria:import-corpus": importCorpus,
      },
    };

    const originalPrompt = globalThis.prompt;
    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = vi
      .fn()
      .mockImplementationOnce(() => "/tmp/corpus")
      .mockImplementationOnce(() => "Broken Project");

    render(<App />);

    const importButton = await screen.findByRole("button", { name: /import corpus/i });
    await user.click(importButton);

    expect(alertMock).toHaveBeenCalledWith("import failed");

    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = originalPrompt;
    globalThis.alert = originalAlert;
    windowRef.asteria = previousAsteria;
  });

  it("navigates to runs on completion progress", async () => {
    const windowRef = globalThis as typeof globalThis & {
      asteria?: {
        ipc: Record<string, unknown>;
        onRunProgress?: (handler: (event: { runId: string; stage: string }) => void) => () => void;
      };
    };
    const previousAsteria = windowRef.asteria;
    const listRuns = vi.fn().mockResolvedValue([]);
    const onRunProgress = vi.fn(
      (handler: (event: { runId: string; stage: string }) => void): (() => void) => {
        handler({ runId: "run-99", stage: "complete" });
        return () => {};
      }
    );

    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
        "asteria:list-runs": listRuns,
      },
      onRunProgress,
    };

    render(<App />);

    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("alerts when start run fails", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    const alertMock = vi.fn();
    const originalAlert = globalThis.alert;
    globalThis.alert = alertMock;

    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([
          {
            id: "proj",
            name: "Project",
            path: "/projects/proj",
            inputPath: "/projects/proj/input/raw",
            status: "idle",
          },
        ]),
        "asteria:scan-corpus": vi.fn().mockRejectedValue(new Error("scan failed")),
        "asteria:start-run": vi.fn(),
      },
    };

    render(<App />);

    const startRunButton = await screen.findByRole("button", { name: /start run/i });
    await user.click(startRunButton);

    expect(alertMock).toHaveBeenCalledWith("scan failed");

    globalThis.alert = originalAlert;
    windowRef.asteria = previousAsteria;
  });

  it("alerts when starting a run without a project", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    const alertMock = vi.fn();
    const originalAlert = globalThis.alert;
    globalThis.alert = alertMock;

    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
      },
    };

    render(<App />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Start New Run/i }));

    expect(alertMock).toHaveBeenCalledWith("Select a project to start a run.");

    globalThis.alert = originalAlert;
    windowRef.asteria = previousAsteria;
  });

  it("uses keyboard shortcuts to navigate to runs", async () => {
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
      },
    };

    render(<App />);

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });

    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("executes command palette actions", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    const originalPrompt = globalThis.prompt;
    const storedTheme = globalThis.localStorage?.getItem("asteria-theme") ?? null;

    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
      },
    };
    globalThis.localStorage?.setItem("asteria-theme", "light");
    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = vi.fn().mockImplementationOnce(() => null);

    render(<App />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Go to Run History/i }));
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Go to Live Monitor/i }));
    expect(await screen.findByText(/Live Run Monitor/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Go to Exports/i }));
    expect(await screen.findByText(/Run a pipeline to generate exports/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Go to Settings/i }));
    expect(await screen.findByText(/Config not loaded/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Go to Projects/i }));
    expect(await screen.findByText(/No projects yet/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Go to Review Queue/i }));
    expect(await screen.findByText(/Choose a run from Run History/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Toggle Theme/i }));
    expect(screen.getByLabelText(/Switch to light theme/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: /Import Corpus/i }));

    if (storedTheme === null) {
      globalThis.localStorage?.removeItem("asteria-theme");
    } else {
      globalThis.localStorage?.setItem("asteria-theme", storedTheme);
    }
    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = originalPrompt;
    windowRef.asteria = previousAsteria;
  }, 10000);

  it("opens review queue from run history", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
        "asteria:list-runs": vi.fn().mockResolvedValue([
          {
            runId: "run-42",
            runDir: "/tmp/runs/run-42",
            projectId: "proj",
            generatedAt: "2024-01-01",
            reviewCount: 0,
          },
        ]),
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-42",
          projectId: "proj",
          generatedAt: "2024-01-01",
          items: [],
        }),
      },
    };

    render(<App />);

    await user.click(screen.getByRole("button", { name: /Run History/i }));
    await user.click(screen.getByRole("button", { name: /Open Review Queue/i }));

    expect(await screen.findByText(/No pages need review/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("aborts import when prompt is empty", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    const importCorpus = vi.fn();
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": vi.fn().mockResolvedValue([]),
        "asteria:import-corpus": importCorpus,
      },
    };

    const originalPrompt = globalThis.prompt;
    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = vi.fn().mockImplementationOnce(() => null);

    render(<App />);

    const importButton = await screen.findByRole("button", { name: /import corpus/i });
    await user.click(importButton);

    expect(importCorpus).not.toHaveBeenCalled();

    (
      globalThis as typeof globalThis & {
        prompt: ((message?: string) => string | null) | undefined;
      }
    ).prompt = originalPrompt;
    windowRef.asteria = previousAsteria;
  });
});
