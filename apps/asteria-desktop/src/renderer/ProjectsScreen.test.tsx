import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";

describe("ProjectsScreen", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders empty state when no projects", () => {
    render(
      <ProjectsScreen
        onImportCorpus={vi.fn()}
        onOpenProject={vi.fn()}
        onStartRun={vi.fn()}
        projects={[]}
      />
    );

    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import corpus/i })).toBeInTheDocument();
  });

  it("opens project and starts run", async () => {
    const onImportCorpus = vi.fn();
    const onOpenProject = vi.fn();
    const onStartRun = vi.fn();
    const user = userEvent.setup();
    const projects = [
      {
        id: "mind-myth-magick",
        name: "Mind, Myth and Magick",
        path: "/projects/mind-myth-and-magick",
        inputPath: "/projects/mind-myth-and-magick/input/raw",
        status: "completed" as const,
      },
    ];

    render(
      <ProjectsScreen
        onImportCorpus={onImportCorpus}
        onOpenProject={onOpenProject}
        onStartRun={onStartRun}
        projects={projects}
      />
    );

    const openButton = screen.getByRole("button", { name: /open/i });
    await user.click(openButton);
    expect(onOpenProject).toHaveBeenCalledWith("mind-myth-magick");

    const startRunButton = screen.getByRole("button", { name: /start run/i });
    await user.click(startRunButton);
    expect(onStartRun).toHaveBeenCalledWith(projects[0]);

    const importButtons = screen.getAllByRole("button", { name: /import corpus/i });
    await user.click(importButtons[0]);
    expect(onImportCorpus).toHaveBeenCalled();
  });

  it("shows active run progress details", () => {
    render(
      <ProjectsScreen
        onImportCorpus={vi.fn()}
        onOpenProject={vi.fn()}
        onStartRun={vi.fn()}
        projects={[
          {
            id: "proj-1",
            name: "Project One",
            path: "/projects/one",
            inputPath: "/projects/one/input",
            status: "processing",
          },
        ]}
        activeRunId="run-77"
        activeRunProgress={{
          runId: "run-77",
          projectId: "proj-1",
          stage: "analysis",
          processed: 4,
          total: 12,
          timestamp: new Date("2026-02-09T00:00:00.000Z").toISOString(),
        }}
      />
    );

    expect(screen.getByText(/run in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage: Analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/4 \/ 12 pages/i)).toBeInTheDocument();
  });
});
