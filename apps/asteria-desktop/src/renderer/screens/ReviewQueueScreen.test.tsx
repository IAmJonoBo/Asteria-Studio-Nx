import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueueScreen } from "./ReviewQueueScreen.js";

const resetAsteria = (): void => {
  delete (globalThis as typeof globalThis & { asteria?: unknown }).asteria;
};

describe("ReviewQueueScreen", () => {
  afterEach(() => {
    cleanup();
    resetAsteria();
  });

  it("renders empty state when no run selected", () => {
    render(<ReviewQueueScreen runId={undefined} runDir={undefined} />);

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

    render(<ReviewQueueScreen runId="run-1" runDir="/tmp/runs/run-1" />);

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

    render(<ReviewQueueScreen runId="run-2" runDir="/tmp/runs/run-2" />);

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

    render(<ReviewQueueScreen runId="run-3" runDir="/tmp/runs/run-3" />);

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
      "/tmp/runs/run-3",
      expect.arrayContaining([{ pageId: "page-1", decision: "accept" }])
    );
  }, 10000);

  it("shows template clusters and records confirm/correct actions", async () => {
    const recordTemplateTraining = vi.fn().mockResolvedValue(undefined);

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-4",
          projectId: "proj",
          generatedAt: "2024-01-01",
          items: [
            {
              pageId: "page-1",
              filename: "page-1.png",
              layoutProfile: "body",
              layoutConfidence: 0.8,
              reason: "semantic-layout",
              qualityGate: { accepted: true, reasons: [] },
              previews: [{ kind: "normalized", path: "/tmp/norm.png", width: 16, height: 16 }],
            },
          ],
        }),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue({
          templateId: "template-01",
          templateConfidence: 0.82,
          bookModel: {
            pageTemplates: [
              {
                id: "template-01",
                pageType: "body",
                pageIds: ["page-1", "page-2"],
                confidence: 0.75,
              },
              {
                id: "template-02",
                pageType: "body",
                pageIds: ["page-3"],
                confidence: 0.65,
              },
            ],
          },
          normalization: {},
          elements: [],
        }),
        "asteria:record-template-training": recordTemplateTraining,
      },
    };

    const user = userEvent.setup();

    render(<ReviewQueueScreen runId="run-4" runDir="/tmp/runs/run-4" />);

    expect(await screen.findByText(/Template clusters/i)).toBeInTheDocument();
    expect(screen.getAllByText(/template-01/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /confirm template cluster/i }));

    expect(recordTemplateTraining).toHaveBeenCalledWith(
      "run-4",
      expect.objectContaining({
        templateId: "template-01",
        scope: "template",
        pages: ["page-1"],
      })
    );
    expect(await screen.findByText(/Template assignment confirmed/i)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /template cluster selection/i }),
      "template-02"
    );
    await user.click(screen.getByRole("button", { name: /correct template cluster/i }));

    expect(recordTemplateTraining).toHaveBeenCalledWith(
      "run-4",
      expect.objectContaining({
        templateId: "template-02",
        scope: "template",
      })
    );
    expect(await screen.findByText(/Template correction saved/i)).toBeInTheDocument();
  });

  it("shows template action errors when IPC is unavailable", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue({
          runId: "run-5",
          projectId: "proj",
          generatedAt: "2024-01-01",
          items: [
            {
              pageId: "page-1",
              filename: "page-1.png",
              layoutProfile: "body",
              layoutConfidence: 0.8,
              reason: "semantic-layout",
              qualityGate: { accepted: true, reasons: [] },
              previews: [{ kind: "normalized", path: "/tmp/norm.png", width: 16, height: 16 }],
            },
          ],
        }),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue({
          templateId: "template-01",
          bookModel: {
            pageTemplates: [
              {
                id: "template-01",
                pageType: "body",
                pageIds: ["page-1"],
                confidence: 0.9,
              },
            ],
          },
          normalization: {},
          elements: [],
        }),
      },
    };

    const user = userEvent.setup();

    render(<ReviewQueueScreen runId="run-5" runDir="/tmp/runs/run-5" />);

    expect(await screen.findByText(/Template clusters/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm template cluster/i }));

    expect(await screen.findByText(/IPC unavailable/i)).toBeInTheDocument();
  });
});
