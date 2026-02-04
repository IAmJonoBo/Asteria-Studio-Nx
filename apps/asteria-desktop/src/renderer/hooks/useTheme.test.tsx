import type { JSX } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "./useTheme.js";

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
  const originalMatchMedia = globalThis.matchMedia;
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    const store = new Map<string, string>();
    const localStorageMock = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
    });
  });

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      writable: true,
    });
    cleanup();
  });

  it("uses stored theme when present", () => {
    globalThis.localStorage?.setItem("asteria-theme", "dark");
    render(<ThemeProbe />);

    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("uses system preference when no stored theme", async () => {
    type MediaEvent = { matches: boolean };
    let mediaListener: ((event: MediaEvent) => void) | null = null;
    globalThis.matchMedia = vi.fn().mockImplementation((query: string): MediaQueryList => {
      const mock = {
        matches: query.includes("dark"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_event: string, listener: EventListenerOrEventListenerObject): void => {
          if (typeof listener === "function") {
            mediaListener = listener as unknown as (event: MediaEvent) => void;
          } else if ("handleEvent" in listener) {
            mediaListener = (event: MediaEvent): void => {
              listener.handleEvent(event as unknown as Event);
            };
          }
        },
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
      return mock as MediaQueryList;
    });

    render(<ThemeProbe />);

    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    globalThis.localStorage?.removeItem("asteria-theme");
    const listener = mediaListener as ((event: MediaEvent) => void) | null;
    if (listener) {
      listener({ matches: false });
    }

    await waitFor(() => {
      expect(screen.getByTestId("theme-value")).toHaveTextContent("light");
    });
  });

  it("toggles theme and persists", async () => {
    const user = userEvent.setup();
    render(<ThemeProbe />);

    await user.click(screen.getAllByRole("button", { name: /toggle/i })[0]);

    expect(globalThis.localStorage?.getItem("asteria-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
