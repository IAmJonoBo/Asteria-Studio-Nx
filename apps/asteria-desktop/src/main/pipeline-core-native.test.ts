import { describe, expect, it, vi } from "vitest";

const createRequireMock = vi.fn();

vi.mock("node:module", () => ({
  createRequire: createRequireMock,
  default: { createRequire: createRequireMock },
}));

describe("pipeline-core native loader", () => {
  it("returns null when native module is unavailable", async () => {
    vi.resetModules();
    createRequireMock.mockReset();
    createRequireMock.mockReturnValue(() => {
      throw new Error("missing native module");
    });

    const { getPipelineCoreNative } = await import("./pipeline-core-native.ts");
    expect(getPipelineCoreNative()).toBeNull();
  });

  it("returns native module when exports are present", async () => {
    vi.resetModules();
    createRequireMock.mockReset();
    const fake = {
      processPageStub: vi.fn(() => "ok"),
      estimateSkewAngle: vi.fn(() => ({ angle: 0, confidence: 0.5 })),
      baselineMetrics: vi.fn(() => ({ lineConsistency: 0.8, textLineCount: 12 })),
      columnMetrics: vi.fn(() => ({ columnCount: 2, columnSeparation: 0.6 })),
      detectLayoutElements: vi.fn(() => []),
      projectionProfileX: vi.fn(() => [1]),
      projectionProfileY: vi.fn(() => [2]),
      sobelMagnitude: vi.fn(() => [3]),
      dhash9x8: vi.fn(() => "deadbeef"),
    };

    createRequireMock.mockReturnValue(() => fake);

    const { getPipelineCoreNative } = await import("./pipeline-core-native.ts");
    expect(getPipelineCoreNative()).toBe(fake);
  });
});
