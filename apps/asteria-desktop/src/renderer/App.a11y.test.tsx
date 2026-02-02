import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";

describe("App - Navigation & Accessibility", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("renders navigation with all sections", () => {
    render(<App />);

    expect(screen.getByRole("navigation", { name: /main navigation/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /projects/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /run history/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /live monitor/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /review queue/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /exports/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /settings/i }).length).toBeGreaterThan(0);
  });

  it("navigates between sections on click", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getAllByRole("button", { name: /review queue/i })[0]);
    expect(screen.getByText(/select a run to review/i)).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /settings/i })[0]);
    expect(screen.getByText(/settings/i, { selector: "h1" })).toBeInTheDocument();
  });

  it("shows project list with cards", async () => {
    const windowRef = globalThis as typeof globalThis & {
      asteria?: { ipc: Record<string, unknown> };
    };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: {
        "asteria:list-projects": async () => [
          {
            id: "mind-myth-magick",
            name: "Mind, Myth and Magick",
            path: "/projects/mind-myth-and-magick",
            inputPath: "/projects/mind-myth-and-magick/input/raw",
            status: "completed",
          },
        ],
      },
    };

    render(<App />);

    expect(await screen.findByText(/Mind, Myth and Magick/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /import corpus/i }).length).toBeGreaterThan(0);

    windowRef.asteria = previousAsteria;
  });

  it("has keyboard-accessible command palette", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Open command palette with Ctrl+K
    const userAgent = globalThis.navigator?.userAgent ?? "";
    const isMac = userAgent.toUpperCase().includes("MAC");
    await user.keyboard(isMac ? "{Meta>}k{/Meta}" : "{Control>}k{/Control}");

    expect(screen.getAllByRole("dialog", { name: /command palette/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByPlaceholderText(/type a command/i).length).toBeGreaterThan(0);

    // Close with Escape
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: /command palette/i })).not.toBeInTheDocument();
  });

  it("supports theme toggle", async () => {
    const user = userEvent.setup();
    render(<App />);

    const themeButton = screen.getAllByRole("button", { name: /switch to dark theme/i })[0];
    await user.click(themeButton);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(
      screen.getAllByRole("button", { name: /switch to light theme/i }).length
    ).toBeGreaterThan(0);
  });

  it("maintains focus visibility", () => {
    render(<App />);

    const firstButton = screen.getAllByRole("button", { name: /projects/i })[0];
    firstButton.focus();

    expect(firstButton).toHaveFocus();
    // Focus styles are applied via CSS :focus-visible
  });
});
