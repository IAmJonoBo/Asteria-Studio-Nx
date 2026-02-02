import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsScreen } from "./screens/ProjectsScreen";

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
});
