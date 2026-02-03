import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../../ipc/contracts.js";
import { getGuideLod } from "./registry.js";

describe("guide registry LOD thresholds", () => {
  it("responds to guide LOD config changes", () => {
    const zoom = 0.8;
    const relaxedConfig = {
      guides: { lod: { major_only_zoom: 0.5, labels_zoom: 1.0 } },
    } as PipelineConfig;
    const strictConfig = {
      guides: { lod: { major_only_zoom: 0.9, labels_zoom: 1.8 } },
    } as PipelineConfig;

    expect(getGuideLod(zoom, relaxedConfig)).toEqual({
      showMinorGuides: true,
      labelVisibility: "hover",
    });
    expect(getGuideLod(zoom, strictConfig)).toEqual({
      showMinorGuides: false,
      labelVisibility: "none",
    });
  });
});
