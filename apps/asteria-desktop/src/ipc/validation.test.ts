import { describe, expect, it } from "vitest";
import {
  validateExportFormat,
  validateOverrides,
  validatePageId,
  validatePageLayoutSidecar,
  validatePipelineRunConfig,
  validateRunId,
} from "./validation";
import type { PageLayoutSidecar, PipelineRunConfig } from "./contracts";

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

const buildValidSidecar = (): PageLayoutSidecar => ({
  pageId: "p1",
  source: { path: "/input/p1", checksum: "abc123", pageIndex: 0 },
  dimensions: { width: 210, height: 297, unit: "mm" },
  dpi: 300,
  normalization: {
    skewAngle: 0.2,
    dpiSource: "inferred",
    pageMask: [0, 0, 100, 100],
    cropBox: [0, 0, 100, 100],
    scale: 1,
    bleed: 3,
    trim: 0,
    shadow: { present: false, side: "none", widthPx: 0, confidence: 0.9, darkness: 0 },
    shading: {
      method: "border-regression",
      backgroundModel: "lowpass-v1",
      spineShadowModel: "banded-v1",
      params: { strength: 0.2 },
      confidence: 0.7,
    },
  },
  elements: [],
  metrics: {
    deskewConfidence: 0.9,
    maskCoverage: 0.85,
    shadowScore: 0.1,
    illuminationResidual: 0.05,
    spineShadowScore: 0.2,
    baseline: {
      medianSpacingPx: 18,
      spacingMAD: 1.2,
      lineStraightnessResidual: 0.03,
      confidence: 0.8,
    },
  },
  version: "0.1.0",
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

  it("accepts valid page layout sidecars", () => {
    expect(() => validatePageLayoutSidecar(buildValidSidecar())).not.toThrow();
  });

  it("rejects invalid shading confidence", () => {
    const invalid = buildValidSidecar();
    invalid.normalization.shading = { confidence: 2 };
    expect(() => validatePageLayoutSidecar(invalid)).toThrow(/shading.confidence/);
  });
});
