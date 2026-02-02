import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { JSX } from "react";
import { useKeyboardShortcuts } from "./useKeyboardShortcut";

function ShortcutHarness(): JSX.Element {
  const [log, setLog] = useState<string[]>([]);
  useKeyboardShortcuts([
    {
      key: "a",
      handler: () => setLog((prev) => [...prev, "a"]),
      description: "A",
    },
    {
      key: "b",
      ctrlKey: true,
      handler: () => setLog((prev) => [...prev, "b"]),
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
