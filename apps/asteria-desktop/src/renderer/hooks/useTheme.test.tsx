import type { JSX } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "./useTheme";

function ThemeProbe(): JSX.Element {
  const [theme, setTheme] = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Toggle</button>
    </div>
  );
}

describe("useTheme", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    cleanup();
  });

  it("uses stored theme when present", () => {
    localStorage.setItem("asteria-theme", "dark");
    render(<ThemeProbe />);

    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("uses system preference when no stored theme", async () => {
    let mediaListener: ((event: MediaQueryListEvent) => void) | null = null;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
        mediaListener = listener as (event: MediaQueryListEvent) => void;
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<ThemeProbe />);

    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    localStorage.removeItem("asteria-theme");
    const listener = mediaListener as ((event: MediaQueryListEvent) => void) | null;
    if (listener) {
      listener({ matches: false } as MediaQueryListEvent);
    }

    await waitFor(() => {
      expect(screen.getByTestId("theme-value")).toHaveTextContent("light");
    });
  });

  it("toggles theme and persists", async () => {
    const user = userEvent.setup();
    render(<ThemeProbe />);

    await user.click(screen.getAllByRole("button", { name: /toggle/i })[0]);

    expect(localStorage.getItem("asteria-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
