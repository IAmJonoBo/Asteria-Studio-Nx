import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { JSX } from "react";
import { useKeyboardShortcut, useKeyboardShortcuts } from "./useKeyboardShortcut.js";

function ShortcutHarness(): JSX.Element {
  const [log, setLog] = useState<string[]>([]);
  useKeyboardShortcuts([
    {
      key: "a",
      handler: (): void => setLog((prev) => [...prev, "a"]),
      description: "A",
    },
    {
      key: "b",
      ctrlKey: true,
      handler: (): void => setLog((prev) => [...prev, "b"]),
      description: "B",
    },
  ]);

  return <div data-testid="log">{log.join(",")}</div>;
}

describe("useKeyboardShortcuts", () => {
  it("registers multiple shortcuts without hook violations", async () => {
    const user = userEvent.setup();
    render(<ShortcutHarness />);

    await user.keyboard("a");
    await user.keyboard("{Control>}b{/Control}");

    expect(screen.getByTestId("log")).toHaveTextContent("a,b");
  });
});

describe("useKeyboardShortcut", () => {
  it("respects disabled shortcuts", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();

    const DisabledHarness = (): JSX.Element => {
      useKeyboardShortcut({
        key: "x",
        handler,
        description: "Disabled",
        disabled: true,
      });
      return <div>disabled</div>;
    };

    render(<DisabledHarness />);
    await user.keyboard("x");

    expect(handler).not.toHaveBeenCalled();
  });

  it("triggers meta shortcuts on macOS", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const originalUserAgent = globalThis.navigator.userAgent;
    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: "MacIntel",
      configurable: true,
    });

    const MetaHarness = (): JSX.Element => {
      useKeyboardShortcut({
        key: "k",
        ctrlKey: true,
        handler,
        description: "Meta",
      });
      return <div>meta</div>;
    };

    render(<MetaHarness />);
    await user.keyboard("{Meta>}k{/Meta}");

    expect(handler).toHaveBeenCalledTimes(1);

    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it("ignores disabled shortcuts after re-render", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();

    const ToggleHarness = ({ disabled }: { disabled: boolean }): JSX.Element => {
      useKeyboardShortcut({
        key: "z",
        handler,
        description: "Toggle",
        disabled,
      });
      return <div>toggle</div>;
    };

    const { rerender } = render(<ToggleHarness disabled={false} />);
    await user.keyboard("z");
    rerender(<ToggleHarness disabled />);
    await user.keyboard("z");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handles modifier matching and disabled entries in shortcut lists", async () => {
    const user = userEvent.setup();
    const hits: string[] = [];
    const originalUserAgent = globalThis.navigator.userAgent;
    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: "MacIntel",
      configurable: true,
    });

    const ListHarness = (): JSX.Element => {
      useKeyboardShortcuts([
        {
          key: "g",
          ctrlKey: true,
          handler: (): void => {
            hits.push("disabled");
          },
          description: "Disabled",
          disabled: true,
        },
        {
          key: "g",
          ctrlKey: true,
          shiftKey: true,
          handler: (): void => {
            hits.push("active");
          },
          description: "Active",
        },
      ]);
      return <div>list</div>;
    };

    render(<ListHarness />);
    await user.keyboard("{Meta>}g{/Meta}");
    await user.keyboard("{Meta>}{Shift>}g{/Shift}{/Meta}");

    expect(hits).toEqual(["active"]);

    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it("no-ops when addEventListener is unavailable", () => {
    const originalAdd = globalThis.addEventListener;
    const originalRemove = globalThis.removeEventListener;
    Object.defineProperty(globalThis, "addEventListener", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(globalThis, "removeEventListener", {
      value: undefined,
      configurable: true,
    });

    const handler = vi.fn();
    const NoopHarness = (): JSX.Element => {
      useKeyboardShortcut({ key: "q", handler, description: "Noop" });
      return <div>noop</div>;
    };

    render(<NoopHarness />);

    Object.defineProperty(globalThis, "addEventListener", {
      value: originalAdd,
      configurable: true,
    });
    Object.defineProperty(globalThis, "removeEventListener", {
      value: originalRemove,
      configurable: true,
    });
  });
});
