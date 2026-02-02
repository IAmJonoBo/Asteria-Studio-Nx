import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueueScreen } from "./ReviewQueueScreen";

const resetAsteria = () => {
  delete (globalThis as typeof globalThis & { asteria?: unknown }).asteria;
};

describe("ReviewQueueScreen", () => {
  afterEach(() => {
    cleanup();
    resetAsteria();
  });

  it("renders empty state when no run selected", () => {
    render(<ReviewQueueScreen runId={undefined} />);

    expect(screen.getByText(/Select a run to review/i)).toBeInTheDocument();
  });

  it("renders empty state when queue has no items", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-1",
          projectId: "proj",
          generatedAt: "2024-01-01",
          items: [],
        }),
      },
    };

    render(<ReviewQueueScreen runId="run-1" />);

    expect(await screen.findByText(/No pages need review/i)).toBeInTheDocument();
  });

  it("shows sidecar error when fetch fails", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-2",
          projectId: "proj",
          generatedAt: "2024-01-01",
          items: [
            {
              pageId: "page-1",
              filename: "page-1.png",
              layoutProfile: "body",
              layoutConfidence: 0.6,
              reason: "semantic-layout",
              qualityGate: { accepted: true, reasons: [] },
              previews: [{ kind: "normalized", path: "/tmp/norm.png", width: 16, height: 16 }],
            },
          ],
        }),
        "asteria:fetch-sidecar": vi.fn().mockRejectedValue(new Error("no sidecar")),
      },
    };

    render(<ReviewQueueScreen runId="run-2" />);

    const pageEntries = await screen.findAllByText(/page-1\.png/i);
    expect(pageEntries.length).toBeGreaterThan(0);
    expect(await screen.findByText(/no sidecar/i)).toBeInTheDocument();
  });

  it("supports decisions, overlays, and submit flow", async () => {
    const submitReview = vi.fn().mockResolvedValue(undefined);

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-3",
          projectId: "proj",
          generatedAt: "2024-01-01",
          items: [
            {
              pageId: "page-1",
              filename: "page-1.png",
              layoutProfile: "body",
              layoutConfidence: 0.6,
              reason: "semantic-layout",
              qualityGate: { accepted: false, reasons: [] },
              previews: [
                { kind: "normalized", path: "/tmp/norm.png", width: 16, height: 16 },
                { kind: "source", path: "/tmp/source.png", width: 16, height: 16 },
              ],
            },
            {
              pageId: "page-2",
              filename: "page-2.png",
              layoutProfile: "body",
              layoutConfidence: 0.4,
              reason: "quality-gate",
              qualityGate: { accepted: false, reasons: ["low-mask-coverage"] },
              previews: [{ kind: "normalized", path: "/tmp/norm2.png", width: 16, height: 16 }],
            },
          ],
        }),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue({
          normalization: {
            cropBox: [0, 0, 10, 10],
            pageMask: [1, 1, 9, 9],
          },
          elements: [
            { id: "e1", type: "page_bounds", bbox: [0, 0, 10, 10] },
            { id: "e2", type: "text_block", bbox: [1, 1, 5, 5] },
          ],
        }),
        "asteria:submit-review": submitReview,
      },
    };

    const user = userEvent.setup();

    render(<ReviewQueueScreen runId="run-3" />);

    const pageEntries = await screen.findAllByText(/page-1\.png/i);
    expect(pageEntries.length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /hide overlays/i }));
    await user.click(screen.getByRole("button", { name: /show overlays/i }));

    await user.click(screen.getByRole("button", { name: /show source/i }));
    expect(await screen.findByAltText(/Source preview for page-1\.png/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /accept selected/i }));

    await user.click(screen.getByRole("checkbox", { name: /page mask/i }));

    const viewer = screen.getByRole("button", { name: /preview viewer/i });
    fireEvent.keyDown(viewer, { key: "+" });
    fireEvent.keyDown(viewer, { key: "-" });
    fireEvent.keyDown(viewer, { key: "0" });
    fireEvent.keyDown(viewer, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(viewer, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(viewer, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(viewer, { key: "ArrowRight", shiftKey: true });
    fireEvent.wheel(viewer, { deltaY: -1, ctrlKey: true });

    await user.click(screen.getByRole("checkbox", { name: /select page-1\.png/i }));
    await user.click(screen.getByRole("button", { name: /accept selected/i }));

    await user.click(screen.getByRole("button", { name: /accept all with same reason/i }));

    const page2Buttons = screen.getAllByRole("button", { name: /page-2\.png/i });
    await user.click(page2Buttons[0]);

    await user.click(screen.getByRole("button", { name: /accept page/i }));
    await user.click(screen.getByRole("button", { name: /undo decision/i }));

    await user.click(screen.getByRole("button", { name: /submit review/i }));
    expect(submitReview).toHaveBeenCalledWith(
      "run-3",
      expect.arrayContaining([{ pageId: "page-1", decision: "accept" }])
    );
  });
});
