import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueueScreen } from "./ReviewQueueScreen.js";

describe("ReviewQueueScreen overrides", () => {
  it("reflects applied overrides in the UI", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } };
    const previousAsteria = windowRef.asteria;
    const applyOverride = vi.fn().mockResolvedValue(undefined);

    windowRef.asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-1",
          projectId: "project-1",
          generatedAt: "2026-02-02",
          items: [
            {
              pageId: "page-1",
              filename: "page-1.png",
              layoutProfile: "body",
              layoutConfidence: 0.82,
              qualityGate: { accepted: false, reasons: ["low-mask-coverage"] },
              reason: "quality-gate",
              previews: [
                {
                  kind: "normalized",
                  path: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6fYdS0AAAAASUVORK5CYII=",
                  width: 100,
                  height: 100,
                },
              ],
              suggestedAction: "adjust",
            },
          ],
        }),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue({
          pageId: "page-1",
          dpi: 300,
          normalization: {
            cropBox: [0, 0, 99, 99],
            pageMask: [0, 0, 99, 99],
            trim: 0,
          },
          elements: [],
        }),
        "asteria:apply-override": applyOverride,
      },
    };

    render(<ReviewQueueScreen runId="run-1" />);

    await screen.findByRole("button", { name: /apply override/i });
    await user.click(screen.getByRole("button", { name: /⟳/ }));
    await user.click(screen.getByRole("button", { name: /apply override/i }));

    expect(await screen.findByText(/Applied/i)).toBeInTheDocument();
    expect(applyOverride).toHaveBeenCalledWith(
      "run-1",
      "page-1",
      expect.objectContaining({
        normalization: expect.objectContaining({ rotationDeg: 0.5 }),
      })
    );

    windowRef.asteria = previousAsteria;
  });
});
