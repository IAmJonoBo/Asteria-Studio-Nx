import path from "node:path";
import type { PageLayoutSidecar, PipelineRunConfig } from "./contracts.js";

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

export const validatePipelineRunConfig = (config: PipelineRunConfig): void => {
  if (!isPlainObject(config)) {
    throw new Error("Invalid pipeline config: expected object");
  }

  if (!isNonEmptyString(config.projectId)) {
    throw new Error("Invalid pipeline config: projectId required");
  }

  if (!Array.isArray(config.pages)) {
    throw new Error("Invalid pipeline config: pages must be an array");
  }

  config.pages.forEach((page, index) => {
    if (!isPlainObject(page)) {
      throw new Error(`Invalid pipeline config: page ${index} must be an object`);
    }

    if (
      !isNonEmptyString(page.id) ||
      !isNonEmptyString(page.filename) ||
      !isNonEmptyString(page.originalPath)
    ) {
      throw new Error(
        `Invalid pipeline config: page ${index} must include id, filename, and originalPath`
      );
    }

    if (!isPlainObject(page.confidenceScores)) {
      throw new Error(`Invalid pipeline config: page ${index} confidenceScores must be an object`);
    }

    for (const value of Object.values(page.confidenceScores)) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new Error(`Invalid pipeline config: page ${index} confidenceScores must be numeric`);
      }
    }
  });

  if (
    typeof config.targetDpi !== "number" ||
    !Number.isFinite(config.targetDpi) ||
    config.targetDpi <= 0
  ) {
    throw new Error("Invalid pipeline config: targetDpi must be a positive number");
  }

  const { targetDimensionsMm } = config;
  if (!isPlainObject(targetDimensionsMm)) {
    throw new Error("Invalid pipeline config: targetDimensionsMm must be an object");
  }

  if (
    typeof targetDimensionsMm.width !== "number" ||
    typeof targetDimensionsMm.height !== "number" ||
    targetDimensionsMm.width <= 0 ||
    targetDimensionsMm.height <= 0
  ) {
    throw new Error(
      "Invalid pipeline config: targetDimensionsMm.width/height must be positive numbers"
    );
  }
};

export const validatePageLayoutSidecar = (layout: PageLayoutSidecar): void => {
  if (!isPlainObject(layout)) {
    throw new Error("Invalid page layout: expected object");
  }

  if (!isNonEmptyString(layout.pageId)) {
    throw new Error("Invalid page layout: pageId required");
  }

  if (layout.pageType !== undefined && typeof layout.pageType !== "string") {
    throw new Error("Invalid page layout: pageType must be a string");
  }

  if (layout.templateId !== undefined && !isNonEmptyString(layout.templateId)) {
    throw new Error("Invalid page layout: templateId must be a string");
  }

  if (layout.templateConfidence !== undefined) {
    assertOptionalRange(layout.templateConfidence, "templateConfidence", 0, 1);
  }

  const { normalization, metrics } = layout;
  if (!isPlainObject(normalization) || !isPlainObject(metrics)) {
    throw new Error("Invalid page layout: normalization and metrics required");
  }

  const shading = normalization.shading;
  if (shading !== undefined && !isPlainObject(shading)) {
    throw new Error("Invalid page layout: shading must be an object");
  }
  if (shading) {
    assertOptionalRange(shading.confidence, "shading.confidence", 0, 1);
  }

  const guides = normalization.guides;
  if (guides !== undefined && !isPlainObject(guides)) {
    throw new Error("Invalid page layout: normalization.guides must be an object");
  }
  if (guides?.baselineGrid) {
    const grid = guides.baselineGrid;
    if (!isPlainObject(grid)) {
      throw new Error("Invalid page layout: normalization.guides.baselineGrid must be an object");
    }
    assertOptionalRange(grid.spacingPx, "normalization.guides.baselineGrid.spacingPx", 0);
    assertOptionalRange(grid.offsetPx, "normalization.guides.baselineGrid.offsetPx", 0);
    assertOptionalRange(grid.confidence, "normalization.guides.baselineGrid.confidence", 0, 1);
  }

  assertOptionalRange(metrics.deskewConfidence, "metrics.deskewConfidence", 0, 1);
  assertOptionalRange(metrics.maskCoverage, "metrics.maskCoverage", 0, 1);
  assertOptionalRange(metrics.shadowScore, "metrics.shadowScore", 0, 1);
  assertOptionalRange(metrics.illuminationResidual, "metrics.illuminationResidual", 0);
  assertOptionalRange(metrics.spineShadowScore, "metrics.spineShadowScore", 0, 1);

  const baseline = metrics.baseline;
  if (baseline !== undefined && !isPlainObject(baseline)) {
    throw new Error("Invalid page layout: baseline must be an object");
  }
  if (baseline) {
    assertOptionalRange(baseline.medianSpacingPx, "metrics.baseline.medianSpacingPx", 0);
    assertOptionalRange(baseline.spacingMAD, "metrics.baseline.spacingMAD", 0);
    assertOptionalRange(
      baseline.lineStraightnessResidual,
      "metrics.baseline.lineStraightnessResidual",
      0
    );
    assertOptionalRange(baseline.confidence, "metrics.baseline.confidence", 0, 1);
    if (baseline.peaksY !== undefined) {
      if (!Array.isArray(baseline.peaksY)) {
        throw new Error("Invalid page layout: metrics.baseline.peaksY must be an array");
      }
      baseline.peaksY.forEach((value, idx) => {
        assertOptionalRange(value, `metrics.baseline.peaksY[${idx}]`, 0, 1);
      });
    }
  }
};
