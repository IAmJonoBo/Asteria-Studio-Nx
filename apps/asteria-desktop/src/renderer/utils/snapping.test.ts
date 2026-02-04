import { describe, expect, it } from "vitest";
import { getBoxSnapCandidates, snapBoxWithSources } from "./snapping.js";

describe("snapping utilities", () => {
  it("builds snap candidates for all edges", () => {
    const candidates = getBoxSnapCandidates([1, 2, 3, 4], 0.9, "label", "src");
    expect(candidates).toEqual([
      { axis: "x", value: 1, confidence: 0.9, label: "label", sourceId: "src" },
      { axis: "x", value: 3, confidence: 0.9, label: "label", sourceId: "src" },
      { axis: "y", value: 2, confidence: 0.9, label: "label", sourceId: "src" },
      { axis: "y", value: 4, confidence: 0.9, label: "label", sourceId: "src" },
    ]);
  });

  it("snaps edges to best candidates based on priority and score", () => {
    const result = snapBoxWithSources({
      box: [0, 0, 100, 100],
      edges: ["left", "top"],
      sources: [
        {
          id: "disabled",
          enabled: false,
          priority: 5,
          minConfidence: 0,
          weight: 1,
          radius: 10,
          candidates: [{ axis: "x", value: 2, confidence: 1, sourceId: "disabled" }],
        },
        {
          id: "low",
          priority: 1,
          minConfidence: 0.8,
          weight: 1,
          radius: 10,
          candidates: [
            { axis: "x", value: 5, confidence: 0.5, sourceId: "low" },
            { axis: "y", value: 7, confidence: 0.9, sourceId: "low" },
          ],
        },
        {
          id: "zero-radius",
          priority: 1,
          minConfidence: 0.5,
          weight: 0.5,
          radius: 0,
          candidates: [{ axis: "y", value: 0, confidence: 0.9, sourceId: "zero-radius" }],
        },
        {
          id: "high",
          priority: 2,
          minConfidence: 0.5,
          weight: 1,
          radius: 10,
          label: "High",
          candidates: [
            { axis: "x", value: 8, confidence: 0.7, sourceId: "high" },
            { axis: "y", value: 6, confidence: 0.9, sourceId: "high" },
          ],
        },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.box[0]).toBe(8);
    expect(result.box[1]).toBe(6);
    expect(result.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge: "left", value: 8, sourceId: "high" }),
        expect.objectContaining({ edge: "top", value: 6, sourceId: "high" }),
      ])
    );
  });

  it("returns original box when no candidates match", () => {
    const result = snapBoxWithSources({
      box: [10, 10, 20, 20],
      edges: ["right"],
      sources: [
        {
          id: "none",
          priority: 1,
          minConfidence: 0.9,
          weight: 1,
          radius: 2,
          candidates: [{ axis: "x", value: 100, confidence: 0.1, sourceId: "none" }],
        },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.box).toEqual([10, 10, 20, 20]);
    expect(result.guides).toEqual([]);
  });
});
