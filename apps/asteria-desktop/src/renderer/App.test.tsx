import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("shows headline and key points", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /projects/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/manage your corpus libraries/i)).toBeInTheDocument();
    expect(screen.getByText(/Mind, Myth and Magick/i)).toBeInTheDocument();
  });
});
