import type {
  PageLayoutSidecar,
  PipelineRunConfig,
  ReviewItem,
  ReviewPreview,
  ReviewQueue,
  TemplateTrainingSignal,
} from "./contracts.js";

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
  if (depth > 8) return false;
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

const normalizeSeparators = (value: string): string => value.replaceAll(/\\/g, "/");

const isAbsolutePath = (value: string): boolean =>
  /^\/(?!\/)/.test(value) || /^[a-zA-Z]:[\\/]/.test(value);

const isRootPath = (value: string): boolean => {
  const normalized = normalizeSeparators(value).replace(/\/+$/, "");
  return normalized === "" || normalized === "/" || /^[a-zA-Z]:$/.test(normalized);
};

const pathBasename = (value: string): string => {
  const normalized = normalizeSeparators(value).replace(/\/+$/, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "";
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
    assertOptionalRange(
      gridRecord.angleDeg,
      "normalization.guides.baselineGrid.angleDeg",
      -360,
      360
    );
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Invalid run id: unsupported characters");
  }
};

export const validateProjectId = (projectId: string): void => {
  if (!isNonEmptyString(projectId)) {
    throw new Error("Invalid project id: expected non-empty string");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId)) {
    throw new Error("Invalid project id: unsupported characters");
  }
};

export const validateRunDir = (runDir: string, runId?: string): void => {
  if (!isNonEmptyString(runDir)) {
    throw new Error("Invalid run directory: expected non-empty string");
  }
  if (runDir.includes("\u0000")) {
    throw new Error("Invalid run directory: contains null byte");
  }
  const normalized = normalizeSeparators(runDir).replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 2] !== "runs") {
    throw new Error("Invalid run directory: expected path ending in /runs/<runId>");
  }
  if (runId && pathBasename(normalized) !== runId) {
    throw new Error("Invalid run directory: runId mismatch");
  }
};

export const validateRunHistoryCleanupOptions = (options: unknown): void => {
  if (options === undefined) return;
  if (!isPlainObject(options)) {
    throw new Error("Invalid run history cleanup options");
  }
  const removeArtifacts = (options as Record<string, unknown>).removeArtifacts;
  if (removeArtifacts !== undefined && typeof removeArtifacts !== "boolean") {
    throw new Error("Invalid run history cleanup options: removeArtifacts must be boolean");
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

export const validateAppPreferencesUpdate = (prefs: Record<string, unknown>): void => {
  requirePlainObject(prefs, "Invalid preferences update: expected object");
  const allowed = new Set([
    "outputDir",
    "projectsDir",
    "firstRunComplete",
    "sampleCorpusInstalled",
    "lastVersion",
  ]);

  for (const [key, value] of Object.entries(prefs)) {
    if (!allowed.has(key)) {
      throwTypeError(`Invalid preferences update: unknown field ${key}`);
    }
    if (
      (key === "outputDir" || key === "projectsDir" || key === "lastVersion") &&
      value !== undefined
    ) {
      if (!isNonEmptyString(value)) {
        throwTypeError(`Invalid preferences update: ${key} must be a non-empty string`);
      }
      const stringValue = value as string;
      if ((key === "outputDir" || key === "projectsDir") && stringValue.length > 4096) {
        throwTypeError(`Invalid preferences update: ${key} is too long`);
      }
      if (key === "outputDir" || key === "projectsDir") {
        if (!isAbsolutePath(stringValue)) {
          throwTypeError(`Invalid preferences update: ${key} must be an absolute path`);
        }
        if (isRootPath(stringValue)) {
          throwTypeError(`Invalid preferences update: ${key} cannot be filesystem root`);
        }
      }
    }
    if ((key === "firstRunComplete" || key === "sampleCorpusInstalled") && value !== undefined) {
      if (typeof value !== "boolean") {
        throwTypeError(`Invalid preferences update: ${key} must be a boolean`);
      }
    }
  }
};

export const validateRevealPath = (targetPath: string): void => {
  requireNonEmptyString(targetPath, "Invalid reveal path: expected non-empty string");
  if (targetPath === "logs") return;
  if (targetPath.length > 4096) {
    throwTypeError("Invalid reveal path: too long");
  }
  if (targetPath.includes("\u0000")) {
    throwTypeError("Invalid reveal path: contains null byte");
  }
  if (!isAbsolutePath(targetPath)) {
    throwTypeError("Invalid reveal path: expected absolute path");
  }
  if (isRootPath(targetPath)) {
    throwTypeError("Invalid reveal path: refusing filesystem root");
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

const validateBoxTuple = (value: unknown, label: string): void => {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`Invalid ${label}: expected [x1, y1, x2, y2]`);
  }
  const [x1, y1, x2, y2] = value;
  [x1, y1, x2, y2].forEach((entry, index) => {
    if (!isFiniteNumber(entry)) {
      throw new Error(`Invalid ${label}[${index}]: expected finite number`);
    }
  });
  if (x2 <= x1 || y2 <= y1) {
    throw new Error(`Invalid ${label}: expected x2 > x1 and y2 > y1`);
  }
};

export const validatePageLayoutOverrides = (overrides: Record<string, unknown>): void => {
  validateOverrides(overrides);
  const allowedTopLevel = new Set(["normalization", "elements", "guides", "templateCluster"]);
  for (const key of Object.keys(overrides)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(`Invalid overrides: unsupported top-level key ${key}`);
    }
  }

  if (overrides.normalization !== undefined) {
    requirePlainObject(
      overrides.normalization,
      "Invalid overrides: normalization must be a plain object"
    );
    const normalization = overrides.normalization as Record<string, unknown>;
    validateBoxTuple(normalization.cropBox, "overrides.normalization.cropBox");
    validateBoxTuple(normalization.trimBox, "overrides.normalization.trimBox");
    assertOptionalRange(
      normalization.rotationDeg,
      "overrides.normalization.rotationDeg",
      -180,
      180
    );
  }

  if (overrides.elements !== undefined && !Array.isArray(overrides.elements)) {
    throw new Error("Invalid overrides: elements must be an array");
  }

  if (overrides.guides !== undefined) {
    requirePlainObject(overrides.guides, "Invalid overrides: guides must be an object");
    const guides = overrides.guides as Record<string, unknown>;
    const allowedGuideKeys = new Set([
      "baselineGrid",
      "margins",
      "columns",
      "headerBand",
      "footerBand",
      "gutterBand",
    ]);
    for (const key of Object.keys(guides)) {
      if (!allowedGuideKeys.has(key)) {
        throw new Error(`Invalid overrides: unsupported guides key ${key}`);
      }
    }
    if (guides.baselineGrid !== undefined) {
      requirePlainObject(
        guides.baselineGrid,
        "Invalid overrides: guides.baselineGrid must be an object"
      );
      const baselineGrid = guides.baselineGrid as Record<string, unknown>;
      assertOptionalRange(
        baselineGrid.spacingPx,
        "overrides.guides.baselineGrid.spacingPx",
        0.0001
      );
      assertOptionalRange(
        baselineGrid.offsetPx,
        "overrides.guides.baselineGrid.offsetPx",
        -10000,
        10000
      );
      assertOptionalRange(
        baselineGrid.angleDeg,
        "overrides.guides.baselineGrid.angleDeg",
        -180,
        180
      );
    }
  }
};

export const validatePipelineConfigOverrides = (overrides: Record<string, unknown>): void => {
  validateOverrides(overrides);
  const allowedTopLevel = new Set([
    "version",
    "project",
    "models",
    "steps",
    "export",
    "snapping",
    "templates",
    "guides",
    "logging",
  ]);
  for (const key of Object.keys(overrides)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(`Invalid pipeline overrides: unsupported top-level key ${key}`);
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
  validateProjectId(config.projectId);
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
const ALLOWED_REVIEW_PREVIEW_KINDS = new Set<ReviewPreview["kind"]>([
  "source",
  "normalized",
  "overlay",
]);
const ALLOWED_REVIEW_REASONS = new Set<ReviewItem["reason"]>(["quality-gate", "semantic-layout"]);
const ALLOWED_REVIEW_ACTIONS = new Set<ReviewItem["suggestedAction"]>(["confirm", "adjust"]);

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

const validateReviewPreview = (preview: unknown, itemIndex: number, previewIndex: number): void => {
  requirePlainObject(
    preview,
    `Invalid review queue item ${itemIndex}: preview ${previewIndex} must be an object`
  );
  const record = preview as Record<string, unknown>;
  requireNonEmptyString(
    record.kind,
    `Invalid review queue item ${itemIndex}: preview ${previewIndex} kind required`
  );
  if (!ALLOWED_REVIEW_PREVIEW_KINDS.has(record.kind as ReviewPreview["kind"])) {
    throwTypeError(
      `Invalid review queue item ${itemIndex}: preview ${previewIndex} kind is unsupported`
    );
  }
  requireNonEmptyString(
    record.path,
    `Invalid review queue item ${itemIndex}: preview ${previewIndex} path required`
  );
  if (!isFiniteNumber(record.width) || record.width <= 0) {
    throwTypeError(
      `Invalid review queue item ${itemIndex}: preview ${previewIndex} width must be > 0`
    );
  }
  if (!isFiniteNumber(record.height) || record.height <= 0) {
    throwTypeError(
      `Invalid review queue item ${itemIndex}: preview ${previewIndex} height must be > 0`
    );
  }
};

const validateReviewItem = (item: unknown, index: number): void => {
  requirePlainObject(item, `Invalid review queue item ${index}: expected object`);
  const record = item as Record<string, unknown>;
  requireNonEmptyString(record.pageId, `Invalid review queue item ${index}: pageId required`);
  requireNonEmptyString(record.filename, `Invalid review queue item ${index}: filename required`);
  requireNonEmptyString(
    record.layoutProfile,
    `Invalid review queue item ${index}: layoutProfile required`
  );
  if (!isFiniteNumber(record.layoutConfidence)) {
    throwTypeError(`Invalid review queue item ${index}: layoutConfidence must be numeric`);
  }
  requirePlainObject(record.qualityGate, `Invalid review queue item ${index}: qualityGate required`);
  const qualityGate = record.qualityGate as Record<string, unknown>;
  if (typeof qualityGate.accepted !== "boolean") {
    throwTypeError(`Invalid review queue item ${index}: qualityGate.accepted must be boolean`);
  }
  if (!Array.isArray(qualityGate.reasons)) {
    throwTypeError(`Invalid review queue item ${index}: qualityGate.reasons must be an array`);
  }
  (qualityGate.reasons as unknown[]).forEach((reason: unknown, reasonIndex: number) => {
    requireNonEmptyString(
      reason,
      `Invalid review queue item ${index}: qualityGate.reasons[${reasonIndex}] required`
    );
  });

  if (!ALLOWED_REVIEW_REASONS.has(record.reason as ReviewItem["reason"])) {
    throwTypeError(`Invalid review queue item ${index}: reason is unsupported`);
  }
  if (!ALLOWED_REVIEW_ACTIONS.has(record.suggestedAction as ReviewItem["suggestedAction"])) {
    throwTypeError(`Invalid review queue item ${index}: suggestedAction is unsupported`);
  }

  if (!Array.isArray(record.previews)) {
    throwTypeError(`Invalid review queue item ${index}: previews must be an array`);
  }
  (record.previews as unknown[]).forEach((preview, previewIndex) => {
    validateReviewPreview(preview, index, previewIndex);
  });

  if (record.spread !== undefined) {
    requirePlainObject(record.spread, `Invalid review queue item ${index}: spread must be an object`);
    const spread = record.spread as Record<string, unknown>;
    requireNonEmptyString(
      spread.sourcePageId,
      `Invalid review queue item ${index}: spread.sourcePageId required`
    );
    if (spread.side !== "left" && spread.side !== "right") {
      throwTypeError(`Invalid review queue item ${index}: spread.side must be left or right`);
    }
    if (spread.gutter !== undefined) {
      requirePlainObject(
        spread.gutter,
        `Invalid review queue item ${index}: spread.gutter must be an object`
      );
      const gutter = spread.gutter as Record<string, unknown>;
      if (!isFiniteNumber(gutter.startRatio) || !isFiniteNumber(gutter.endRatio)) {
        throwTypeError(
          `Invalid review queue item ${index}: spread.gutter startRatio/endRatio must be numeric`
        );
      }
    }
  }
};

export const validateReviewQueue = (queue: unknown): void => {
  requirePlainObject(queue, "Invalid review queue: expected object");
  const record = queue as Record<string, unknown>;
  requireNonEmptyString(record.runId, "Invalid review queue: runId required");
  requireNonEmptyString(record.projectId, "Invalid review queue: projectId required");
  requireNonEmptyString(record.generatedAt, "Invalid review queue: generatedAt required");
  if (!Array.isArray(record.items)) {
    throwTypeError("Invalid review queue: items must be an array");
  }
  (record.items as unknown[]).forEach((item, index) => {
    validateReviewItem(item, index);
  });
};

export const sanitizeReviewQueue = (
  queue: unknown
): { queue: ReviewQueue; rejectedItems: number } => {
  requirePlainObject(queue, "Invalid review queue: expected object");
  const record = queue as Record<string, unknown>;
  requireNonEmptyString(record.runId, "Invalid review queue: runId required");
  requireNonEmptyString(record.projectId, "Invalid review queue: projectId required");
  requireNonEmptyString(record.generatedAt, "Invalid review queue: generatedAt required");
  if (!Array.isArray(record.items)) {
    throwTypeError("Invalid review queue: items must be an array");
  }

  const validItems: ReviewItem[] = [];
  let rejectedItems = 0;
  (record.items as unknown[]).forEach((item, index) => {
    try {
      validateReviewItem(item, index);
      validItems.push(item as ReviewItem);
    } catch {
      rejectedItems += 1;
    }
  });

  return {
    queue: {
      runId: record.runId as string,
      projectId: record.projectId as string,
      generatedAt: record.generatedAt as string,
      items: validItems,
    },
    rejectedItems,
  };
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
