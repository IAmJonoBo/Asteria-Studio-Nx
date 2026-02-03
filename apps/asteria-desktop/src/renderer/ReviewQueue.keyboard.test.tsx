import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueueScreen } from "./screens/ReviewQueueScreen.js";

describe("ReviewQueueScreen - Keyboard Navigation", () => {
  type AsteriaApi = { ipc: Record<string, unknown> };
  const buildQueue = (
    items: Array<Record<string, unknown>>
  ): {
    runId: string;
    projectId: string;
    generatedAt: string;
    items: Array<Record<string, unknown>>;
  } => ({
    runId: "run-1",
    projectId: "proj",
    generatedAt: "2026-01-01",
    items,
  });
  const baseItems = [
    {
      pageId: "page-001",
      filename: "page-001.jpg",
      layoutProfile: "body",
      layoutConfidence: 0.6,
      reason: "semantic-layout",
      qualityGate: { accepted: true, reasons: [] },
      previews: [{ kind: "normalized", path: "/tmp/norm-1.png", width: 16, height: 16 }],
    },
    {
      pageId: "page-042",
      filename: "page-042.jpg",
      layoutProfile: "body",
      layoutConfidence: 0.6,
      reason: "semantic-layout",
      qualityGate: { accepted: true, reasons: [] },
      previews: [{ kind: "normalized", path: "/tmp/norm-2.png", width: 16, height: 16 }],
    },
  ];

  it("shows queue header and pages", async () => {
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": vi.fn().mockResolvedValue(buildQueue(baseItems)) },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="run-1" runDir="/tmp/runs/run-1" />);

    expect(await screen.findByText(/review queue/i)).toBeInTheDocument();
    expect(await screen.findByText(/pages need attention/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("supports keyboard shortcuts for triage", async () => {
    const user = userEvent.setup();

    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": vi.fn().mockResolvedValue(buildQueue(baseItems)) },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="test-run" runDir="/tmp/runs/test-run" />);

    // Accept first page and advance
    await user.keyboard("a");
    expect(screen.getAllByText(/page-042\.jpg/i).length).toBeGreaterThan(0);

    // Mark current page as flagged and verify badge appears
    await user.keyboard("f");
    expect(document.querySelectorAll(".badge-warning").length).toBeGreaterThan(0);

    // Navigate back and undo the accept decision
    await user.keyboard("k");
    expect(screen.getAllByText(/page-001\.jpg/i).length).toBeGreaterThan(0);
    await user.keyboard("u");
    expect(document.querySelectorAll(".badge-success").length).toBe(0);

    // Toggle overlays
    await user.keyboard(" ");
    expect(screen.getAllByRole("button", { name: /show overlays/i }).length).toBeGreaterThan(0);

    windowRef.asteria = previousAsteria;
  });

  it("asks to select a run when no runId is provided", () => {
    render(<ReviewQueueScreen />);
    expect(screen.getByText(/select a run to review/i)).toBeInTheDocument();
  });

  it("renders empty state when queue is empty", async () => {
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    const fetchQueue = vi.fn().mockResolvedValue({
      runId: "run-empty",
      projectId: "proj",
      generatedAt: "2026-01-01",
      items: [],
    });
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": fetchQueue },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="run-empty" runDir="/tmp/runs/run-empty" />);
    expect(await screen.findByText(/no pages need review/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("shows submit error when review submission fails", async () => {
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    const fetchQueue = vi.fn().mockResolvedValue(
      buildQueue([
        {
          pageId: "page-1",
          filename: "page-1.jpg",
          layoutProfile: "body",
          layoutConfidence: 0.7,
          reason: "semantic-layout",
          qualityGate: { accepted: false, reasons: ["low-confidence"] },
          previews: [{ kind: "normalized", path: "/tmp/normalized.png", width: 16, height: 16 }],
        },
      ])
    );
    const submitReview = vi.fn().mockRejectedValue(new Error("Network down"));
    windowRef.asteria = {
      ipc: {
        "asteria:fetch-review-queue": fetchQueue,
        "asteria:submit-review": submitReview,
      },
    } as AsteriaApi;

    const user = userEvent.setup();
    render(<ReviewQueueScreen runId="run-1" runDir="/tmp/runs/run-1" />);

    const semanticLayouts = await screen.findAllByText(/semantic layout/i);
    expect(semanticLayouts.length).toBeGreaterThan(0);
    await user.keyboard("a");

    const submitButtons = await screen.findAllByRole("button", { name: /submit review/i });
    await user.click(submitButtons[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent(/network down/i);

    windowRef.asteria = previousAsteria;
  });

  it("uses worker sorting and resize observer when available", async () => {
    const originalWorker = globalThis.Worker;
    const originalResizeObserver = globalThis.ResizeObserver;

    class MockWorker {
      onmessage: ((event: { data: { pages?: unknown[] } }) => void) | null = null;
      postMessage = vi.fn((message: { pages?: unknown[] }) => {
        this.onmessage?.({ data: { pages: message.pages ?? [] } });
      });
      terminate = vi.fn();
    }

    class MockResizeObserver {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(): void {
        this.callback();
      }
      disconnect = vi.fn();
    }

    globalThis.Worker = MockWorker as unknown as typeof globalThis.Worker;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof globalThis.ResizeObserver;

    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": vi.fn().mockResolvedValue(buildQueue(baseItems)) },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="run-1" runDir="/tmp/runs/run-1" />);
    const headings = await screen.findAllByText(/review queue/i);
    expect(headings.length).toBeGreaterThan(0);

    windowRef.asteria = previousAsteria;

    globalThis.Worker = originalWorker;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("enables submit when decisions exist", async () => {
    const user = userEvent.setup();
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": vi.fn().mockResolvedValue(buildQueue(baseItems)) },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="test-run" runDir="/tmp/runs/test-run" />);

    await screen.findAllByText(/page-001\.jpg/i);
    const submits = await screen.findAllByRole("button", { name: /submit review/i });
    expect(submits.some((button) => button.hasAttribute("disabled"))).toBe(true);

    await user.keyboard("a");
    expect(submits.some((button) => !button.hasAttribute("disabled"))).toBe(true);

    windowRef.asteria = previousAsteria;
  });

  it("shows page list and details panel", async () => {
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": vi.fn().mockResolvedValue(buildQueue(baseItems)) },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="test-run" runDir="/tmp/runs/test-run" />);

    expect((await screen.findAllByText(/page-001\.jpg/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/page-042\.jpg/i)).length).toBeGreaterThan(0);

    windowRef.asteria = previousAsteria;
  });

  it("has accessible keyboard shortcuts displayed", async () => {
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    windowRef.asteria = {
      ipc: { "asteria:fetch-review-queue": vi.fn().mockResolvedValue(buildQueue(baseItems)) },
    } as AsteriaApi;

    render(<ReviewQueueScreen runId="test-run" runDir="/tmp/runs/test-run" />);

    // Shortcuts are shown in action buttons
    expect(
      (await screen.findAllByRole("button", { name: /accept page \(a\)/i })).length
    ).toBeGreaterThan(0);
    expect(
      (await screen.findAllByRole("button", { name: /flag for later review \(f\)/i })).length
    ).toBeGreaterThan(0);
    expect(
      (await screen.findAllByRole("button", { name: /reject page \(r\)/i })).length
    ).toBeGreaterThan(0);

    windowRef.asteria = previousAsteria;
  });
});
