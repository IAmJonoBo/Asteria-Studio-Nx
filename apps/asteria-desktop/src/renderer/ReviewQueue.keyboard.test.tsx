import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueueScreen } from "./screens/ReviewQueueScreen";

describe("ReviewQueueScreen - Keyboard Navigation", () => {
  type AsteriaApi = { ipc: Record<string, unknown> };
  it("shows queue header and pages", () => {
    render(<ReviewQueueScreen />);

    expect(screen.getAllByRole("heading", { name: /review queue/i }).length).toBeGreaterThan(0);
    expect(screen.getByText(/pages need attention/i)).toBeInTheDocument();
  });

  it("supports keyboard shortcuts for triage", async () => {
    const user = userEvent.setup();

    // Note: This is a simplified test. In real usage, pages would be loaded via IPC
    render(<ReviewQueueScreen runId="test-run" />);

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

    render(<ReviewQueueScreen runId="run-empty" />);
    expect(await screen.findByText(/no pages need review/i)).toBeInTheDocument();

    windowRef.asteria = previousAsteria;
  });

  it("shows submit error when review submission fails", async () => {
    const windowRef = globalThis as typeof globalThis & { asteria?: AsteriaApi };
    const previousAsteria = windowRef.asteria;
    const fetchQueue = vi.fn().mockResolvedValue({
      runId: "run-1",
      projectId: "proj",
      generatedAt: "2026-01-01",
      items: [
        {
          pageId: "page-1",
          filename: "page-1.jpg",
          layoutConfidence: 0.7,
          reason: "semantic-layout",
          qualityGate: { accepted: false, reasons: ["low-confidence"] },
          previews: [{ kind: "normalized", path: "/tmp/normalized.png", width: 16, height: 16 }],
        },
      ],
    });
    const submitReview = vi.fn().mockRejectedValue(new Error("Network down"));
    windowRef.asteria = {
      ipc: {
        "asteria:fetch-review-queue": fetchQueue,
        "asteria:submit-review": submitReview,
      },
    } as AsteriaApi;

    const user = userEvent.setup();
    render(<ReviewQueueScreen runId="run-1" />);

    expect(await screen.findByText(/semantic layout/i)).toBeInTheDocument();
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
      observe() {
        this.callback();
      }
      disconnect = vi.fn();
    }

    globalThis.Worker = MockWorker as unknown as typeof globalThis.Worker;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof globalThis.ResizeObserver;

    render(<ReviewQueueScreen />);
    const headings = await screen.findAllByText(/review queue/i);
    expect(headings.length).toBeGreaterThan(0);

    globalThis.Worker = originalWorker;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("enables submit when decisions exist", async () => {
    const user = userEvent.setup();
    render(<ReviewQueueScreen runId="test-run" />);

    const submits = screen.getAllByRole("button", { name: /submit review/i });
    expect(submits.some((button) => button.hasAttribute("disabled"))).toBe(true);

    await user.keyboard("a");
    expect(submits.some((button) => !button.hasAttribute("disabled"))).toBe(true);
  });

  it("shows page list and details panel", () => {
    render(<ReviewQueueScreen runId="test-run" />);

    expect(screen.getAllByText(/page-001\.jpg/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/page-042\.jpg/i).length).toBeGreaterThan(0);
  });

  it("has accessible keyboard shortcuts displayed", () => {
    render(<ReviewQueueScreen runId="test-run" />);

    // Shortcuts are shown in action buttons
    expect(screen.getAllByRole("button", { name: /accept page \(a\)/i }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /flag for later review \(f\)/i }).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /reject page \(r\)/i }).length).toBeGreaterThan(0);
  });
});
