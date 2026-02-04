import type { JSX } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

const ProblemChild = (): JSX.Element => {
  throw new Error("Boom");
};

describe("ErrorBoundary", () => {
  it("renders fallback UI when a child throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("reloads the app when retry is clicked", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );

    expect(() => fireEvent.click(screen.getByRole("button", { name: /reload/i }))).not.toThrow();

    consoleSpy.mockRestore();
  });
});
