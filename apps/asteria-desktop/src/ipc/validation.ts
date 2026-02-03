import path from "node:path";
import type { PageLayoutSidecar, PipelineRunConfig, TemplateTrainingSignal } from "./contracts.js";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const assertOptionalRange = (value: unknown, label: string, min: number, max?: number): void => {
  if (value === undefined) return;
  if (!isFiniteNumber(value)) {
    throw new Error(`Invalid ${label}: expected a finite number`);
  }
  if (value < min || (max !== undefined && value > max)) {
    throw new Error(`Invalid ${label}: out of range`);
  }
};

const isJsonSafe = (value: unknown, depth = 0): boolean => {
  if (depth > 5) return false;
  if (value === null) return true;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonSafe(entry, depth + 1));
  }

  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isJsonSafe(entry, depth + 1));
  }

  return false;
};

const throwTypeError = (message: string): never => {
  throw new TypeError(message);
};

const requirePlainObject = (value: unknown, message: string): void => {
  if (!isPlainObject(value)) {
    throwTypeError(message);
  }
};

const requireNonEmptyString = (value: unknown, message: string): void => {
  if (!isNonEmptyString(value)) {
    throwTypeError(message);
  }
};

const validateBaselineSummary = (baseline: unknown): void => {
  if (baseline === undefined) return;
  requirePlainObject(baseline, "Invalid page layout: baseline must be an object");
  const baselineRecord = baseline as Record<string, unknown>;
  assertOptionalRange(baselineRecord.medianSpacingPx, "metrics.baseline.medianSpacingPx", 0);
  assertOptionalRange(baselineRecord.spacingMAD, "metrics.baseline.spacingMAD", 0);
  assertOptionalRange(
    baselineRecord.lineStraightnessResidual,
    "metrics.baseline.lineStraightnessResidual",
    0
  );
  assertOptionalRange(baselineRecord.confidence, "metrics.baseline.confidence", 0, 1);
  const peaksY = baselineRecord.peaksY;
  if (Array.isArray(peaksY)) {
    peaksY.forEach((value: unknown, idx: number) => {
      assertOptionalRange(value, `metrics.baseline.peaksY[${idx}]`, 0, 1);
    });
  } else if (peaksY !== undefined) {
    throwTypeError("Invalid page layout: metrics.baseline.peaksY must be an array");
  }
};

const validateNormalizationGuides = (guides: unknown): void => {
  if (guides === undefined) return;
  requirePlainObject(guides, "Invalid page layout: normalization.guides must be an object");
  const guidesRecord = guides as Record<string, unknown>;
  const baselineGrid = guidesRecord.baselineGrid;
  if (baselineGrid !== undefined) {
    requirePlainObject(
      baselineGrid,
      "Invalid page layout: normalization.guides.baselineGrid must be an object"
    );
    const gridRecord = baselineGrid as Record<string, unknown>;
    assertOptionalRange(gridRecord.spacingPx, "normalization.guides.baselineGrid.spacingPx", 0);
    assertOptionalRange(gridRecord.offsetPx, "normalization.guides.baselineGrid.offsetPx", 0);
    assertOptionalRange(gridRecord.angleDeg, "normalization.guides.baselineGrid.angleDeg", -360, 360);
    assertOptionalRange(
      gridRecord.confidence,
      "normalization.guides.baselineGrid.confidence",
      0,
      1
    );
    if (gridRecord.snapToPeaks !== undefined && typeof gridRecord.snapToPeaks !== "boolean") {
      throwTypeError("Invalid page layout: normalization.guides.baselineGrid.snapToPeaks");
    }
    if (gridRecord.markCorrect !== undefined && typeof gridRecord.markCorrect !== "boolean") {
      throwTypeError("Invalid page layout: normalization.guides.baselineGrid.markCorrect");
    }
  }
};

const validateNormalizationShading = (shading: unknown): void => {
  if (shading === undefined) return;
  requirePlainObject(shading, "Invalid page layout: shading must be an object");
  const shadingRecord = shading as Record<string, unknown>;
  assertOptionalRange(shadingRecord.confidence, "shading.confidence", 0, 1);
};

export const validateRunId = (runId: string): void => {
  if (!isNonEmptyString(runId)) {
    throw new Error("Invalid run id: expected non-empty string");
  }
};

export const validateRunDir = (runDir: string, runId?: string): void => {
  if (!isNonEmptyString(runDir)) {
    throw new Error("Invalid run directory: expected non-empty string");
  }
  const normalized = path.resolve(runDir);
  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 2] !== "runs") {
    throw new Error("Invalid run directory: expected path ending in /runs/<runId>");
  }
  if (runId && path.basename(normalized) !== runId) {
    throw new Error("Invalid run directory: runId mismatch");
  }
};

export const validatePageId = (pageId: string): void => {
  if (!isNonEmptyString(pageId)) {
    throw new Error("Invalid page id: expected non-empty string");
  }
};

export const validateExportFormat = (format: "png" | "tiff" | "pdf"): void => {
  const allowed = new Set(["png", "tiff", "pdf"]);
  if (!allowed.has(format)) {
    throw new Error("Invalid export format");
  }
};

export const validateExportFormats = (formats: Array<"png" | "tiff" | "pdf">): void => {
  if (!Array.isArray(formats) || formats.length === 0) {
    throw new Error("Invalid export formats: expected non-empty array");
  }
  formats.forEach((format) => validateExportFormat(format));
};

export const validateImportCorpusRequest = (request: {
  inputPath: string;
  name?: string;
}): void => {
  if (!isPlainObject(request)) {
    throw new Error("Invalid import request: expected object");
  }
  if (!isNonEmptyString(request.inputPath)) {
    throw new Error("Invalid import request: inputPath required");
  }
  if (request.name !== undefined && !isNonEmptyString(request.name)) {
    throw new Error("Invalid import request: name must be a non-empty string");
  }
};

export const validateOverrides = (overrides: Record<string, unknown>): void => {
  if (!isPlainObject(overrides)) {
    throw new Error("Invalid overrides: expected plain object");
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!isNonEmptyString(key)) {
      throw new Error("Invalid overrides: keys must be non-empty strings");
    }

    if (!isJsonSafe(value)) {
      throw new Error("Invalid overrides: values must be JSON-safe primitives, arrays, or objects");
    }
  }
};

export const validateTemplateTrainingSignal = (signal: TemplateTrainingSignal): void => {
  requirePlainObject(signal, "Invalid template training signal: expected object");

  requireNonEmptyString(signal.templateId, "Invalid template training signal: templateId required");

  if (signal.scope !== "template" && signal.scope !== "section") {
    throw new Error("Invalid template training signal: scope must be template or section");
  }

  // Note: The scope field represents user intent for how overrides should be applied:
  // - "template": User intends to apply to all pages with this layoutProfile
  // - "section": User intends to apply to a contiguous block of pages with this layoutProfile
  // The pages array contains the actual page IDs that received the override.
  // Validation ensures scope is valid, but does not verify semantic consistency
  // (e.g., whether pages array matches the stated scope intent).

  if (!isNonEmptyString(signal.appliedAt)) {
    throw new Error("Invalid template training signal: appliedAt required");
  }

  if (!Array.isArray(signal.pages) || signal.pages.length === 0) {
    throw new Error("Invalid template training signal: pages must be a non-empty array");
  }

  signal.pages.forEach((pageId, index) => {
    if (!isNonEmptyString(pageId)) {
      throw new Error(`Invalid template training signal: pages[${index}] must be a string`);
    }
  });

  if (!isPlainObject(signal.overrides)) {
    throw new Error("Invalid template training signal: overrides must be an object");
  }
  validateOverrides(signal.overrides);

  if (signal.sourcePageId !== undefined) {
    requireNonEmptyString(
      signal.sourcePageId,
      "Invalid template training signal: sourcePageId must be a string"
    );
  }

  if (signal.layoutProfile !== undefined) {
    requireNonEmptyString(
      signal.layoutProfile,
      "Invalid template training signal: layoutProfile must be a string"
    );
  }
};

export const validatePipelineRunConfig = (config: PipelineRunConfig): void => {
  requirePlainObject(config, "Invalid pipeline config: expected object");
  requireNonEmptyString(config.projectId, "Invalid pipeline config: projectId required");
  if (!Array.isArray(config.pages)) {
    throwTypeError("Invalid pipeline config: pages must be an array");
  }

  config.pages.forEach((page, index) => {
    requirePlainObject(page, `Invalid pipeline config: page ${index} must be an object`);

    if (
      !isNonEmptyString(page.id) ||
      !isNonEmptyString(page.filename) ||
      !isNonEmptyString(page.originalPath)
    ) {
      throwTypeError(
        `Invalid pipeline config: page ${index} must include id, filename, and originalPath`
      );
    }

    if (!isPlainObject(page.confidenceScores)) {
      throwTypeError(`Invalid pipeline config: page ${index} confidenceScores must be an object`);
    }

    for (const value of Object.values(page.confidenceScores)) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throwTypeError(`Invalid pipeline config: page ${index} confidenceScores must be numeric`);
      }
    }
  });

  if (
    typeof config.targetDpi !== "number" ||
    !Number.isFinite(config.targetDpi) ||
    config.targetDpi <= 0
  ) {
    throwTypeError("Invalid pipeline config: targetDpi must be a positive number");
  }

  const { targetDimensionsMm } = config;
  requirePlainObject(
    targetDimensionsMm,
    "Invalid pipeline config: targetDimensionsMm must be an object"
  );

  if (
    typeof targetDimensionsMm.width !== "number" ||
    typeof targetDimensionsMm.height !== "number" ||
    targetDimensionsMm.width <= 0 ||
    targetDimensionsMm.height <= 0
  ) {
    throwTypeError(
      "Invalid pipeline config: targetDimensionsMm.width/height must be positive numbers"
    );
  }
};

const ALLOWED_REVIEW_DECISIONS = new Set(["accept", "reject", "adjust"]);

export const validateReviewDecisions = (decisions: unknown): void => {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throwTypeError("Invalid review decisions: expected non-empty array");
  }
  const decisionList = decisions as Array<Record<string, unknown>>;
  decisionList.forEach((decision, index) => {
    requirePlainObject(decision, `Invalid review decision ${index}: expected object`);

    requireNonEmptyString(decision.pageId, `Invalid review decision ${index}: pageId required`);

    if (!ALLOWED_REVIEW_DECISIONS.has(decision.decision as string)) {
      throwTypeError(
        `Invalid review decision ${index}: decision must be "accept", "reject", or "adjust"`
      );
    }

    if (decision.notes !== undefined && typeof decision.notes !== "string") {
      throwTypeError(`Invalid review decision ${index}: notes must be a string`);
    }

    if (decision.overrides !== undefined) {
      if (!isPlainObject(decision.overrides)) {
        throwTypeError(`Invalid review decision ${index}: overrides must be an object`);
      }
      if (!isJsonSafe(decision.overrides)) {
        throwTypeError(`Invalid review decision ${index}: overrides must be JSON-safe`);
      }
    }
  });
};

export const validatePageLayoutSidecar = (layout: PageLayoutSidecar): void => {
  requirePlainObject(layout, "Invalid page layout: expected object");
  requireNonEmptyString(layout.pageId, "Invalid page layout: pageId required");

  if (layout.pageType !== undefined && typeof layout.pageType !== "string") {
    throwTypeError("Invalid page layout: pageType must be a string");
  }

  if (layout.templateId !== undefined) {
    requireNonEmptyString(layout.templateId, "Invalid page layout: templateId must be a string");
  }

  if (layout.templateConfidence !== undefined) {
    assertOptionalRange(layout.templateConfidence, "templateConfidence", 0, 1);
  }

  const { normalization, metrics } = layout;
  requirePlainObject(normalization, "Invalid page layout: normalization and metrics required");
  requirePlainObject(metrics, "Invalid page layout: normalization and metrics required");

  validateNormalizationShading(normalization.shading);
  validateNormalizationGuides(normalization.guides);

  assertOptionalRange(metrics.deskewConfidence, "metrics.deskewConfidence", 0, 1);
  assertOptionalRange(metrics.maskCoverage, "metrics.maskCoverage", 0, 1);
  assertOptionalRange(metrics.shadowScore, "metrics.shadowScore", 0, 1);
  assertOptionalRange(metrics.illuminationResidual, "metrics.illuminationResidual", 0);
  assertOptionalRange(metrics.spineShadowScore, "metrics.spineShadowScore", 0, 1);

  validateBaselineSummary(metrics.baseline);
};
