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
      <ProjectsScreen onImportCorpus={vi.fn()} onOpenProject={vi.fn()} initialProjects={[]} />
    );

    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import corpus/i })).toBeInTheDocument();
  });

  it("opens project on click and keyboard", async () => {
    const onImportCorpus = vi.fn();
    const onOpenProject = vi.fn();
    const user = userEvent.setup();

    render(<ProjectsScreen onImportCorpus={onImportCorpus} onOpenProject={onOpenProject} />);

    const projectCard = screen.getByRole("button", { name: /mind, myth and magick/i });
    await user.click(projectCard);
    expect(onOpenProject).toHaveBeenCalledWith("mind-myth-magick");

    projectCard.focus();
    await user.keyboard("{Enter}");
    expect(onOpenProject).toHaveBeenCalled();

    const importButtons = screen.getAllByRole("button", { name: /import corpus/i });
    await user.click(importButtons[0]);
    expect(onImportCorpus).toHaveBeenCalled();
  });
});
