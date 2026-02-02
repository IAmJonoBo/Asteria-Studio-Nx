import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";

describe("App - Navigation & Accessibility", () => {
  beforeEach(() => {
    localStorage.clear();
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
    expect(screen.getAllByRole("heading", { name: /review queue/i }).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole("button", { name: /settings/i })[0]);
    expect(screen.getByText(/settings/i, { selector: "h1" })).toBeInTheDocument();
  });

  it("shows project list with cards", () => {
    render(<App />);

    expect(screen.getAllByText(/Mind, Myth and Magick/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /import corpus/i }).length).toBeGreaterThan(0);
  });

  it("has keyboard-accessible command palette", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Open command palette with Ctrl+K
    const isMac = navigator.platform.toUpperCase().includes("MAC");
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

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
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
