import { describe, expect, it } from "vitest";
import {
  validateExportFormat,
  validateOverrides,
  validatePageId,
  validatePipelineRunConfig,
  validateRunId,
} from "./validation";
import type { PipelineRunConfig } from "./contracts";

const buildValidConfig = (): PipelineRunConfig => ({
  projectId: "proj-1",
  pages: [
    {
      id: "p1",
      filename: "page1.png",
      originalPath: "/input/p1",
      confidenceScores: { modelA: 0.9 },
    },
  ],
  targetDpi: 300,
  targetDimensionsMm: { width: 210, height: 297 },
});

describe("IPC validation", () => {
  it("accepts a valid pipeline config", () => {
    expect(() => validatePipelineRunConfig(buildValidConfig())).not.toThrow();
  });

  it("rejects configs missing required fields", () => {
    const invalid = buildValidConfig();
    invalid.projectId = "";

    expect(() => validatePipelineRunConfig(invalid)).toThrow(/projectId/);
  });

  it("rejects pages with non-numeric confidence scores", () => {
    const invalid = buildValidConfig();
    invalid.pages[0].confidenceScores = { bad: Number.NaN };

    expect(() => validatePipelineRunConfig(invalid)).toThrow(/confidenceScores/);
  });

  it("rejects unsafe overrides", () => {
    expect(() => validateOverrides({ fn: () => null })).toThrow(/overrides/);
  });

  it("rejects invalid ids and formats", () => {
    expect(() => validateRunId("")).toThrow(/run id/);
    expect(() => validatePageId("")).toThrow(/page id/);
    expect(() => validateExportFormat("jpeg" as never)).toThrow(/format/);
  });
});
