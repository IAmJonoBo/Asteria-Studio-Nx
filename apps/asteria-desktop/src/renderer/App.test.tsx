import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("shows headline and key points", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: /enterprise page normalization/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Deskew & dewarp with confidence scoring/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Hook up IPC to the orchestrator/i),
    ).toBeInTheDocument();
  });
});
