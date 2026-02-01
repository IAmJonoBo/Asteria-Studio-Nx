import type { PipelineRunConfig } from "./contracts";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
