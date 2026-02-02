import { describe, expect, it, vi } from "vitest";

describe("reviewQueueWorker", () => {
  it("sorts pages by confidence", async () => {
    const postMessage = vi.fn();
    (
      globalThis as typeof globalThis & {
        postMessage?: (message: unknown) => void;
        onmessage?: ((event: { data: unknown }) => void) | null;
      }
    ).postMessage = postMessage;

    vi.resetModules();
    await import("./reviewQueueWorker");

    const handler = (
      globalThis as typeof globalThis & {
        onmessage?: (event: { data: { pages?: unknown[] } }) => void;
      }
    ).onmessage;

    handler?.({
      data: {
        pages: [
          { id: "a", filename: "a.png", reason: "", confidence: 0.9, issues: [] },
          { id: "b", filename: "b.png", reason: "", confidence: 0.2, issues: [] },
        ],
      },
    });

    handler?.({
      data: {
        pages: undefined,
      },
    });

    expect(postMessage).toHaveBeenCalledWith({
      pages: [
        { id: "b", filename: "b.png", reason: "", confidence: 0.2, issues: [] },
        { id: "a", filename: "a.png", reason: "", confidence: 0.9, issues: [] },
      ],
    });
    expect(postMessage).toHaveBeenLastCalledWith({ pages: [] });
  });
});
