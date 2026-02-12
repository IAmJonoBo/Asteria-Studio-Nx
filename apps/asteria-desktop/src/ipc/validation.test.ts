import { describe, expect, it } from "vitest";
import {
  validateAppPreferencesUpdate,
  validateExportFormat,
  validateExportFormats,
  validateImportCorpusRequest,
  validateOverrides,
  validatePageId,
  validatePageLayoutOverrides,
  validatePipelineConfigOverrides,
  validatePageLayoutSidecar,
  validateProjectId,
  validatePipelineRunConfig,
  validateRunHistoryCleanupOptions,
  sanitizeReviewQueue,
  validateReviewDecisions,
  validateReviewQueue,
  validateRunId,
  validateRunDir,
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

    expect(() => validatePipelineRunConfig(invalid)).toThrow(/project id/i);
  });

  it("rejects pages with non-numeric confidence scores", () => {
    const invalid = buildValidConfig();
    invalid.pages[0].confidenceScores = { bad: Number.NaN };

    expect(() => validatePipelineRunConfig(invalid)).toThrow(/confidenceScores/);
  });

  it("rejects unsafe overrides", () => {
    expect(() => validateOverrides({ fn: () => null })).toThrow(/overrides/);
  });

  it("rejects overly deep overrides", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
    expect(() => validateOverrides(deep)).toThrow(/JSON-safe/);
  });

  it("rejects invalid ids and formats", () => {
    expect(() => validateRunId("")).toThrow(/run id/);
    expect(() => validatePageId("")).toThrow(/page id/);
    expect(() => validateExportFormat("jpeg" as never)).toThrow(/format/);
  });

  it("validates run directory shape and runId", () => {
    expect(() => validateRunDir("/tmp/pipeline-results/runs/run-1", "run-1")).not.toThrow();
    expect(() => validateRunDir("/tmp/pipeline-results/run-1", "run-1")).toThrow(/runs/);
    expect(() => validateRunDir("/tmp/pipeline-results/runs/run-1", "run-2")).toThrow(/mismatch/);
  });

  it("rejects invalid export formats arrays", () => {
    expect(() => validateExportFormats([] as Array<"png">)).toThrow(/non-empty array/);
    expect(() =>
      validateExportFormats(["png", "jpg"] as unknown as Array<"png" | "tiff" | "pdf">)
    ).toThrow(/Invalid export format/);
  });

  it("validates import corpus requests", () => {
    expect(() => validateImportCorpusRequest("nope" as unknown as { inputPath: string })).toThrow(
      /expected object/
    );
    expect(() => validateImportCorpusRequest({ inputPath: "" })).toThrow(/inputPath required/);
    expect(() => validateImportCorpusRequest({ inputPath: "/tmp/corpus", name: "" })).toThrow(
      /name must be a non-empty string/
    );
    expect(() => validateImportCorpusRequest({ inputPath: "/tmp/corpus" })).not.toThrow();
  });

  it("validates run history cleanup options", () => {
    expect(() => validateRunHistoryCleanupOptions(undefined)).not.toThrow();
    expect(() => validateRunHistoryCleanupOptions({ removeArtifacts: true })).not.toThrow();
    expect(() =>
      validateRunHistoryCleanupOptions({ removeArtifacts: "yes" } as unknown as {
        removeArtifacts: boolean;
      })
    ).toThrow(/removeArtifacts/);
  });

  it("rejects invalid review decision payloads", () => {
    expect(() => validateReviewDecisions([])).toThrow(/non-empty array/);
    expect(() => validateReviewDecisions([{ pageId: "", decision: "accept" }])).toThrow(/pageId/);
    expect(() => validateReviewDecisions([{ pageId: "p1", decision: "invalid" }])).toThrow(
      /decision/
    );
    expect(() =>
      validateReviewDecisions([{ pageId: "p1", decision: "accept", notes: 123 }])
    ).toThrow(/notes/);
    expect(() =>
      validateReviewDecisions([{ pageId: "p1", decision: "accept", overrides: "bad" }])
    ).toThrow(/overrides must be an object/);
    expect(() =>
      validateReviewDecisions([
        { pageId: "p1", decision: "accept", overrides: { fn: (): null => null } },
      ])
    ).toThrow(/JSON-safe/);
  });


  it("validates review queue payload shape", () => {
    const queue = {
      runId: "run-1",
      projectId: "proj-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          pageId: "p1",
          filename: "p1.png",
          layoutProfile: "body",
          layoutConfidence: 0.95,
          qualityGate: { accepted: true, reasons: ["ok"] },
          reason: "quality-gate",
          previews: [{ kind: "normalized", path: "normalized/p1.png", width: 100, height: 120 }],
          suggestedAction: "confirm",
          spread: {
            sourcePageId: "p0",
            side: "left",
            gutter: { startRatio: 0.45, endRatio: 0.55 },
          },
        },
      ],
    };

    expect(() => validateReviewQueue(queue)).not.toThrow();
  });

  it("rejects invalid review queue preview kind", () => {
    const queue = {
      runId: "run-1",
      projectId: "proj-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          pageId: "p1",
          filename: "p1.png",
          layoutProfile: "body",
          layoutConfidence: 0.95,
          qualityGate: { accepted: true, reasons: ["ok"] },
          reason: "quality-gate",
          previews: [{ kind: "thumb", path: "normalized/p1.png", width: 100, height: 120 }],
          suggestedAction: "confirm",
        },
      ],
    };

    expect(() => validateReviewQueue(queue)).toThrow(/kind is unsupported/);
  });

  it("sanitizes malformed review queue items", () => {
    const queue = {
      runId: "run-1",
      projectId: "proj-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          pageId: "",
          filename: "bad.png",
          layoutProfile: "body",
          layoutConfidence: 0.9,
          qualityGate: { accepted: true, reasons: ["ok"] },
          reason: "quality-gate",
          previews: [{ kind: "normalized", path: "normalized/bad.png", width: 100, height: 120 }],
          suggestedAction: "confirm",
        },
        {
          pageId: "p2",
          filename: "p2.png",
          layoutProfile: "body",
          layoutConfidence: 0.9,
          qualityGate: { accepted: true, reasons: ["ok"] },
          reason: "quality-gate",
          previews: [{ kind: "normalized", path: "normalized/p2.png", width: 100, height: 120 }],
          suggestedAction: "confirm",
        },
      ],
    };

    const sanitized = sanitizeReviewQueue(queue);
    expect(sanitized.rejectedItems).toBe(1);
    expect(sanitized.rejectionReasons).toHaveLength(1);
    expect(sanitized.rejectionReasons[0]).toMatch(/pageId/);
    expect(sanitized.queue.items).toHaveLength(1);
    expect(sanitized.queue.items[0]?.pageId).toBe("p2");
  });

  it("accepts valid page layout sidecars", () => {
    expect(() => validatePageLayoutSidecar(buildValidSidecar())).not.toThrow();
  });

  it("rejects invalid shading confidence", () => {
    const invalid = buildValidSidecar();
    invalid.normalization.shading = { confidence: 2 };
    expect(() => validatePageLayoutSidecar(invalid)).toThrow(/shading.confidence/);
  });

  it("accepts baseline grid guide flags and round-trips them", () => {
    const sidecar = buildValidSidecar();
    sidecar.normalization.guides = {
      baselineGrid: {
        spacingPx: 14,
        offsetPx: 2,
        angleDeg: -0.3,
        confidence: 0.9,
        snapToPeaks: true,
        markCorrect: false,
        source: "user",
      },
    };

    const roundTripped = JSON.parse(JSON.stringify(sidecar)) as PageLayoutSidecar;

    expect(() => validatePageLayoutSidecar(roundTripped)).not.toThrow();
    expect(roundTripped.normalization.guides?.baselineGrid?.snapToPeaks).toBe(true);
    expect(roundTripped.normalization.guides?.baselineGrid?.markCorrect).toBe(false);
  });

  it("rejects invalid baseline and guide values", () => {
    const invalidBaseline = buildValidSidecar();
    invalidBaseline.metrics.baseline = {
      medianSpacingPx: 12,
      spacingMAD: 1.2,
      lineStraightnessResidual: 0.03,
      confidence: 0.8,
      peaksY: "bad" as unknown as number[],
    };
    expect(() => validatePageLayoutSidecar(invalidBaseline)).toThrow(/peaksY/);

    const invalidGuide = buildValidSidecar();
    invalidGuide.normalization.guides = {
      baselineGrid: { snapToPeaks: "yes" as unknown as boolean },
    };
    expect(() => validatePageLayoutSidecar(invalidGuide)).toThrow(/snapToPeaks/);
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
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /templateId required/
    );
  });

  it("rejects signal when scope is invalid", () => {
    const invalid = buildValidSignal();
    (invalid as { scope: string }).scope = "invalid";
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /scope must be template or section/
    );
  });

  it("rejects signal when appliedAt is missing", () => {
    const invalid = buildValidSignal();
    delete (invalid as Partial<TemplateTrainingSignal>).appliedAt;
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /appliedAt required/
    );
  });

  it("rejects signal when pages array is empty", () => {
    const invalid = buildValidSignal();
    invalid.pages = [];
    expect(() => validateTemplateTrainingSignal(invalid)).toThrow(
      /pages must be a non-empty array/
    );
  });

  it("rejects signal when pages contains non-string", () => {
    const invalid = buildValidSignal();
    (invalid.pages as unknown[]) = ["page-1", 123];
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /pages\[1\] must be a string/
    );
  });

  it("validates nested overrides", () => {
    const invalid = buildValidSignal();
    invalid.overrides = { normalization: { fn: (): null => null } };
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /overrides/
    );
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
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /sourcePageId must be a string/
    );
  });

  it("rejects when layoutProfile is not a string", () => {
    const invalid = buildValidSignal();
    (invalid as { layoutProfile: unknown }).layoutProfile = 123;
    expect(() => validateTemplateTrainingSignal(invalid as TemplateTrainingSignal)).toThrow(
      /layoutProfile must be a string/
    );
  });
});

describe("extended validation guards", () => {
  it("validates project ids and rejects traversal-like ids", () => {
    expect(() => validateProjectId("demo-project_1")).not.toThrow();
    expect(() => validateProjectId("../demo")).toThrow(/project id/i);
  });

  it("validates preferences path constraints", () => {
    expect(() => validateAppPreferencesUpdate({ outputDir: "/tmp/asteria-output" })).not.toThrow();
    expect(() => validateAppPreferencesUpdate({ outputDir: "relative/path" })).toThrow(/absolute/);
    expect(() => validateAppPreferencesUpdate({ outputDir: "/" })).toThrow(/filesystem root/);
  });

  it("validates page layout override allowlists", () => {
    expect(() =>
      validatePageLayoutOverrides({
        normalization: { rotationDeg: 1.2, cropBox: [0, 0, 20, 20] },
        guides: { baselineGrid: { spacingPx: 14, angleDeg: 0.1 } },
      })
    ).not.toThrow();
    expect(() => validatePageLayoutOverrides({ crop: { x: 1 } })).toThrow(/unsupported top-level/);
  });

  it("validates pipeline override allowlists", () => {
    expect(() => validatePipelineConfigOverrides({ project: { dpi: 400 } })).not.toThrow();
    expect(() => validatePipelineConfigOverrides({ unknownField: true })).toThrow(
      /unsupported top-level/
    );
  });
});
