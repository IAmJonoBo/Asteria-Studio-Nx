import { describe, expect, it } from "vitest";
import {
  validateExportFormat,
  validateOverrides,
  validatePageId,
  validatePageLayoutSidecar,
  validatePipelineRunConfig,
  validateRunId,
  validateTemplateTrainingSignal,
} from "./validation.js";
import type { PageLayoutSidecar, PipelineRunConfig, TemplateTrainingSignal } from "./contracts.js";

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

describe("validateTemplateTrainingSignal", () => {
  const buildValidSignal = (): TemplateTrainingSignal => ({
    templateId: "body",
    scope: "template",
    appliedAt: "2026-02-03T15:00:00Z",
    pages: ["page-1", "page-2"],
    overrides: { normalization: { rotationDeg: 0.5 } },
    sourcePageId: "page-1",
    layoutProfile: "body",
  });

  it("accepts valid template training signals", () => {
    expect(() => validateTemplateTrainingSignal(buildValidSignal())).not.toThrow();
  });

  it("accepts section scope", () => {
    const signal = buildValidSignal();
    signal.scope = "section";
    expect(() => validateTemplateTrainingSignal(signal)).not.toThrow();
  });

  it("rejects signal when templateId is missing", () => {
    const invalid = buildValidSignal();
    delete (invalid as Partial<TemplateTrainingSignal>).templateId;
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/templateId required/);
  });

  it("rejects signal when scope is invalid", () => {
    const invalid = buildValidSignal();
    (invalid as { scope: string }).scope = "invalid";
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/scope must be template or section/);
  });

  it("rejects signal when appliedAt is missing", () => {
    const invalid = buildValidSignal();
    delete (invalid as Partial<TemplateTrainingSignal>).appliedAt;
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/appliedAt required/);
  });

  it("rejects signal when pages array is empty", () => {
    const invalid = buildValidSignal();
    invalid.pages = [];
    expect(() => validateTemplateTrainingSignal(invalid)).toThrow(/pages must be a non-empty array/);
  });

  it("rejects signal when pages contains non-string", () => {
    const invalid = buildValidSignal();
    (invalid.pages as unknown[]) = ["page-1", 123];
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/pages\[1\] must be a string/);
  });

  it("validates nested overrides", () => {
    const invalid = buildValidSignal();
    invalid.overrides = { normalization: { fn: () => null } };
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/overrides/);
  });

  it("accepts optional sourcePageId and layoutProfile", () => {
    const signal = buildValidSignal();
    delete signal.sourcePageId;
    delete signal.layoutProfile;
    expect(() => validateTemplateTrainingSignal(signal)).not.toThrow();
  });

  it("rejects when sourcePageId is not a string", () => {
    const invalid = buildValidSignal();
    (invalid as { sourcePageId: unknown }).sourcePageId = 123;
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/sourcePageId must be a string/);
  });

  it("rejects when layoutProfile is not a string", () => {
    const invalid = buildValidSignal();
    (invalid as { layoutProfile: unknown }).layoutProfile = 123;
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(/layoutProfile must be a string/);
  });
});
