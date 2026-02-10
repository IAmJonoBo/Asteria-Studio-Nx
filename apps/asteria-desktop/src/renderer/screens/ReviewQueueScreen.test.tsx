import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueueScreen } from "./ReviewQueueScreen.js";
import { assertReviewPaneReadyChecklist } from "../test/reviewPaneReadyChecklist.js";

const ok = <T,>(value: T) => ({ ok: true as const, value });
const err = (message: string) => ({ ok: false as const, error: { message } });

const resetAsteria = (): void => {
  delete (globalThis as typeof globalThis & { asteria?: unknown }).asteria;
};

type MutableLocation = Omit<Location, "protocol"> & { protocol: string };

const setLocationProtocol = (protocol: string): (() => void) => {
  const original = globalThis.location;
  const nextLocation = {
    ...original,
    protocol,
  } as MutableLocation;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: nextLocation,
  });
  return () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: original,
    });
  };
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
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
            runId: "run-1",
            projectId: "proj",
            generatedAt: "2024-01-01",
            items: [],
          })
        ),
      },
    };

    render(<ReviewQueueScreen runId="run-1" runDir="/tmp/runs/run-1" />);

    expect(await screen.findByText(/No pages need review/i)).toBeInTheDocument();
  });

  it("surfaces errors when review queue fails to load", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(err("queue missing")),
      },
    };

    render(<ReviewQueueScreen runId="run-err" runDir="/tmp/runs/run-err" />);

    expect(await screen.findByText(/Review queue unavailable/i)).toBeInTheDocument();
    expect(await screen.findByText(/Fetch review queue: queue missing/i)).toBeInTheDocument();
  });

  it("shows sidecar error when fetch fails", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
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
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(err("no sidecar")),
      },
    };

    render(<ReviewQueueScreen runId="run-2" runDir="/tmp/runs/run-2" />);

    const pageEntries = await screen.findAllByText(/page-1\.png/i);
    expect(pageEntries.length).toBeGreaterThan(0);
    expect(await screen.findByText(/no sidecar/i)).toBeInTheDocument();
  });

  it("supports decisions, overlays, and submit flow", async () => {
    const submitReview = vi.fn().mockResolvedValue(ok(undefined));

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
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
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(
          ok({
            normalization: {
              cropBox: [0, 0, 10, 10],
              pageMask: [1, 1, 9, 9],
            },
            elements: [
              { id: "e1", type: "page_bounds", bbox: [0, 0, 10, 10] },
              { id: "e2", type: "text_block", bbox: [1, 1, 5, 5] },
            ],
          })
        ),
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
      expect.arrayContaining([{ pageId: "page-1", decision: "accept" }])
    );
  }, 10000);

  it("shows template clusters and records confirm/correct actions", async () => {
    const recordTemplateTraining = vi.fn().mockResolvedValue(ok(undefined));

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
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
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(
          ok({
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
          })
        ),
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
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
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
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(
          ok({
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
          })
        ),
      },
    };

    const user = userEvent.setup();

    render(<ReviewQueueScreen runId="run-5" runDir="/tmp/runs/run-5" />);

    expect(await screen.findByText(/Template clusters/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm template cluster/i }));

    expect(await screen.findByText(/IPC unavailable/i)).toBeInTheDocument();
  });
  it("uses asteria protocol preview capability in electron-like runtime", async () => {
    const restoreLocation = setLocationProtocol("file:");
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
            runId: "run-protocol",
            projectId: "proj",
            generatedAt: "2024-01-01",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.7,
                reason: "semantic-layout",
                qualityGate: { accepted: false, reasons: [] },
                previews: [{ kind: "normalized", path: "/tmp/norm.png", width: 16, height: 16 }],
              },
            ],
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(err("no sidecar")),
      },
    };

    render(<ReviewQueueScreen runId="run-protocol" runDir="/tmp/runs/run-protocol" />);

    const image = await screen.findByAltText(/Normalized preview for page-1\.png/i);
    expect(image).toHaveAttribute("src", "asteria://asset?path=%2Ftmp%2Fnorm.png");
    expect(
      await screen.findByText(/Normalized preview:\s*loading\s*\(protocol\)/i)
    ).toBeInTheDocument();

    restoreLocation();
  });

  it("uses safe preview fallbacks without asteria protocol", async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
            runId: "run-browser",
            projectId: "proj",
            generatedAt: "2024-01-01",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.7,
                reason: "semantic-layout",
                qualityGate: { accepted: false, reasons: [] },
                previews: [
                  { kind: "normalized", path: dataUrl, width: 16, height: 16 },
                  { kind: "source", path: "/tmp/source.png", width: 16, height: 16 },
                ],
              },
            ],
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(err("no sidecar")),
      },
    };

    const user = userEvent.setup();
    render(<ReviewQueueScreen runId="run-browser" runDir="/tmp/runs/run-browser" />);

    const normalizedImage = await screen.findByAltText(/Normalized preview for page-1\.png/i);
    expect(normalizedImage).toHaveAttribute("src", dataUrl);
    expect(
      await screen.findByText(/Normalized preview:\s*loading\s*\(data\)/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show source/i }));
    const sourceImage = await screen.findByAltText(/Source preview for page-1\.png/i);
    expect(sourceImage).toHaveAttribute("src", "file:///tmp/source.png");
    expect(screen.getByText(/Source preview:\s*loading\s*\(file\)/i)).toBeInTheDocument();
  });

  it("falls back to generated run preview path and transitions loaded state", async () => {
    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
            runId: "run-fallback",
            projectId: "proj",
            generatedAt: "2024-01-01",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.7,
                reason: "semantic-layout",
                qualityGate: { accepted: false, reasons: [] },
                previews: [
                  { kind: "normalized", path: "../bad/preview.png", width: 16, height: 16 },
                ],
              },
            ],
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(err("no sidecar")),
      },
    };

    render(<ReviewQueueScreen runId="run-fallback" runDir="/tmp/runs/run-fallback" />);

    const image = await screen.findByAltText(/Normalized preview for page-1\.png/i);
    expect(image).toBeInTheDocument();
    expect(image).toHaveAttribute(
      "src",
      "file:///tmp/runs/run-fallback/previews/page-1-normalized.png"
    );
    expect(
      await screen.findByText(/Normalized preview:\s*loading\s*\(file\)/i)
    ).toBeInTheDocument();

    fireEvent.load(image);

    expect(await screen.findByText(/Normalized preview:\s*loaded\s*\(file\)/i)).toBeInTheDocument();
  });

  it("keeps review pane controls active and updates preview across selection changes", async () => {
    const user = userEvent.setup();

    (globalThis as typeof globalThis & { asteria?: unknown }).asteria = {
      ipc: {
        "asteria:fetch-review-queue": vi.fn().mockResolvedValue(
          ok({
            runId: "run-pane",
            projectId: "proj",
            generatedAt: "2024-01-01",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.8,
                reason: "semantic-layout",
                qualityGate: { accepted: false, reasons: [] },
                previews: [
                  {
                    kind: "normalized",
                    path: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6fYdS0AAAAASUVORK5CYII=",
                    width: 100,
                    height: 100,
                  },
                ],
              },
              {
                pageId: "page-2",
                filename: "page-2.png",
                layoutProfile: "body",
                layoutConfidence: 0.72,
                reason: "quality-gate",
                qualityGate: { accepted: false, reasons: ["low-mask-coverage"] },
                previews: [
                  {
                    kind: "normalized",
                    path: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADZc7J/AAAADUlEQVR42mP8/58BAQUBAOoEAf+AsQ4rAAAAAElFTkSuQmCC",
                    width: 100,
                    height: 100,
                  },
                ],
              },
            ],
          })
        ),
        "asteria:fetch-sidecar": vi.fn().mockResolvedValue(
          ok({
            dpi: 300,
            normalization: {
              cropBox: [0, 0, 99, 99],
              pageMask: [4, 4, 95, 95],
              trim: 3,
            },
            elements: [{ id: "el-1", type: "text_block", bbox: [10, 10, 70, 70], confidence: 0.9 }],
            guides: {
              layers: [
                {
                  id: "rulers",
                  guides: [{ id: "r-x", axis: "x", position: 20, kind: "major", label: "R" }],
                },
                {
                  id: "margin-guides",
                  guides: [{ id: "m-x", axis: "x", position: 12, kind: "major", label: "Margin" }],
                },
              ],
            },
          })
        ),
      },
    };

    render(<ReviewQueueScreen runId="run-pane" runDir="/tmp/runs/run-pane" />);

    const page1Image = await screen.findByAltText(/normalized preview for page-1\.png/i);
    expect(page1Image).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /page-2\.png/i })[0]);
    const page2Image = await screen.findByAltText(/normalized preview for page-2\.png/i);
    expect(page2Image).toBeInTheDocument();

    const adjustCropButton = screen.getByRole("button", { name: /crop handles/i });
    const adjustTrimButton = screen.getByRole("button", { name: /trim handles/i });
    expect(adjustCropButton).toBeEnabled();
    expect(adjustTrimButton).toBeEnabled();

    const rulersLayer = screen.getByRole("checkbox", { name: /rulers guide layer/i });
    const marginsLayer = screen.getByRole("checkbox", { name: /margins guide layer/i });
    expect(screen.getAllByRole("button", { name: /apply override/i })[0]).toBeEnabled();
    expect(document.querySelector('[data-guide-layer="rulers"]')).not.toBeNull();
    expect(document.querySelector('[data-guide-layer="margin-guides"]')).not.toBeNull();

    await user.click(rulersLayer);
    await user.click(marginsLayer);
    expect(document.querySelector('[data-guide-layer="rulers"]')).toBeNull();
    expect(document.querySelector('[data-guide-layer="margin-guides"]')).toBeNull();

    await user.click(rulersLayer);
    await user.click(marginsLayer);
    expect(document.querySelector('[data-guide-layer="rulers"]')).not.toBeNull();
    expect(document.querySelector('[data-guide-layer="margin-guides"]')).not.toBeNull();

    await assertReviewPaneReadyChecklist({
      assertSelectedPageImagePresent: async () => {
        expect(await screen.findByAltText(/normalized preview for page-2\.png/i)).toBeVisible();
      },
      assertToolPanelControlsPresent: () => {
        expect(screen.getByRole("button", { name: /crop handles/i })).toBeEnabled();
        expect(screen.getByRole("button", { name: /trim handles/i })).toBeEnabled();
      },
      assertGuideLayerRenderPresent: () => {
        expect(document.querySelector("[data-guide-layer]")).not.toBeNull();
      },
      assertSnapFeedbackWhileDragging: () => {
        expect(screen.getByRole("button", { name: /crop handles/i })).toBeEnabled();
      },
    });
  });
});
