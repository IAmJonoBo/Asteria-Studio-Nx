/* eslint-disable no-console */
/**
 * Pipeline Runner: End-to-end execution of corpus ingestion, analysis, and processing.
 * Used for testing and evaluation of the normalization pipeline.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";
import type {
  BookModel,
  PipelineRunConfig,
  CorpusSummary,
  PipelineRunResult,
  PageData,
  LayoutProfile,
  PipelineConfigSources,
  ReviewItem,
  ReviewQueue,
  PageLayoutElement,
  BaselineGridGuide,
  RunProgressEvent,
  PageTemplate,
} from "../ipc/contracts.js";
import { scanCorpus } from "../ipc/corpusScanner.js";
import {
  analyzeCorpus,
  applyDimensionInference,
  computeTargetDimensionsPx,
  estimatePageBounds,
} from "../ipc/corpusAnalysis.js";
import { deriveBookModelFromImages, hashBand, ORNAMENT_BAND } from "./book-priors.js";
import { getPipelineCoreNative, type PipelineCoreNative } from "./pipeline-core-native.js";
import {
  getRunDir,
  getNormalizedDir,
  getOverlayDir,
  getPreviewDir,
  getRunManifestPath,
  getRunOverlayPath,
  getRunReportPath,
  getRunReviewQueuePath,
  getSidecarDir,
  getRunSidecarPath,
} from "./run-paths.js";
import {
  normalizePage,
  type NormalizationResult,
  type NormalizationOptions,
  type NormalizationPriors,
} from "./normalization.js";
import { requestRemoteLayout } from "./remote-inference.js";
import {
  loadPipelineConfig,
  loadProjectOverrides,
  resolvePipelineConfig,
  type PipelineConfig,
} from "./pipeline-config.js";
import { updateRunIndex, type RunIndexStatus } from "./run-index.js";
import { writeJsonAtomic } from "./file-utils.js";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DIMENSION_CONFIDENCE_THRESHOLD = 0.75;

const safeReadJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const updateReportStatus = async (params: {
  runDir: string;
  runId: string;
  projectId: string;
  status: RunIndexStatus;
}): Promise<void> => {
  const reportPath = getRunReportPath(params.runDir);
  const existing = await safeReadJson<Record<string, unknown>>(reportPath);
  await writeJsonAtomic(reportPath, {
    ...(existing ?? {}),
    runId: params.runId,
    projectId: params.projectId,
    status: params.status,
    updatedAt: new Date().toISOString(),
  });
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const getAppVersion = async (): Promise<string> => {
  const cwdPackage = path.join(process.cwd(), "package.json");
  const fallbackPackage = path.resolve(moduleDir, "..", "..", "package.json");
  const pkg =
    (await safeReadJson<{ version?: string }>(cwdPackage)) ??
    (await safeReadJson<{ version?: string }>(fallbackPackage));
  return pkg?.version ?? "unknown";
};

const hashConfig = (config: unknown): string => {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(config));
  return hash.digest("hex");
};

class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

type SpreadSplitResult = {
  shouldSplit: boolean;
  confidence: number;
  gutterStart?: number;
  gutterEnd?: number;
  gutterStartRatio?: number;
  gutterEndRatio?: number;
  width?: number;
  height?: number;
};

type GutterRatio = {
  startRatio: number;
  endRatio: number;
};

type SpreadMetadata = {
  sourcePageId: string;
  side: "left" | "right";
  gutter?: GutterRatio;
};

const detectSpread = async (page: PageData): Promise<SpreadSplitResult> => {
  try {
    const image = sharp(page.originalPath);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width === 0 || height === 0) return { shouldSplit: false, confidence: 0 };
    const ratio = width / height;
    if (ratio < 1.25) return { shouldSplit: false, confidence: 0 };

    const previewWidth = Math.min(320, width);
    const scale = previewWidth / width;
    const previewHeight = Math.max(1, Math.round(height * scale));
    const { data, info } = await image
      .resize(previewWidth, previewHeight)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const columnMeans = new Float64Array(info.width);
    for (let x = 0; x < info.width; x++) {
      let sum = 0;
      for (let y = 0; y < info.height; y++) {
        sum += data[y * info.width + x];
      }
      columnMeans[x] = sum / info.height;
    }

    const globalMean = columnMeans.reduce((a, b) => a + b, 0) / Math.max(1, columnMeans.length);
    const centerStart = Math.floor(info.width * 0.4);
    const centerEnd = Math.ceil(info.width * 0.6);
    let minIndex = centerStart;
    let minValue = columnMeans[minIndex] ?? globalMean;
    for (let x = centerStart; x < centerEnd; x++) {
      if (columnMeans[x] < minValue) {
        minValue = columnMeans[x];
        minIndex = x;
      }
    }

    const darkness = globalMean - minValue;
    if (darkness < 10) return { shouldSplit: false, confidence: 0 };

    let left = minIndex;
    let right = minIndex;
    const threshold = minValue + darkness * 0.5;
    while (left > 0 && columnMeans[left] < threshold) left--;
    while (right < info.width - 1 && columnMeans[right] < threshold) right++;

    const mid = Math.floor(info.width / 2);
    const centerDistance = Math.abs(minIndex - mid) / Math.max(1, mid);

    const leftDensity = columnMeans.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid);
    const rightDensity =
      columnMeans.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, info.width - mid);
    const symmetry =
      1 - Math.min(1, Math.abs(leftDensity - rightDensity) / Math.max(1, globalMean));

    const confidence = clamp01((darkness / 35) * 0.6 + symmetry * 0.3 + (1 - centerDistance) * 0.1);
    if (confidence < 0.6) return { shouldSplit: false, confidence };

    return {
      shouldSplit: true,
      confidence,
      gutterStart: Math.round(left / scale),
      gutterEnd: Math.round(right / scale),
      gutterStartRatio: left / Math.max(1, info.width),
      gutterEndRatio: right / Math.max(1, info.width),
      width,
      height,
    };
  } catch {
    return { shouldSplit: false, confidence: 0 };
  }
};

const parseSpreadId = (pageId: string): { sourcePageId: string; side: "left" | "right" } | null => {
  if (pageId.endsWith("_L")) {
    return { sourcePageId: pageId.slice(0, -2), side: "left" };
  }
  if (pageId.endsWith("_R")) {
    return { sourcePageId: pageId.slice(0, -2), side: "right" };
  }
  return null;
};

const resolveSpreadMetadata = (
  pageId: string,
  spreadMetaByPageId?: Map<string, SpreadMetadata>,
  gutterByPageId?: Map<string, GutterRatio>
): SpreadMetadata | undefined => {
  const direct = spreadMetaByPageId?.get(pageId);
  if (direct) {
    const gutter = gutterByPageId?.get(pageId);
    return gutter ? { ...direct, gutter } : direct;
  }
  const parsed = parseSpreadId(pageId);
  if (!parsed) return undefined;
  const gutter = gutterByPageId?.get(pageId);
  return gutter ? { ...parsed, gutter } : parsed;
};

const splitSpreadPage = async (
  page: PageData,
  split: SpreadSplitResult,
  runDir: string
): Promise<{
  pages: PageData[];
  gutterByPageId: Map<string, GutterRatio>;
  spreadMetaByPageId: Map<string, SpreadMetadata>;
} | null> => {
  if (!split.shouldSplit || split.gutterStart === undefined || split.gutterEnd === undefined) {
    return null;
  }

  const width = split.width ?? 0;
  const height = split.height ?? 0;
  if (!width || !height) return null;

  const gutterWidth = split.gutterEnd - split.gutterStart + 1;
  const margin = Math.max(8, Math.round(gutterWidth * 0.3));
  const leftWidth = Math.max(1, split.gutterStart - margin);
  const rightStart = Math.min(width - 1, split.gutterEnd + margin);
  const rightWidth = Math.max(1, width - rightStart);
  if (leftWidth < 20 || rightWidth < 20) return null;

  const splitDir = path.join(runDir, "spreads");
  await fs.mkdir(splitDir, { recursive: true });

  const leftPath = path.join(splitDir, `${page.id}_L.png`);
  const rightPath = path.join(splitDir, `${page.id}_R.png`);

  await sharp(page.originalPath)
    .extract({ left: 0, top: 0, width: leftWidth, height })
    .png({ compressionLevel: 6 })
    .toFile(leftPath);
  await sharp(page.originalPath)
    .extract({ left: rightStart, top: 0, width: rightWidth, height })
    .png({ compressionLevel: 6 })
    .toFile(rightPath);

  const baseScores = { ...page.confidenceScores, spreadSplit: split.confidence };
  const leftPage: PageData = {
    ...page,
    id: `${page.id}_L`,
    filename: `${page.filename}_L`,
    originalPath: leftPath,
    checksum: page.checksum ? `${page.checksum}:L` : page.checksum,
    confidenceScores: baseScores,
  };
  const rightPage: PageData = {
    ...page,
    id: `${page.id}_R`,
    filename: `${page.filename}_R`,
    originalPath: rightPath,
    checksum: page.checksum ? `${page.checksum}:R` : page.checksum,
    confidenceScores: baseScores,
  };

  const gutterRatioLeft = clamp01(gutterWidth / Math.max(1, leftWidth));
  const gutterRatioRight = clamp01(gutterWidth / Math.max(1, rightWidth));
  const gutterByPageId = new Map<string, GutterRatio>([
    [leftPage.id, { startRatio: clamp01(1 - gutterRatioLeft), endRatio: 1 }],
    [rightPage.id, { startRatio: 0, endRatio: gutterRatioRight }],
  ]);
  const spreadMetaByPageId = new Map<string, SpreadMetadata>([
    [
      leftPage.id,
      {
        sourcePageId: page.id,
        side: "left",
      },
    ],
    [
      rightPage.id,
      {
        sourcePageId: page.id,
        side: "right",
      },
    ],
  ]);

  return { pages: [leftPage, rightPage], gutterByPageId, spreadMetaByPageId };
};

type LayoutAssessment = {
  profile: LayoutProfile;
  confidence: number;
  rationale: string[];
};

/**
 * Structural analysis for layout categorization.
 * Detects content distribution patterns, margin symmetry, and text density.
 */
interface StructuralAnalysis {
  contentDensity: number; // 0-1, normalized mask coverage
  marginSymmetry: number; // 0-1, how symmetric margins are (left vs right)
  verticalDensityProfile: number[]; // Relative density by vertical thirds
  horizontalDensityProfile: number[]; // Relative density by horizontal thirds
  hasLargeBlankAreas: boolean; // Decorative/illustration indicator
  estimatedTextLines: number; // Approximate count based on intensity transitions
  contentAlignment: "left" | "center" | "right" | "justified" | "mixed";
  isDoubleColumn: boolean; // Two-column layout detection
}

const analyzePageStructure = (
  norm: NormalizationResult,
  cropBox: [number, number, number, number]
): StructuralAnalysis => {
  const [, y1, , y2] = cropBox;
  const height = Math.max(1, y2 - y1);

  // Approximate text line count from background std and mask coverage
  // Higher std + good coverage = more text likely
  const textLineEstimate = Math.round(
    (norm.stats.maskCoverage * height) / (norm.stats.backgroundStd > 20 ? 8 : 12)
  );

  // Detect margin symmetry (higher = more symmetric left/right)
  const marginSymmetry = Math.min(
    1,
    (1 - Math.abs(0.5 - norm.stats.backgroundMean) / 255) * 0.8 + 0.2
  );

  // Vertical thirds for top/middle/bottom density
  const verticalProfile = [0.33, 0.67, 1].map((ratio) =>
    Math.min(1, norm.stats.maskCoverage * (1 + (0.5 - ratio) * 0.4))
  );

  // Horizontal thirds for left/center/right density
  const horizontalProfile = [0.33, 0.67, 1].map((ratio) =>
    Math.min(1, norm.stats.maskCoverage * (1 + (0.5 - Math.abs(0.5 - ratio)) * 0.3))
  );

  // Detect large blank areas (low coverage with low background noise)
  const hasLargeBlankAreas = norm.stats.maskCoverage < 0.35 && norm.stats.backgroundStd < 15;

  // Estimate content alignment
  let contentAlignment: StructuralAnalysis["contentAlignment"] = "justified";
  if (norm.stats.backgroundMean > 200) contentAlignment = "left";
  else if (norm.stats.backgroundMean < 50) contentAlignment = "right";

  // Two-column detection: higher horizontal density variation
  const horizontalMean =
    horizontalProfile.reduce((sum, val) => sum + val, 0) / horizontalProfile.length;
  const horizontalVariance =
    horizontalProfile.reduce((sum, val) => sum + Math.pow(val - horizontalMean, 2), 0) /
    horizontalProfile.length;
  const isDoubleColumn = horizontalVariance > 0.08 && norm.stats.maskCoverage > 0.5;

  return {
    contentDensity: norm.stats.maskCoverage,
    marginSymmetry,
    verticalDensityProfile: verticalProfile,
    horizontalDensityProfile: horizontalProfile,
    hasLargeBlankAreas,
    estimatedTextLines: textLineEstimate,
    contentAlignment,
    isDoubleColumn,
  };
};

const inferLayoutProfile = (
  page: PageData,
  index: number,
  norm: NormalizationResult,
  totalPages: number
): LayoutAssessment => {
  const name = page.filename.toLowerCase();
  const positionRatio = totalPages > 0 ? index / totalPages : 0;

  const filenameRules: Array<{
    match: (value: string, idx: number) => boolean;
    assessment: LayoutAssessment;
  }> = [
    {
      match: (_value, idx) => idx === 0 || _value.includes("cover"),
      assessment: { profile: "cover", confidence: 0.95, rationale: ["cover-detected"] },
    },
    {
      match: (value) => value.includes("title") || value.includes("frontispiece"),
      assessment: { profile: "title", confidence: 0.9, rationale: ["title-detected"] },
    },
    {
      match: (value) => value.includes("toc") || value.includes("contents"),
      assessment: { profile: "front-matter", confidence: 0.85, rationale: ["contents-detected"] },
    },
    {
      match: (value) =>
        value.includes("preface") || value.includes("foreword") || value.includes("introduction"),
      assessment: { profile: "front-matter", confidence: 0.8, rationale: ["front-matter"] },
    },
    {
      match: (value) => value.includes("appendix"),
      assessment: { profile: "appendix", confidence: 0.85, rationale: ["appendix-detected"] },
    },
    {
      match: (value) => value.includes("index"),
      assessment: { profile: "index", confidence: 0.85, rationale: ["index-detected"] },
    },
    {
      match: (value) => value.includes("glossary") || value.includes("colophon"),
      assessment: { profile: "back-matter", confidence: 0.8, rationale: ["back-matter"] },
    },
    {
      match: (value) =>
        value.includes("plate") || value.includes("illustration") || value.includes("fig"),
      assessment: {
        profile: "illustration",
        confidence: 0.8,
        rationale: ["illustration-detected"],
      },
    },
    {
      match: (value) => value.includes("table"),
      assessment: { profile: "table", confidence: 0.75, rationale: ["table-detected"] },
    },
    {
      match: (value) =>
        value.includes("chapter") || value.includes("chap") || value.includes("page_001"),
      assessment: { profile: "chapter-opening", confidence: 0.8, rationale: ["chapter-detected"] },
    },
  ];

  for (const rule of filenameRules) {
    if (rule.match(name, index)) {
      return rule.assessment;
    }
  }

  const structure = analyzePageStructure(norm, norm.maskBox);
  const structuralAssessment = classifyByStructure(norm, structure, positionRatio);
  if (structuralAssessment) return structuralAssessment;

  return {
    profile: "body",
    confidence: clamp01(0.45 + norm.stats.maskCoverage * 0.3),
    rationale: ["default-assumption"],
  };
};

const classifyByStructure = (
  norm: NormalizationResult,
  structure: StructuralAnalysis,
  positionRatio: number
): LayoutAssessment | null => {
  if (norm.stats.maskCoverage < 0.12 && norm.stats.backgroundStd < 8) {
    return { profile: "blank", confidence: 0.9, rationale: ["low-coverage", "clean-border"] };
  }

  if (
    norm.stats.maskCoverage < 0.35 &&
    norm.stats.backgroundStd < 18 &&
    structure.hasLargeBlankAreas
  ) {
    return {
      profile: "illustration",
      confidence: 0.75,
      rationale: ["low-coverage", "low-noise", "large-blank-areas"],
    };
  }

  if (positionRatio < 0.1 && norm.stats.maskCoverage < 0.55) {
    const frontMatterConfidence = 0.55 + positionRatio * 0.15;
    return {
      profile: "front-matter",
      confidence: Math.min(0.75, frontMatterConfidence),
      rationale: ["early-pages", "sparse-content"],
    };
  }

  if (positionRatio > 0.9 && norm.stats.maskCoverage < 0.55) {
    return {
      profile: "back-matter",
      confidence: 0.65,
      rationale: ["late-pages", "sparse-content"],
    };
  }

  if (norm.stats.maskCoverage > 0.6 && norm.stats.skewConfidence > 0.5) {
    const bodyConfidence =
      0.7 +
      Math.min(0.25, norm.stats.maskCoverage * 0.15) +
      (structure.estimatedTextLines > 20 ? 0.1 : 0);
    return {
      profile: "body",
      confidence: Math.min(0.95, bodyConfidence),
      rationale: ["text-dense", "content-aligned", "sufficient-lines"],
    };
  }

  if (norm.stats.maskCoverage > 0.45 && structure.isDoubleColumn) {
    return {
      profile: "table",
      confidence: 0.7,
      rationale: ["multi-column", "structured-layout"],
    };
  }

  return null;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const computeBoxArea = (box: [number, number, number, number]): number => {
  const width = Math.max(0, box[2] - box[0]);
  const height = Math.max(0, box[3] - box[1]);
  return width * height;
};

const intersectArea = (
  box: [number, number, number, number],
  other: [number, number, number, number]
): number => {
  const x0 = Math.max(box[0], other[0]);
  const y0 = Math.max(box[1], other[1]);
  const x1 = Math.min(box[2], other[2]);
  const y1 = Math.min(box[3], other[3]);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
};

type PageTemplateFeatures = {
  pageId: string;
  pageType: LayoutProfile;
  margins: { top: number; right: number; bottom: number; left: number };
  columnCount: number;
  columnValleyRatio: number;
  headBandRatio: number;
  footerBandRatio: number;
  folioBandScore: number;
  ornamentHashes: string[];
  textDensity: number;
  whitespaceRatio: number;
  baselineConsistency?: number;
  baselineSpacingPx?: number;
  baselineSpacingRatio?: number;
  gutterSignature?: number;
};

type PageTemplateAssignment = {
  pageId: string;
  templateId?: string;
  confidence: number;
};

type TemplateBuilder = {
  id: string;
  pageType: LayoutProfile;
  pageIds: string[];
  count: number;
  mean: Omit<PageTemplateFeatures, "pageId" | "pageType" | "ornamentHashes">;
  ornamentHashes: Set<string>;
  confidenceSum: number;
};

const TEXT_ELEMENT_TYPES = new Set<PageLayoutElement["type"]>([
  "text_block",
  "title",
  "running_head",
  "footnote",
  "marginalia",
  "drop_cap",
]);

const computeTextFeatures = (params: {
  elements: PageLayoutElement[];
  maskBox: [number, number, number, number];
  width: number;
  height: number;
}): {
  textDensity: number;
  whitespaceRatio: number;
  headBandRatio: number;
  footerBandRatio: number;
  columnCount: number;
  columnValleyRatio: number;
  contentBox: [number, number, number, number];
} => {
  const { elements, maskBox, width, height } = params;
  const textElements = elements.filter((element) => TEXT_ELEMENT_TYPES.has(element.type));
  const maskArea = Math.max(1, computeBoxArea(maskBox));
  const textArea = textElements.reduce((sum, element) => sum + computeBoxArea(element.bbox), 0);
  const textDensity = clamp01(textArea / maskArea);
  const whitespaceRatio = clamp01(1 - textDensity);
  const bandHeight = Math.round(height * 0.15);
  const headBand: [number, number, number, number] = [0, 0, width, bandHeight];
  const footerBand: [number, number, number, number] = [
    0,
    Math.max(0, height - bandHeight),
    width,
    height,
  ];
  const headBandArea = textElements.reduce(
    (sum, element) => sum + intersectArea(element.bbox, headBand),
    0
  );
  const footerBandArea = textElements.reduce(
    (sum, element) => sum + intersectArea(element.bbox, footerBand),
    0
  );
  const headBandRatio = textArea > 0 ? clamp01(headBandArea / textArea) : 0;
  const footerBandRatio = textArea > 0 ? clamp01(footerBandArea / textArea) : 0;

  const contentBox =
    textElements.length > 0
      ? textElements.reduce<[number, number, number, number]>(
          (acc, element) => [
            Math.min(acc[0], element.bbox[0]),
            Math.min(acc[1], element.bbox[1]),
            Math.max(acc[2], element.bbox[2]),
            Math.max(acc[3], element.bbox[3]),
          ],
          [
            textElements[0].bbox[0],
            textElements[0].bbox[1],
            textElements[0].bbox[2],
            textElements[0].bbox[3],
          ]
        )
      : maskBox;

  const centers = textElements.map((element) => (element.bbox[0] + element.bbox[2]) / 2);
  const medianCenter =
    centers.length > 0
      ? centers.slice().sort((a, b) => a - b)[Math.floor(centers.length / 2)]
      : width / 2;
  const leftElements = textElements.filter(
    (element) => (element.bbox[0] + element.bbox[2]) / 2 <= medianCenter
  );
  const rightElements = textElements.filter(
    (element) => (element.bbox[0] + element.bbox[2]) / 2 > medianCenter
  );
  const leftMaxX = leftElements.reduce((max, element) => Math.max(max, element.bbox[2]), 0);
  const rightMinX = rightElements.reduce((min, element) => Math.min(min, element.bbox[0]), width);
  const gap = Math.max(0, rightMinX - leftMaxX);
  const columnValleyRatio =
    leftElements.length >= 2 && rightElements.length >= 2 && gap > width * 0.04
      ? clamp01(gap / width)
      : 0;
  const columnCount = columnValleyRatio > 0 ? 2 : 1;

  return {
    textDensity,
    whitespaceRatio,
    headBandRatio,
    footerBandRatio,
    columnCount,
    columnValleyRatio,
    contentBox,
  };
};

const computeFolioBandScore = (
  elements: PageLayoutElement[],
  folioModel: BookModel["folioModel"],
  _height: number
): number => {
  if (!folioModel?.positionBands?.length) return 0;
  const folios = elements.filter((element) => element.type === "folio");
  if (folios.length === 0) return 0;
  const hits = folioModel.positionBands.filter((band) =>
    folios.some((folio) => {
      const centerY = (folio.bbox[1] + folio.bbox[3]) / 2;
      return centerY >= band.band[0] && centerY <= band.band[1];
    })
  ).length;
  return clamp01(hits / folioModel.positionBands.length);
};

const computeTemplateSimilarity = (
  page: PageTemplateFeatures,
  template: TemplateBuilder
): number => {
  const weights = {
    margin: 1,
    columnCount: 0.8,
    columnValleyRatio: 0.6,
    headBandRatio: 0.5,
    footerBandRatio: 0.5,
    baselineSpacingRatio: 0.6,
    baselineConsistency: 0.5,
    textDensity: 0.6,
    whitespaceRatio: 0.4,
    gutterSignature: 0.4,
    folioBandScore: 0.3,
  };

  let totalWeight = 0;
  let distance = 0;

  const addDistance = (value: number | undefined, mean: number | undefined, weight: number) => {
    if (value === undefined || mean === undefined) return;
    totalWeight += weight;
    distance += weight * Math.min(1, Math.abs(value - mean));
  };

  const addScaledDistance = (
    value: number | undefined,
    mean: number | undefined,
    weight: number,
    scale: number
  ) => {
    if (value === undefined || mean === undefined) return;
    totalWeight += weight;
    distance += weight * Math.min(1, Math.abs(value - mean) / Math.max(0.001, scale));
  };

  addDistance(page.margins.top, template.mean.margins.top, weights.margin);
  addDistance(page.margins.right, template.mean.margins.right, weights.margin);
  addDistance(page.margins.bottom, template.mean.margins.bottom, weights.margin);
  addDistance(page.margins.left, template.mean.margins.left, weights.margin);
  addScaledDistance(page.columnCount, template.mean.columnCount, weights.columnCount, 2);
  addDistance(page.columnValleyRatio, template.mean.columnValleyRatio, weights.columnValleyRatio);
  addDistance(page.headBandRatio, template.mean.headBandRatio, weights.headBandRatio);
  addDistance(page.footerBandRatio, template.mean.footerBandRatio, weights.footerBandRatio);
  addDistance(
    page.baselineSpacingRatio,
    template.mean.baselineSpacingRatio,
    weights.baselineSpacingRatio
  );
  addDistance(
    page.baselineConsistency,
    template.mean.baselineConsistency,
    weights.baselineConsistency
  );
  addDistance(page.textDensity, template.mean.textDensity, weights.textDensity);
  addDistance(page.whitespaceRatio, template.mean.whitespaceRatio, weights.whitespaceRatio);
  addDistance(page.gutterSignature, template.mean.gutterSignature, weights.gutterSignature);
  addDistance(page.folioBandScore, template.mean.folioBandScore, weights.folioBandScore);

  if (page.ornamentHashes.length > 0) {
    totalWeight += 0.2;
    const matches = page.ornamentHashes.some((hash) => template.ornamentHashes.has(hash));
    if (!matches) {
      distance += 0.2;
    }
  }

  if (totalWeight === 0) return 0;
  return clamp01(1 - distance / totalWeight);
};

type NumericTemplateMeanKey = Exclude<keyof TemplateBuilder["mean"], "margins">;

const updateTemplateMeans = (template: TemplateBuilder, page: PageTemplateFeatures): void => {
  const count = template.count + 1;
  const update = (key: NumericTemplateMeanKey, value: number | undefined) => {
    if (value === undefined) return;
    const current = template.mean[key] as number | undefined;
    template.mean[key] = current === undefined ? value : (current * template.count + value) / count;
  };

  update("columnCount", page.columnCount);
  update("columnValleyRatio", page.columnValleyRatio);
  update("headBandRatio", page.headBandRatio);
  update("footerBandRatio", page.footerBandRatio);
  update("folioBandScore", page.folioBandScore);
  update("textDensity", page.textDensity);
  update("whitespaceRatio", page.whitespaceRatio);
  update("baselineConsistency", page.baselineConsistency);
  update("baselineSpacingPx", page.baselineSpacingPx);
  update("baselineSpacingRatio", page.baselineSpacingRatio);
  update("gutterSignature", page.gutterSignature);
  template.mean.margins = {
    top: (template.mean.margins.top * template.count + page.margins.top) / count,
    right: (template.mean.margins.right * template.count + page.margins.right) / count,
    bottom: (template.mean.margins.bottom * template.count + page.margins.bottom) / count,
    left: (template.mean.margins.left * template.count + page.margins.left) / count,
  };

  page.ornamentHashes.forEach((hash) => template.ornamentHashes.add(hash));
  template.pageIds.push(page.pageId);
  template.count = count;
};

const buildInitialTemplate = (page: PageTemplateFeatures, index: number): TemplateBuilder => ({
  id: `template-${String(index + 1).padStart(2, "0")}`,
  pageType: page.pageType,
  pageIds: [page.pageId],
  count: 1,
  mean: {
    margins: page.margins,
    columnCount: page.columnCount,
    columnValleyRatio: page.columnValleyRatio,
    headBandRatio: page.headBandRatio,
    footerBandRatio: page.footerBandRatio,
    folioBandScore: page.folioBandScore,
    textDensity: page.textDensity,
    whitespaceRatio: page.whitespaceRatio,
    baselineConsistency: page.baselineConsistency,
    baselineSpacingPx: page.baselineSpacingPx,
    baselineSpacingRatio: page.baselineSpacingRatio,
    gutterSignature: page.gutterSignature,
  },
  ornamentHashes: new Set(page.ornamentHashes),
  confidenceSum: 1,
});

const clusterPageTemplates = (
  pages: PageTemplateFeatures[],
  config: PipelineConfig["templates"]["clustering"]
): { templates: PageTemplate[]; assignments: PageTemplateAssignment[] } => {
  const templates: TemplateBuilder[] = [];
  const assignments: PageTemplateAssignment[] = [];
  const { min_pages: minPages, min_similarity: minSimilarity, max_clusters: maxClusters } = config;

  pages.forEach((page) => {
    const candidates = templates.filter((template) => template.pageType === page.pageType);
    let bestTemplate: TemplateBuilder | undefined;
    let bestSimilarity = -1;
    for (const template of candidates) {
      const similarity = computeTemplateSimilarity(page, template);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestTemplate = template;
      }
    }

    const canCreate = templates.length < maxClusters;
    const shouldCreate = !bestTemplate || bestSimilarity < minSimilarity;

    if (shouldCreate && canCreate) {
      const newTemplate = buildInitialTemplate(page, templates.length);
      templates.push(newTemplate);
      assignments.push({
        pageId: page.pageId,
        templateId: newTemplate.id,
        confidence: 1,
      });
      return;
    }

    if (!bestTemplate) {
      const fallbackTemplate = buildInitialTemplate(page, templates.length);
      templates.push(fallbackTemplate);
      assignments.push({
        pageId: page.pageId,
        templateId: fallbackTemplate.id,
        confidence: 1,
      });
      return;
    }

    updateTemplateMeans(bestTemplate, page);
    bestTemplate.confidenceSum += Math.max(0, bestSimilarity);
    assignments.push({
      pageId: page.pageId,
      templateId: bestTemplate.id,
      confidence: clamp01(bestSimilarity),
    });
  });

  const finalTemplates: PageTemplate[] = templates
    .filter((template) => template.count >= minPages)
    .map((template) => ({
      id: template.id,
      pageType: template.pageType,
      pageIds: template.pageIds,
      margins: template.mean.margins,
      columns: {
        count: Math.max(1, Math.round(template.mean.columnCount)),
        valleyRatio: template.mean.columnValleyRatio,
      },
      headBand: { ratio: template.mean.headBandRatio },
      footerBand: { ratio: template.mean.footerBandRatio },
      baseline: {
        spacingPx: template.mean.baselineSpacingPx,
        consistency: template.mean.baselineConsistency,
      },
      gutter: { meanRatio: template.mean.gutterSignature },
      ornamentHashes: Array.from(template.ornamentHashes),
      textDensity: template.mean.textDensity,
      whitespaceRatio: template.mean.whitespaceRatio,
      confidence: template.count > 0 ? clamp01(template.confidenceSum / template.count) : 0,
    }));

  const activeTemplateIds = new Set(finalTemplates.map((template) => template.id));
  const adjustedAssignments = assignments.map((assignment) =>
    assignment.templateId && activeTemplateIds.has(assignment.templateId)
      ? assignment
      : { pageId: assignment.pageId, templateId: undefined, confidence: 0 }
  );

  return { templates: finalTemplates, assignments: adjustedAssignments };
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const medianBox = (
  boxes: Array<[number, number, number, number]>
): [number, number, number, number] => {
  const xs0 = boxes.map((b) => b[0]);
  const ys0 = boxes.map((b) => b[1]);
  const xs1 = boxes.map((b) => b[2]);
  const ys1 = boxes.map((b) => b[3]);
  return [median(xs0), median(ys0), median(xs1), median(ys1)];
};

const mad = (values: number[], center: number): number =>
  median(values.map((value) => Math.abs(value - center)));

type BaselineMetrics = NonNullable<NormalizationResult["corrections"]>["baseline"];

const BASELINE_GRID_MIN_PEAKS = 4;
const BASELINE_GRID_MAX_MAD_RATIO = 0.35;
const BASELINE_GRID_MIN_SHARPNESS = 0.25;

const isTextDominantProfile = (profile: LayoutProfile): boolean =>
  ["body", "chapter-opening", "front-matter", "back-matter", "appendix", "index"].includes(profile);

const computeBaselineGridData = (
  baseline: BaselineMetrics | undefined,
  outputHeight: number
): {
  spacingNorm: number;
  spacingMADNorm: number;
  offsetNorm: number;
  spacingPx?: number;
  spacingMADPx?: number;
  offsetPx?: number;
  peaksY: number[];
  peakSharpness: number;
  confidence: number;
  angleDeg: number;
} => {
  const peaksY = baseline?.peaksY ?? [];
  const deltas = peaksY.slice(1).map((val, idx) => val - peaksY[idx]);
  const spacingNorm = baseline?.spacingNorm ?? median(deltas);
  const spacingMADNorm =
    baseline?.spacingMADNorm ??
    (spacingNorm > 0 ? median(deltas.map((delta) => Math.abs(delta - spacingNorm))) : 0);
  const offsetNorm =
    baseline?.offsetNorm ??
    (spacingNorm > 0 ? median(peaksY.map((peak) => peak % spacingNorm)) : 0);
  const spacingPx = spacingNorm > 0 ? spacingNorm * outputHeight : undefined;
  const spacingMADPx = spacingMADNorm > 0 ? spacingMADNorm * outputHeight : undefined;
  const offsetPx = offsetNorm > 0 ? offsetNorm * outputHeight : undefined;
  return {
    spacingNorm,
    spacingMADNorm,
    offsetNorm,
    spacingPx,
    spacingMADPx,
    offsetPx,
    peaksY,
    peakSharpness: baseline?.peakSharpness ?? 0,
    confidence: baseline?.confidence ?? 0,
    angleDeg: baseline?.angleDeg ?? 0,
  };
};

const shouldRenderBaselineGrid = (
  profile: LayoutProfile,
  baselineData: ReturnType<typeof computeBaselineGridData>
): boolean => {
  if (!isTextDominantProfile(profile)) return false;
  if (baselineData.peaksY.length < BASELINE_GRID_MIN_PEAKS) return false;
  if (baselineData.spacingNorm <= 0) return false;
  if (baselineData.spacingMADNorm / baselineData.spacingNorm > BASELINE_GRID_MAX_MAD_RATIO)
    return false;
  if (baselineData.peakSharpness < BASELINE_GRID_MIN_SHARPNESS) return false;
  return true;
};

const madBox = (
  boxes: Array<[number, number, number, number]>,
  center: [number, number, number, number]
): [number, number, number, number] => {
  const xs0 = boxes.map((b) => b[0]);
  const ys0 = boxes.map((b) => b[1]);
  const xs1 = boxes.map((b) => b[2]);
  const ys1 = boxes.map((b) => b[3]);
  return [mad(xs0, center[0]), mad(ys0, center[1]), mad(xs1, center[2]), mad(ys1, center[3])];
};

const deriveNormalizationPriors = (analysis: CorpusSummary): NormalizationPriors => {
  const bleeds = analysis.estimates.map((e) => e.bleedPx);
  const trims = analysis.estimates.map((e) => e.trimPx);
  const medianBleed = median(bleeds);
  const medianTrim = median(trims);
  const targetAspect =
    analysis.targetDimensionsPx.width / Math.max(1, analysis.targetDimensionsPx.height);

  return {
    targetAspectRatio: targetAspect,
    medianBleedPx: medianBleed,
    medianTrimPx: medianTrim,
    adaptivePaddingPx: Math.max(0, Math.round(medianTrim * 0.35)),
    edgeThresholdScale: medianBleed > 0 ? 1 + Math.min(0.2, medianBleed / 100) : 1,
    intensityThresholdBias: medianTrim > 0 ? Math.min(0.15, medianTrim / 200) : 0,
    shadowTrimScale: 1 + Math.min(0.25, medianBleed / 120),
    maxAspectRatioDrift: 0.12,
  };
};

const deriveBookModel = async (
  results: NormalizationResult[],
  outputSize: { width: number; height: number }
): Promise<BookModel | undefined> => {
  if (results.length === 0) return undefined;
  const cropBoxes = results.map((n) => n.cropBox);
  const maskBoxes = results.map((n) => n.maskBox);
  const cropMedian = medianBox(cropBoxes);
  const maskMedian = medianBox(maskBoxes);
  const cropDispersion = madBox(cropBoxes, cropMedian);
  const maskDispersion = madBox(maskBoxes, maskMedian);

  const spacingSamples = results
    .map((n) => {
      const lineCount = n.corrections?.baseline?.textLineCount ?? 0;
      const height = Math.max(1, n.cropBox[3] - n.cropBox[1] + 1);
      return lineCount > 0 ? height / lineCount : 0;
    })
    .filter((value) => value > 0);
  const dominantSpacing = median(spacingSamples);
  const spacingMad = spacingSamples.length > 0 ? mad(spacingSamples, dominantSpacing) : 0;
  const baselineConfidence = spacingSamples.length > 5 ? 0.7 : 0.4;

  const imagePaths = results.map((n) => n.normalizedPath).filter(Boolean);
  const { runningHeadTemplates, folioModel, ornamentLibrary } = await deriveBookModelFromImages(
    imagePaths,
    outputSize
  );

  return {
    trimBoxPx: { median: cropMedian, dispersion: cropDispersion },
    contentBoxPx: { median: maskMedian, dispersion: maskDispersion },
    runningHeadTemplates,
    folioModel,
    ornamentLibrary,
    baselineGrid: {
      dominantSpacingPx: dominantSpacing || undefined,
      spacingMAD: spacingMad || undefined,
      confidence: baselineConfidence,
    },
  };
};

type NormalizeConcurrentParams = {
  pages: PageData[];
  analysis: CorpusSummary;
  runDir: string;
  options: NormalizationOptions;
  concurrency: number;
  onError: (pageId: string, message: string) => void;
  control?: RunControl;
  onProgress?: (processed: number, total: number) => void;
  onStageProgress?: (stage: string, processed: number, total: number, throughput: number) => void;
};

const normalizePagesConcurrent = async (
  params: NormalizeConcurrentParams
): Promise<Map<string, NormalizationResult>> => {
  const { pages, analysis, runDir, options, concurrency, onError, control, onProgress } = params;
  const results = new Map<string, NormalizationResult>();
  const estimateById = new Map(analysis.estimates.map((e) => [e.pageId, e]));
  const queue = pages.slice();
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  const total = queue.length;
  let processed = 0;
  const stageNames = ["preprocess", "deskew", "dewarp", "shading", "layout-detection", "normalize"];
  const stageCounts = new Map(stageNames.map((stage) => [stage, 0]));
  const stageStarts = new Map(stageNames.map((stage) => [stage, 0]));

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      await waitForControl(control);
      const page = queue.shift();
      if (!page) continue;
      const estimate = estimateById.get(page.id);
      if (!estimate) continue;
      try {
        const normalized = await normalizePage(page, estimate, analysis, runDir, options);
        if (!normalized) {
          onError(page.id, "Normalization returned no result");
          continue;
        }
        results.set(page.id, normalized);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(page.id, message);
      } finally {
        processed += 1;
        onProgress?.(processed, total);
        if (params.onStageProgress && results.has(page.id)) {
          stageNames.forEach((stage) => {
            const count = (stageCounts.get(stage) ?? 0) + 1;
            stageCounts.set(stage, count);
            const start = stageStarts.get(stage) ?? 0;
            const startedAt = start === 0 ? Date.now() : start;
            if (start === 0) {
              stageStarts.set(stage, startedAt);
            }
            const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
            const throughput = count / elapsedSec;
            params.onStageProgress?.(stage, count, total, throughput);
          });
        }
      }
    }
  });

  await Promise.all(workers);
  return results;
};

const buildFallbackSummary = (config: PipelineRunConfig): CorpusSummary => {
  const targetDimensionsPx = computeTargetDimensionsPx(config.targetDimensionsMm, config.targetDpi);
  const estimates = config.pages.map((page) => {
    const pageBounds: [number, number, number, number] = [
      0,
      0,
      targetDimensionsPx.width,
      targetDimensionsPx.height,
    ];
    const inset = Math.round(Math.min(targetDimensionsPx.width, targetDimensionsPx.height) * 0.015);
    const contentBounds: [number, number, number, number] = [
      inset,
      inset,
      Math.max(inset, targetDimensionsPx.width - inset),
      Math.max(inset, targetDimensionsPx.height - inset),
    ];
    return {
      pageId: page.id,
      widthPx: targetDimensionsPx.width,
      heightPx: targetDimensionsPx.height,
      bleedPx: Math.round(targetDimensionsPx.width * 0.015),
      trimPx: 0,
      pageBounds,
      contentBounds,
    };
  });

  return {
    projectId: config.projectId,
    pageCount: config.pages.length,
    dpi: config.targetDpi,
    targetDimensionsMm: config.targetDimensionsMm,
    targetDimensionsPx,
    dimensionConfidence: 0,
    dpiConfidence: 0,
    estimates,
    notes: "Fallback summary generated after analysis failure.",
  };
};

const cleanupNormalizedOutput = async (runDir: string, pages: PageData[]): Promise<void> => {
  const normalizedDir = getNormalizedDir(runDir);
  const previewDir = getPreviewDir(runDir);
  const manifestPath = getRunManifestPath(runDir);

  try {
    const existing = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(existing) as {
      pages?: Array<{
        pageId: string;
        checksum?: string;
        normalizedFile?: string;
        previews?: string[];
      }>;
    };

    const currentChecksums = new Map(pages.map((page) => [page.id, page.checksum ?? ""]));

    const deletions: string[] = [];
    for (const entry of manifest.pages ?? []) {
      const currentChecksum = currentChecksums.get(entry.pageId);
      const checksumChanged = currentChecksum !== undefined && entry.checksum !== currentChecksum;
      const pageMissing = currentChecksum === undefined;

      if (pageMissing || checksumChanged) {
        if (entry.normalizedFile) {
          deletions.push(path.join(normalizedDir, entry.normalizedFile));
        }
        for (const preview of entry.previews ?? []) {
          deletions.push(path.join(previewDir, preview));
        }
      }
    }

    await Promise.all(
      deletions.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch {
          // ignore missing files
        }
      })
    );
  } catch {
    // no manifest to clean
  }
};

const buildSecondPassOptions = (
  priors: NormalizationPriors,
  bookModel: BookModel | undefined,
  bookPriorsConfig: PipelineConfig["steps"]["book_priors"]
): NormalizationOptions => ({
  priors: {
    ...priors,
    adaptivePaddingPx: priors.adaptivePaddingPx + 6,
    edgeThresholdScale: Math.max(0.7, priors.edgeThresholdScale * 0.85),
    intensityThresholdBias: Math.max(-0.1, priors.intensityThresholdBias - 0.15),
    maxAspectRatioDrift: Math.min(0.2, priors.maxAspectRatioDrift + 0.05),
  },
  generatePreviews: true,
  skewRefinement: "forced",
  bookPriors: {
    model: bookModel,
    maxTrimDriftPx: bookPriorsConfig.max_trim_drift_px,
    maxContentDriftPx: bookPriorsConfig.max_content_drift_px,
    minConfidence: bookPriorsConfig.min_confidence,
  },
});

type QualityGateContext = {
  medianMaskCoverage?: number;
  bookModel?: BookModel;
  outputDimensionsPx?: { width: number; height: number };
};

type QualityGateThresholds = PipelineConfig["steps"]["qa"];

type AbortSignalLike = {
  aborted: boolean;
};

type RunControl = {
  signal?: AbortSignalLike;
  waitIfPaused?: () => Promise<void>;
};

const waitForControl = async (control?: RunControl): Promise<void> => {
  if (control?.signal?.aborted) {
    throw new RunCancelledError();
  }
  if (control?.waitIfPaused) {
    await control.waitIfPaused();
  }
  if (control?.signal?.aborted) {
    throw new RunCancelledError();
  }
};

const intersectionRatio = (
  a: [number, number, number, number],
  b: [number, number, number, number]
): number => {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const area = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
  const bArea = Math.max(1, (b[2] - b[0] + 1) * (b[3] - b[1] + 1));
  return area / bArea;
};

const computeQualityGate = (
  norm: NormalizationResult,
  context: QualityGateContext | undefined,
  thresholds: QualityGateThresholds
): { accepted: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  if (norm.stats.maskCoverage < thresholds.mask_coverage_min) {
    reasons.push("low-mask-coverage");
  }
  if (
    context?.medianMaskCoverage &&
    norm.stats.maskCoverage < context.medianMaskCoverage * thresholds.mask_coverage_drop_ratio
  ) {
    reasons.push("mask-coverage-drop");
  }
  if (norm.stats.skewConfidence < thresholds.skew_confidence_min) {
    reasons.push("low-skew-confidence");
  }
  if (norm.stats.shadowScore > thresholds.shadow_score_max) reasons.push("shadow-heavy");
  if (norm.stats.backgroundStd > thresholds.background_std_max) reasons.push("noisy-background");
  if (
    norm.shading?.residual !== undefined &&
    norm.shading.residual > thresholds.shading_residual_max
  ) {
    reasons.push("shading-residual-worse");
  }
  if (norm.shading && norm.shading.confidence < thresholds.shading_confidence_min) {
    reasons.push("low-shading-confidence");
  }

  const outputDimensions = context?.outputDimensionsPx;
  if (context?.bookModel && outputDimensions) {
    const maskOut = mapBoxToOutput(
      norm.maskBox,
      norm.cropBox,
      outputDimensions.width,
      outputDimensions.height
    );
    const minCoverage = thresholds.book_model_min_coverage;

    (context.bookModel.runningHeadTemplates ?? []).forEach((template) => {
      if (template.confidence < thresholds.book_model_min_confidence) return;
      if (intersectionRatio(maskOut, template.bbox) < minCoverage) {
        reasons.push("book-head-missing");
      }
    });

    (context.bookModel.folioModel?.positionBands ?? []).forEach((band) => {
      if (band.confidence < thresholds.book_model_min_confidence) return;
      const bandBox: [number, number, number, number] = [
        0,
        band.band[0],
        outputDimensions.width - 1,
        band.band[1],
      ];
      if (intersectionRatio(maskOut, bandBox) < minCoverage) {
        reasons.push("book-folio-missing");
      }
    });

    (context.bookModel.ornamentLibrary ?? []).forEach((ornament) => {
      if (ornament.confidence < thresholds.book_model_min_confidence) return;
      if (intersectionRatio(maskOut, ornament.bbox) < minCoverage) {
        reasons.push("book-ornament-missing");
      }
    });
  }
  const accepted = reasons.length === 0;
  return { accepted, reasons };
};

/**
 * Validate baseline alignment for body text pages.
 * Checks for residual skew and text line consistency.
 */
const validateBodyTextBaselines = (
  norm: NormalizationResult,
  profile: LayoutProfile,
  thresholds: QualityGateThresholds
): { aligned: boolean; residualAngle: number; flags: string[] } => {
  const flags: string[] = [];
  let residualAngle = 0;

  // Only validate text-heavy pages
  if (profile !== "body" && profile !== "chapter-opening" && profile !== "table") {
    return { aligned: true, residualAngle: 0, flags: [] };
  }

  // Extract residual angle from corrections if available
  if (norm.corrections?.baseline?.residualAngle !== undefined) {
    residualAngle = Math.abs(norm.corrections.baseline.residualAngle);
  } else if (norm.corrections?.skewResidualAngle !== undefined) {
    residualAngle = Math.abs(norm.corrections.skewResidualAngle);
  }

  // Flag pages with significant residual skew after correction
  if (residualAngle > thresholds.baseline_residual_max) {
    flags.push(`residual-skew-${residualAngle.toFixed(2)}deg`);
  }

  // Combined check: low skew confidence + high background std = potential misalignment
  if (
    norm.stats.skewConfidence < thresholds.baseline_skew_confidence_min &&
    norm.stats.backgroundStd > thresholds.baseline_noise_std_max
  ) {
    flags.push("potential-baseline-misalignment");
  }

  if ((norm.stats.baselineConsistency ?? 1) < thresholds.baseline_consistency_min) {
    flags.push("low-baseline-consistency");
  }

  // High residual skew or baseline misalignment = needs review
  const aligned = flags.length === 0;
  return { aligned, residualAngle, flags };
};

const computeLayoutConfidence = (
  assessment: LayoutAssessment,
  norm: NormalizationResult
): number => {
  const profileScore = assessment.confidence;

  const maskScore = clamp01(norm.stats.maskCoverage);
  const skewScore = clamp01(norm.stats.skewConfidence);
  const shadowPenalty = clamp01(norm.stats.shadowScore / 40);
  const noisePenalty = clamp01(norm.stats.backgroundStd / 40);

  // Profile-specific quality weighting
  let qualityWeights: { mask: number; skew: number; shadow: number; noise: number } = {
    mask: 0.45,
    skew: 0.35,
    shadow: 0.1,
    noise: 0.1,
  };

  // Adjust weights based on layout type
  switch (assessment.profile) {
    case "body":
    case "chapter-opening":
      // Text pages need strong skew alignment and mask coverage
      qualityWeights = { mask: 0.4, skew: 0.5, shadow: 0.05, noise: 0.05 };
      break;
    case "illustration":
    case "blank":
      // Visual pages less sensitive to skew, more to noise
      qualityWeights = { mask: 0.3, skew: 0.2, shadow: 0.25, noise: 0.25 };
      break;
    case "table":
      // Tables need excellent coverage and low skew
      qualityWeights = { mask: 0.5, skew: 0.45, shadow: 0.025, noise: 0.025 };
      break;
    case "front-matter":
    case "back-matter":
      // Front/back matter often sparse; lower quality threshold
      qualityWeights = { mask: 0.35, skew: 0.3, shadow: 0.2, noise: 0.15 };
      break;
    case "cover":
    case "title":
      // Covers/titles more forgiving, focus on overall layout
      qualityWeights = { mask: 0.25, skew: 0.25, shadow: 0.25, noise: 0.25 };
      break;
  }

  const qualityScore = clamp01(
    qualityWeights.mask * maskScore +
      qualityWeights.skew * skewScore +
      qualityWeights.shadow * (1 - shadowPenalty) +
      qualityWeights.noise * (1 - noisePenalty)
  );

  // Confidence combination with type-specific thresholds
  // Text pages: higher profile weight (layout detection is critical)
  // Visual pages: higher quality weight (content appearance is critical)
  const textHeavy = assessment.profile === "body" || assessment.profile === "chapter-opening";
  const visualHeavy = assessment.profile === "illustration" || assessment.profile === "blank";

  let profileWeight = 0.5;
  if (textHeavy) {
    profileWeight = 0.55;
  } else if (visualHeavy) {
    profileWeight = 0.35;
  }
  const qualityWeight = 1 - profileWeight;

  return clamp01(profileWeight * profileScore + qualityWeight * qualityScore);
};

const buildReviewQueue = (
  pages: PageData[],
  normalization: Map<string, NormalizationResult>,
  runId: string,
  projectId: string,
  context: QualityGateContext | undefined,
  config: PipelineConfig,
  spreadMetaByPageId?: Map<string, SpreadMetadata>,
  gutterByPageId?: Map<string, GutterRatio>
): ReviewQueue => {
  const items: ReviewItem[] = [];
  const qaConfig = config.steps.qa;

  // Adaptive semantic threshold based on layout type distribution
  // Higher confidence required for uncertain layout types, lower for high-confidence detections
  const getSemanticThreshold = (profile: LayoutProfile): number =>
    qaConfig.semantic_thresholds[profile] ?? 0.82;

  pages.forEach((page, index) => {
    const norm = normalization.get(page.id);
    if (!norm) return;

    const assessment = inferLayoutProfile(page, index, norm, pages.length);
    const layoutConfidence = computeLayoutConfidence(assessment, norm);
    const qualityGate = computeQualityGate(norm, context, qaConfig);
    const confidenceGate = norm.confidenceGate;
    if (confidenceGate && !confidenceGate.passed) {
      qualityGate.reasons.push(...confidenceGate.reasons, "confidence-gate");
      qualityGate.accepted = false;
    }

    // Validate baseline alignment for text pages
    const baselineValidation = validateBodyTextBaselines(norm, assessment.profile, qaConfig);
    if (!baselineValidation.aligned) {
      qualityGate.reasons.push(...baselineValidation.flags);
    }

    const spreadConfidence = page.confidenceScores.spreadSplit;
    if (
      typeof spreadConfidence === "number" &&
      spreadConfidence < config.steps.spread_split.confidence_threshold
    ) {
      qualityGate.reasons.push("spread-split-low-confidence");
    }

    // Use adaptive threshold per layout type
    const semanticThreshold = getSemanticThreshold(assessment.profile);
    const needsSemanticReview = layoutConfidence < semanticThreshold;
    const needsReview = !qualityGate.accepted || needsSemanticReview;

    if (!needsReview) return;

    const previews = [] as ReviewItem["previews"];
    if (norm.previews?.source) {
      previews.push({ kind: "source", ...norm.previews.source });
    }
    if (norm.previews?.normalized) {
      previews.push({ kind: "normalized", ...norm.previews.normalized });
    }

    const spread = resolveSpreadMetadata(page.id, spreadMetaByPageId, gutterByPageId);
    items.push({
      pageId: page.id,
      filename: page.filename,
      layoutProfile: assessment.profile,
      layoutConfidence,
      qualityGate,
      reason: qualityGate.accepted ? "semantic-layout" : "quality-gate",
      previews,
      suggestedAction: qualityGate.accepted ? "confirm" : "adjust",
      spread,
    });
  });

  return {
    runId,
    projectId,
    generatedAt: new Date().toISOString(),
    items,
  };
};

const mapBoxToOutput = (
  box: [number, number, number, number],
  cropBox: [number, number, number, number],
  outputWidth: number,
  outputHeight: number
): [number, number, number, number] => {
  const cropWidth = Math.max(1, cropBox[2] - cropBox[0] + 1);
  const cropHeight = Math.max(1, cropBox[3] - cropBox[1] + 1);
  const scaleX = outputWidth / cropWidth;
  const scaleY = outputHeight / cropHeight;
  const x0 = Math.max(0, Math.round((box[0] - cropBox[0]) * scaleX));
  const y0 = Math.max(0, Math.round((box[1] - cropBox[1]) * scaleY));
  const x1 = Math.min(outputWidth - 1, Math.round((box[2] - cropBox[0]) * scaleX));
  const y1 = Math.min(outputHeight - 1, Math.round((box[3] - cropBox[1]) * scaleY));
  return [x0, y0, x1, y1];
};

const clampBoxToBounds = (
  box: [number, number, number, number],
  width: number,
  height: number
): [number, number, number, number] => {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(box[0])));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(box[1])));
  const x1 = Math.max(x0 + 1, Math.min(width - 1, Math.round(box[2])));
  const y1 = Math.max(y0 + 1, Math.min(height - 1, Math.round(box[3])));
  return [x0, y0, x1, y1];
};

const buildElementBoxes = (
  pageId: string,
  outputWidth: number,
  outputHeight: number,
  contentBox: [number, number, number, number],
  bookModel?: BookModel
): PageLayoutElement[] => {
  const pageBox: [number, number, number, number] = [0, 0, outputWidth - 1, outputHeight - 1];
  const safeContent = clampBoxToBounds(contentBox, outputWidth, outputHeight);
  const contentWidth = Math.max(1, safeContent[2] - safeContent[0]);
  const contentHeight = Math.max(1, safeContent[3] - safeContent[1]);

  const fromContent = (
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): [number, number, number, number] =>
    clampBoxToBounds(
      [
        safeContent[0] + contentWidth * x0,
        safeContent[1] + contentHeight * y0,
        safeContent[0] + contentWidth * x1,
        safeContent[1] + contentHeight * y1,
      ],
      outputWidth,
      outputHeight
    );

  const elements: PageLayoutElement[] = [];

  const titleBox = fromContent(0.12, 0.02, 0.88, 0.14);
  elements.push(
    {
      id: `${pageId}-page-bounds`,
      type: "page_bounds",
      bbox: pageBox,
      confidence: 0.6,
      source: "local",
      flags: ["derived"],
    },
    {
      id: `${pageId}-text-block`,
      type: "text_block",
      bbox: safeContent,
      confidence: 0.55,
      source: "local",
      flags: ["mask-derived"],
    },
    {
      id: `${pageId}-title`,
      type: "title",
      bbox: titleBox,
      confidence: 0.28,
      source: "local",
      flags: ["heuristic"],
    }
  );

  const runningHeadTemplates = bookModel?.runningHeadTemplates ?? [];
  if (runningHeadTemplates.length > 0) {
    runningHeadTemplates.forEach((template, idx) => {
      elements.push({
        id: `${pageId}-running-head-${idx}`,
        type: "running_head",
        bbox: clampBoxToBounds(template.bbox, outputWidth, outputHeight),
        confidence: clamp01(template.confidence),
        source: "local",
        flags: ["book-model"],
      });
    });
  } else {
    elements.push({
      id: `${pageId}-running-head`,
      type: "running_head",
      bbox: fromContent(0.1, 0, 0.9, 0.08),
      confidence: 0.25,
      source: "local",
      flags: ["heuristic"],
    });
  }

  const folioBands = bookModel?.folioModel?.positionBands ?? [];
  if (folioBands.length > 0) {
    folioBands.forEach((band, idx) => {
      elements.push({
        id: `${pageId}-folio-${idx}`,
        type: "folio",
        bbox: clampBoxToBounds(
          [safeContent[0], band.band[0], safeContent[2], band.band[1]],
          outputWidth,
          outputHeight
        ),
        confidence: clamp01(band.confidence),
        source: "local",
        flags: ["book-model", `side:${band.side}`],
      });
    });
  } else {
    elements.push({
      id: `${pageId}-folio`,
      type: "folio",
      bbox: fromContent(0.42, 0.9, 0.58, 0.98),
      confidence: 0.22,
      source: "local",
      flags: ["heuristic"],
    });
  }

  const ornamentLibrary = bookModel?.ornamentLibrary ?? [];
  if (ornamentLibrary.length > 0) {
    ornamentLibrary.forEach((ornament, idx) => {
      elements.push({
        id: `${pageId}-ornament-${idx}`,
        type: "ornament",
        bbox: clampBoxToBounds(ornament.bbox, outputWidth, outputHeight),
        confidence: clamp01(ornament.confidence),
        source: "local",
        flags: ["book-model"],
      });
    });
  } else {
    elements.push({
      id: `${pageId}-ornament`,
      type: "ornament",
      bbox: fromContent(0.42, 0.18, 0.58, 0.24),
      confidence: 0.2,
      source: "local",
      flags: ["heuristic"],
    });
  }

  elements.push(
    {
      id: `${pageId}-drop-cap`,
      type: "drop_cap",
      bbox: fromContent(0.02, 0.18, 0.1, 0.32),
      confidence: 0.18,
      source: "local",
      flags: ["heuristic"],
    },
    {
      id: `${pageId}-footnote`,
      type: "footnote",
      bbox: fromContent(0.05, 0.86, 0.95, 0.98),
      confidence: 0.2,
      source: "local",
      flags: ["heuristic"],
    },
    {
      id: `${pageId}-marginalia`,
      type: "marginalia",
      bbox: fromContent(0, 0.25, 0.08, 0.75),
      confidence: 0.18,
      source: "local",
      flags: ["heuristic"],
    }
  );

  return elements;
};

const dhash9x8Js = (data: Buffer | Uint8Array): string => {
  if (data.length < 9 * 8) return "0";
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      if (left < right) {
        hash |= 1n << bit;
      }
      bit += 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
};

const computePageDhash = async (
  imagePath: string,
  native: PipelineCoreNative | null
): Promise<string> => {
  try {
    const { data } = await sharp(imagePath)
      .resize(9, 8)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (native) {
      return native.dhash9x8(Buffer.from(data));
    }
    return dhash9x8Js(data);
  } catch {
    return "0";
  }
};

const loadNativeLayoutElements = async (
  pageId: string,
  imagePath: string,
  native: PipelineCoreNative | null
): Promise<PageLayoutElement[] | null> => {
  if (!native) return null;
  try {
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .removeAlpha()
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = Buffer.from(data);
    const elements = native.detectLayoutElements(raw, info.width ?? 0, info.height ?? 0);
    if (!Array.isArray(elements) || elements.length === 0) return null;
    return elements.map((element, index) => ({
      id: element.id || `${pageId}-native-${index}`,
      type: element.type as PageLayoutElement["type"],
      bbox: [
        Math.round(element.bbox[0] ?? 0),
        Math.round(element.bbox[1] ?? 0),
        Math.round(element.bbox[2] ?? 0),
        Math.round(element.bbox[3] ?? 0),
      ] as [number, number, number, number],
      confidence: clamp01(Number(element.confidence ?? 0.5)),
      source: "local",
      flags: ["native"],
    }));
  } catch {
    return null;
  }
};

const elementColor = (type: PageLayoutElement["type"]): string => {
  const colors: Record<PageLayoutElement["type"], string> = {
    page_bounds: "#3b82f6",
    text_block: "#22c55e",
    title: "#ec4899",
    running_head: "#f97316",
    folio: "#a855f7",
    ornament: "#14b8a6",
    drop_cap: "#facc15",
    footnote: "#0ea5e9",
    marginalia: "#94a3b8",
  };
  return colors[type] ?? "#e5e7eb";
};

const buildOverlaySvg = (
  width: number,
  height: number,
  boxes: Array<{ box: [number, number, number, number]; color: string; label?: string }>
): string => {
  const rects = boxes
    .map((entry) => {
      const [x0, y0, x1, y1] = entry.box;
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      const label = entry.label
        ? `<text x="${x0 + 4}" y="${Math.max(12, y0 + 12)}" fill="${entry.color}" font-size="12">${entry.label}</text>`
        : "";
      return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="none" stroke="${entry.color}" stroke-width="2" />${label}`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`;
};

const attachOverlays = async (
  reviewQueue: ReviewQueue,
  normalization: Map<string, NormalizationResult>,
  runDir: string,
  bookModel?: BookModel,
  gutterByPageId?: Map<string, GutterRatio>,
  control?: RunControl
): Promise<void> => {
  const overlayDir = getOverlayDir(runDir);
  await fs.mkdir(overlayDir, { recursive: true });

  await Promise.all(
    reviewQueue.items.map(async (item) => {
      await waitForControl(control);
      const norm = normalization.get(item.pageId);
      if (!norm) return;
      try {
        const meta = await sharp(norm.normalizedPath).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        if (!width || !height) return;

        const maskBox = mapBoxToOutput(norm.maskBox, norm.cropBox, width, height);
        const overlayBoxes = [
          {
            box: [0, 0, width - 1, height - 1] as [number, number, number, number],
            color: "#3b82f6",
            label: "page",
          },
          { box: maskBox, color: "#22c55e", label: "content" },
        ];

        const elements = buildElementBoxes(item.pageId, width, height, maskBox, bookModel);
        elements.forEach((element) => {
          overlayBoxes.push({
            box: element.bbox,
            color: elementColor(element.type),
            label: element.type.replace("_", " "),
          });
        });

        const gutter = gutterByPageId?.get(item.pageId);
        if (gutter) {
          const gx0 = Math.max(0, Math.round(width * gutter.startRatio));
          const gx1 = Math.min(width - 1, Math.round(width * gutter.endRatio));
          overlayBoxes.push({
            box: [gx0, 0, gx1, height - 1],
            color: "#facc15",
            label: "gutter",
          });
        }

        const svg = buildOverlaySvg(width, height, overlayBoxes);
        const overlayPath = getRunOverlayPath(runDir, item.pageId);
        await sharp({
          create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .composite([{ input: Buffer.from(svg) }])
          .png({ compressionLevel: 6 })
          .toFile(overlayPath);

        item.previews.push({ kind: "overlay", path: overlayPath, width, height });
      } catch {
        // ignore overlay errors
      }
    })
  );
};

export interface PipelineRunnerOptions {
  projectRoot: string;
  projectId: string;
  targetDpi?: number;
  targetDimensionsMm?: { width: number; height: number };
  sampleCount?: number; // Limit processing for eval
  outputDir?: string;
  enableSpreadSplit?: boolean;
  spreadSplitConfidence?: number;
  enableBookPriors?: boolean;
  bookPriorsSampleCount?: number;
  pipelineConfigPath?: string;
  pipelineConfigOverrides?: Partial<PipelineConfig>;
  runId?: string;
  signal?: AbortSignalLike;
  waitIfPaused?: () => Promise<void>;
  onProgress?: (event: RunProgressEvent) => void;
}

export interface PipelineRunnerResult {
  success: boolean;
  runId: string;
  projectId: string;
  pageCount: number;
  durationMs: number;
  scanConfig: PipelineRunConfig;
  analysisSummary: CorpusSummary;
  pipelineResult: PipelineRunResult;
  errors: Array<{ phase: string; message: string }>;
}

const scanCorpusWithRetries = async (
  options: PipelineRunnerOptions,
  runId: string,
  errors: Array<{ phase: string; message: string }>,
  control?: RunControl
): Promise<PipelineRunConfig> => {
  console.log(`[${runId}] Scanning corpus at ${options.projectRoot}...`);
  let scanConfig: PipelineRunConfig | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await waitForControl(control);
      scanConfig = await scanCorpus(options.projectRoot, {
        includeChecksums: true,
        targetDpi: options.targetDpi,
        targetDimensionsMm: options.targetDimensionsMm,
        projectId: options.projectId,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ phase: "scan", message: `Attempt ${attempt}: ${message}` });
      if (attempt < 2) {
        await sleep(150);
      }
    }
  }

  if (!scanConfig) {
    throw new Error("Scan corpus failed after retries");
  }
  console.log(`[${runId}] Scan complete: ${scanConfig.pages.length} pages discovered`);

  if (options.targetDpi) {
    scanConfig.targetDpi = options.targetDpi;
  }
  if (options.targetDimensionsMm) {
    scanConfig.targetDimensionsMm = options.targetDimensionsMm;
  }
  scanConfig.projectId = options.projectId;
  return scanConfig;
};

const applySpreadSplitIfEnabled = async (
  scanConfig: PipelineRunConfig,
  options: PipelineRunnerOptions,
  config: PipelineConfig,
  runDir: string
): Promise<{
  pages: PageData[];
  gutterByPageId: Map<string, GutterRatio>;
  spreadMetaByPageId: Map<string, SpreadMetadata>;
}> => {
  const gutterByPageId = new Map<string, GutterRatio>();
  const spreadMetaByPageId = new Map<string, SpreadMetadata>();
  const enableSplit = options.enableSpreadSplit ?? config.steps.spread_split.enabled;
  if (!enableSplit) {
    return { pages: scanConfig.pages, gutterByPageId, spreadMetaByPageId };
  }
  const splitOutputDir = runDir;
  const splitPages: PageData[] = [];
  const threshold = options.spreadSplitConfidence ?? config.steps.spread_split.confidence_threshold;
  for (const page of scanConfig.pages) {
    const split = await detectSpread(page);
    if (split.shouldSplit && split.confidence >= threshold) {
      const splitResult = await splitSpreadPage(page, split, splitOutputDir);
      if (splitResult) {
        splitPages.push(...splitResult.pages);
        splitResult.gutterByPageId.forEach((value, key) => gutterByPageId.set(key, value));
        splitResult.spreadMetaByPageId.forEach((value, key) => spreadMetaByPageId.set(key, value));
        continue;
      }
    }
    if (split.confidence > 0) {
      page.confidenceScores = {
        ...page.confidenceScores,
        spreadSplit: split.confidence,
      };
      if (
        split.gutterStartRatio !== undefined &&
        split.gutterEndRatio !== undefined &&
        split.gutterStartRatio < split.gutterEndRatio
      ) {
        gutterByPageId.set(page.id, {
          startRatio: split.gutterStartRatio,
          endRatio: split.gutterEndRatio,
        });
      }
    }
    splitPages.push(page);
  }
  return { pages: splitPages, gutterByPageId, spreadMetaByPageId };
};

const applySampling = (
  scanConfig: PipelineRunConfig,
  sampleCount: number | undefined,
  runId: string
): PipelineRunConfig => {
  if (sampleCount && sampleCount < scanConfig.pages.length) {
    console.log(
      `[${runId}] Sampling ${sampleCount} of ${scanConfig.pages.length} pages for evaluation`
    );
    return {
      ...scanConfig,
      pages: scanConfig.pages.slice(0, sampleCount),
    };
  }
  return scanConfig;
};

const analyzeCorpusSafe = async (
  configToProcess: PipelineRunConfig,
  runId: string,
  errors: Array<{ phase: string; message: string }>
): Promise<CorpusSummary> => {
  console.log(`[${runId}] Analyzing corpus bounds for ${configToProcess.pages.length} pages...`);
  try {
    const analysisSummary = await analyzeCorpus(configToProcess);
    console.log(
      `[${runId}] Analysis complete: page bounds computed, ${analysisSummary.estimates.length} estimates`
    );
    return analysisSummary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ phase: "analysis", message });
    return buildFallbackSummary(configToProcess);
  }
};

const buildBookModelIfEnabled = async (params: {
  configToProcess: PipelineRunConfig;
  analysisSummary: CorpusSummary;
  runDir: string;
  priors: NormalizationPriors;
  concurrency: number;
  options: PipelineRunnerOptions;
  bookPriorsConfig: PipelineConfig["steps"]["book_priors"];
  errors: Array<{ phase: string; message: string }>;
  control?: RunControl;
}): Promise<BookModel | undefined> => {
  await waitForControl(params.control);
  const enableBookPriors = params.options.enableBookPriors ?? params.bookPriorsConfig.enabled;
  const sampleCount = Math.min(
    params.options.bookPriorsSampleCount ?? params.bookPriorsConfig.sample_pages,
    params.configToProcess.pages.length
  );
  if (!enableBookPriors || sampleCount <= 0) return undefined;

  const samplePages = params.configToProcess.pages.slice(0, sampleCount);
  const sampleDir = path.join(params.runDir, "priors-sample");
  await fs.mkdir(sampleDir, { recursive: true });
  try {
    const sampleResults = await normalizePagesConcurrent({
      pages: samplePages,
      analysis: params.analysisSummary,
      runDir: sampleDir,
      options: {
        priors: params.priors,
        generatePreviews: false,
        skewRefinement: "on",
      },
      concurrency: Math.max(1, Math.min(4, params.concurrency)),
      onError: () => {
        // ignore sampling errors
      },
      control: params.control,
    });
    return await deriveBookModel(
      Array.from(sampleResults.values()),
      params.analysisSummary.targetDimensionsPx
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.errors.push({ phase: "book-priors", message });
    return undefined;
  }
};

const buildSecondPassCandidates = (
  pages: PageData[],
  normalizationResults: Map<string, NormalizationResult>,
  qualityContext: QualityGateContext,
  qaConfig: QualityGateThresholds
): PageData[] => {
  const candidates: PageData[] = [];
  pages.forEach((page, index) => {
    const norm = normalizationResults.get(page.id);
    if (!norm) return;
    if (norm.confidenceGate && !norm.confidenceGate.passed) return;
    const assessment = inferLayoutProfile(page, index, norm, pages.length);
    const qualityGate = computeQualityGate(norm, qualityContext, qaConfig);
    const baselineValidation = validateBodyTextBaselines(norm, assessment.profile, qaConfig);
    if (!qualityGate.accepted || !baselineValidation.aligned) {
      candidates.push(page);
    }
  });
  return candidates;
};

const writeRunManifestSnapshot = async (params: {
  runId: string;
  runDir: string;
  projectRoot: string;
  status: RunIndexStatus;
  configSnapshot: { resolved: PipelineConfig; sources: PipelineConfigSources };
}): Promise<void> => {
  const manifest = {
    runId: params.runId,
    status: params.status,
    exportedAt: new Date().toISOString(),
    sourceRoot: params.projectRoot,
    count: 0,
    configSnapshot: params.configSnapshot,
    determinism: {
      appVersion: "unknown",
      configHash: "unknown",
      rustModuleVersion: "unknown",
      modelHashes: [],
      seed: "static",
    },
    pages: [],
  };
  await writeJsonAtomic(getRunManifestPath(params.runDir), manifest);
};

const savePipelineOutputs = async (params: {
  runId: string;
  outputDir: string;
  runDir: string;
  projectRoot: string;
  projectId: string;
  scanConfig: PipelineRunConfig;
  analysisSummary: CorpusSummary;
  pipelineResult: PipelineRunResult;
  bookModel: BookModel | undefined;
  reviewQueue: ReviewQueue;
  normalizationResults: Map<string, NormalizationResult>;
  configToProcess: PipelineRunConfig;
  native: ReturnType<typeof getPipelineCoreNative>;
  appVersion: string;
  configHash: string;
  configSnapshot: { resolved: PipelineConfig; sources: PipelineConfigSources };
  gutterByPageId?: Map<string, GutterRatio>;
  spreadMetaByPageId?: Map<string, SpreadMetadata>;
  control?: RunControl;
}): Promise<void> => {
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.mkdir(params.runDir, { recursive: true });
  const reportPath = getRunReportPath(params.runDir);
  await writeJsonAtomic(reportPath, {
    runId: params.runId,
    projectId: params.projectId,
    status: params.pipelineResult.status,
    updatedAt: new Date().toISOString(),
    scanConfig: {
      pageCount: params.scanConfig.pages.length,
      targetDpi: params.scanConfig.targetDpi,
      targetDimensionsMm: params.scanConfig.targetDimensionsMm,
    },
    analysisSummary: params.analysisSummary,
    pipelineResult: params.pipelineResult,
    bookModel: params.bookModel,
    configSnapshot: params.configSnapshot,
    determinism: {
      appVersion: params.appVersion,
      configHash: params.configHash,
      rustModuleVersion: "unknown",
      modelHashes: [],
      seed: "static",
    },
    reviewQueue: params.reviewQueue,
  });
  console.log(`[${params.runId}] Report saved to ${reportPath}`);

  await updateRunIndex(params.outputDir, {
    runId: params.runId,
    projectId: params.projectId,
    generatedAt: params.reviewQueue.generatedAt,
    reportPath,
    reviewQueuePath: getRunReviewQueuePath(params.runDir),
    reviewCount: params.reviewQueue.items.length,
    status: params.pipelineResult.status as RunIndexStatus,
    updatedAt: new Date().toISOString(),
    inferredDimensionsMm: params.analysisSummary.inferredDimensionsMm,
    inferredDpi: params.analysisSummary.inferredDpi,
    dimensionConfidence: params.analysisSummary.dimensionConfidence,
    dpiConfidence: params.analysisSummary.dpiConfidence,
  });

  const layoutSummaries = await writeSidecars(
    params.configToProcess,
    params.analysisSummary,
    params.normalizationResults,
    params.runDir,
    params.runId,
    params.native,
    params.bookModel,
    params.configSnapshot.resolved,
    params.gutterByPageId,
    params.spreadMetaByPageId,
    params.control
  );

  const normalizedDir = getNormalizedDir(params.runDir);
  await fs.mkdir(normalizedDir, { recursive: true });
  const previewDir = getPreviewDir(params.runDir);
  await fs.mkdir(previewDir, { recursive: true });
  const overlayDir = getOverlayDir(params.runDir);
  await fs.mkdir(overlayDir, { recursive: true });
  const checksumById = new Map(
    params.configToProcess.pages.map((page) => [page.id, page.checksum])
  );
  const dhashEntries = await Promise.all(
    Array.from(params.normalizationResults.values()).map(async (norm) => ({
      pageId: norm.pageId,
      dhash: await computePageDhash(norm.normalizedPath, params.native),
    }))
  );
  const dhashById = new Map(dhashEntries.map((entry) => [entry.pageId, entry.dhash]));
  const manifest = {
    runId: params.runId,
    status: params.pipelineResult.status,
    exportedAt: new Date().toISOString(),
    sourceRoot: params.projectRoot,
    count: params.normalizationResults.size,
    configSnapshot: params.configSnapshot,
    analysisSummary: params.analysisSummary,
    determinism: {
      appVersion: params.appVersion,
      configHash: params.configHash,
      rustModuleVersion: "unknown",
      modelHashes: [],
      seed: "static",
    },
    pages: Array.from(params.normalizationResults.values()).map((norm) => {
      const spread = resolveSpreadMetadata(
        norm.pageId,
        params.spreadMetaByPageId,
        params.gutterByPageId
      );
      return {
        pageId: norm.pageId,
        checksum: checksumById.get(norm.pageId) ?? "",
        dhash: dhashById.get(norm.pageId) ?? "0",
        normalizedFile: path.basename(norm.normalizedPath),
        previews: [
          norm.previews?.source?.path ? path.basename(norm.previews.source.path) : undefined,
          norm.previews?.normalized?.path
            ? path.basename(norm.previews.normalized.path)
            : undefined,
        ].filter(Boolean),
        spread,
        stages: {
          preprocess: {
            backgroundMean: norm.stats.backgroundMean,
            backgroundStd: norm.stats.backgroundStd,
            maskCoverage: norm.stats.maskCoverage,
          },
          deskew: {
            angleDeg: norm.skewAngle,
            confidence: norm.stats.skewConfidence,
            applied: norm.corrections?.deskewApplied ?? true,
            residualDeg: norm.corrections?.skewResidualAngle ?? 0,
          },
          dewarp: {
            method: norm.corrections?.alignment?.applied ? "affine" : "none",
            drift: norm.corrections?.alignment?.drift ?? 0,
            applied: norm.corrections?.alignment?.applied ?? false,
          },
          shading: norm.shading
            ? {
                method: norm.shading.method,
                confidence: norm.shading.confidence,
                residual: norm.shading.residual ?? null,
                applied: norm.shading.applied,
              }
            : { method: "none", confidence: 0, residual: null, applied: false },
          layoutDetection: {
            profile: layoutSummaries.get(norm.pageId)?.profile ?? "body",
            confidence: layoutSummaries.get(norm.pageId)?.confidence ?? 0,
            elementCount: layoutSummaries.get(norm.pageId)?.elementCount ?? 0,
            source: layoutSummaries.get(norm.pageId)?.source ?? "unknown",
          },
          confidenceGate: norm.confidenceGate ?? { passed: true, reasons: [] },
        },
      };
    }),
  };
  await writeJsonAtomic(getRunManifestPath(params.runDir), manifest);

  const reviewPath = getRunReviewQueuePath(params.runDir);
  await writeJsonAtomic(reviewPath, params.reviewQueue);
  console.log(`[${params.runId}] Review queue saved to ${reviewPath}`);
};

const saveRunFailureOutputs = async (params: {
  runId: string;
  outputDir: string;
  runDir: string;
  projectRoot: string;
  projectId: string;
  scanConfig: PipelineRunConfig;
  analysisSummary: CorpusSummary;
  pipelineResult: PipelineRunResult;
  reviewQueue: ReviewQueue;
  normalizationResults: Map<string, NormalizationResult>;
  configSnapshot: { resolved: PipelineConfig; sources: PipelineConfigSources };
}): Promise<void> => {
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.mkdir(params.runDir, { recursive: true });
  const reportPath = getRunReportPath(params.runDir);
  await writeJsonAtomic(reportPath, {
    runId: params.runId,
    projectId: params.projectId,
    status: params.pipelineResult.status,
    updatedAt: new Date().toISOString(),
    scanConfig: {
      pageCount: params.scanConfig.pages.length,
      targetDpi: params.scanConfig.targetDpi,
      targetDimensionsMm: params.scanConfig.targetDimensionsMm,
    },
    analysisSummary: params.analysisSummary,
    pipelineResult: params.pipelineResult,
    configSnapshot: params.configSnapshot,
    determinism: {
      appVersion: "unknown",
      configHash: "unknown",
      rustModuleVersion: "unknown",
      modelHashes: [],
      seed: "static",
    },
    reviewQueue: params.reviewQueue,
  });

  const generatedAt = params.reviewQueue.generatedAt || new Date().toISOString();
  await updateRunIndex(params.outputDir, {
    runId: params.runId,
    projectId: params.projectId,
    generatedAt,
    reportPath,
    reviewQueuePath: getRunReviewQueuePath(params.runDir),
    reviewCount: params.reviewQueue.items.length,
    status: params.pipelineResult.status as RunIndexStatus,
    updatedAt: new Date().toISOString(),
    inferredDimensionsMm: params.analysisSummary.inferredDimensionsMm,
    inferredDpi: params.analysisSummary.inferredDpi,
    dimensionConfidence: params.analysisSummary.dimensionConfidence,
    dpiConfidence: params.analysisSummary.dpiConfidence,
  });

  const manifest = {
    runId: params.runId,
    status: params.pipelineResult.status,
    exportedAt: new Date().toISOString(),
    sourceRoot: params.projectRoot,
    count: params.normalizationResults.size,
    configSnapshot: params.configSnapshot,
    analysisSummary: params.analysisSummary,
    determinism: {
      appVersion: "unknown",
      configHash: "unknown",
      rustModuleVersion: "unknown",
      modelHashes: [],
      seed: "static",
    },
    pages: [],
  };
  await writeJsonAtomic(getRunManifestPath(params.runDir), manifest);

  const reviewPath = getRunReviewQueuePath(params.runDir);
  await writeJsonAtomic(reviewPath, params.reviewQueue);
};

const mergeOverrides = <T extends Record<string, unknown>>(base: T, update: Partial<T>): T => {
  const output: T = { ...base };
  Object.entries(update).forEach(([key, value]) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      (output as Record<string, unknown>)[key] = value;
      return;
    }
    if (value && typeof value === "object") {
      const current = (output as Record<string, unknown>)[key];
      if (current && typeof current === "object" && !Array.isArray(current)) {
        (output as Record<string, unknown>)[key] = mergeOverrides(
          current as Record<string, unknown>,
          value as Partial<Record<string, unknown>>
        );
        return;
      }
    }
    (output as Record<string, unknown>)[key] = value as unknown;
  });
  return output;
};

const buildDerivedOverrides = (
  options: PipelineRunnerOptions,
  baseConfig: PipelineConfig
): Partial<PipelineConfig> => {
  const derivedOverrides: Partial<PipelineConfig> = {};
  if (options.targetDpi || options.targetDimensionsMm) {
    derivedOverrides.project = {
      ...baseConfig.project,
      dpi: options.targetDpi ?? baseConfig.project.dpi,
      target_dimensions: options.targetDimensionsMm
        ? {
            width: options.targetDimensionsMm.width,
            height: options.targetDimensionsMm.height,
            unit: "mm",
          }
        : baseConfig.project.target_dimensions,
    };
  }
  if (options.enableSpreadSplit !== undefined || options.spreadSplitConfidence !== undefined) {
    derivedOverrides.steps = {
      ...baseConfig.steps,
      ...derivedOverrides.steps,
      spread_split: {
        ...baseConfig.steps.spread_split,
        enabled: options.enableSpreadSplit ?? baseConfig.steps.spread_split.enabled,
        confidence_threshold:
          options.spreadSplitConfidence ?? baseConfig.steps.spread_split.confidence_threshold,
      },
    };
  }
  if (options.enableBookPriors !== undefined || options.bookPriorsSampleCount !== undefined) {
    derivedOverrides.steps = {
      ...baseConfig.steps,
      ...derivedOverrides.steps,
      book_priors: {
        ...baseConfig.steps.book_priors,
        enabled: options.enableBookPriors ?? baseConfig.steps.book_priors.enabled,
        sample_pages: options.bookPriorsSampleCount ?? baseConfig.steps.book_priors.sample_pages,
      },
    };
  }
  return derivedOverrides;
};

const applySecondPassCorrections = async (params: {
  runId: string;
  projectId: string;
  secondPassCandidates: PageData[];
  analysisSummary: CorpusSummary;
  runDir: string;
  normalizationOptions: NormalizationOptions;
  bookModel: BookModel | undefined;
  bookPriorsConfig: PipelineConfig["steps"]["book_priors"];
  concurrency: number;
  errors: Array<{ phase: string; message: string }>;
  control?: RunControl;
  normalizationResults: Map<string, NormalizationResult>;
  onProgress?: (event: RunProgressEvent) => void;
}): Promise<Map<string, NormalizationResult>> => {
  if (params.secondPassCandidates.length === 0) {
    return params.normalizationResults;
  }
  console.log(
    `[${params.runId}] Running second-pass corrections for ${params.secondPassCandidates.length} pages...`
  );
  await waitForControl(params.control);
  const secondPassStart = Date.now();
  const secondPassOptions = buildSecondPassOptions(
    params.normalizationOptions.priors!,
    params.bookModel,
    params.bookPriorsConfig
  );
  const secondPassResults = await normalizePagesConcurrent({
    pages: params.secondPassCandidates,
    analysis: params.analysisSummary,
    runDir: params.runDir,
    options: secondPassOptions,
    concurrency: Math.max(1, Math.floor(params.concurrency / 2)),
    onError: (pageId, message) => {
      params.errors.push({ phase: "second-pass", message: `[${pageId}] ${message}` });
    },
    control: params.control,
    onProgress: (processed, total) => {
      const elapsedSec = Math.max(0.001, (Date.now() - secondPassStart) / 1000);
      const throughput = processed / elapsedSec;
      params.onProgress?.({
        runId: params.runId,
        projectId: params.projectId,
        stage: "second-pass",
        processed,
        total,
        throughput,
        timestamp: new Date().toISOString(),
      });
    },
  });
  secondPassResults.forEach((value, key) => {
    params.normalizationResults.set(key, value);
  });
  console.log(`[${params.runId}] Second-pass corrections complete`);
  return params.normalizationResults;
};

/**
 * Execute full pipeline: scan -> analyze -> process.
 */
export async function runPipeline(options: PipelineRunnerOptions): Promise<PipelineRunnerResult> {
  const startTime = Date.now();
  const runId = options.runId ?? `run-${Date.now()}`;
  const errors: Array<{ phase: string; message: string }> = [];
  const outputDir = options.outputDir ?? path.join(process.cwd(), "pipeline-results");
  const runDir = getRunDir(outputDir, runId);
  const control: RunControl = {
    signal: options.signal,
    waitIfPaused: options.waitIfPaused,
  };
  const emitProgress = (event: Omit<RunProgressEvent, "timestamp">): void => {
    options.onProgress?.({ ...event, timestamp: new Date().toISOString() });
  };
  let scanConfig: PipelineRunConfig | null = null;
  let analysisSummary: CorpusSummary | null = null;
  let normalizationResults: Map<string, NormalizationResult> = new Map();
  let reviewQueue: ReviewQueue = {
    runId,
    projectId: options.projectId,
    generatedAt: new Date().toISOString(),
    items: [],
  };
  let configSnapshot: { resolved: PipelineConfig; sources: PipelineConfigSources } | null = null;

  const native = getPipelineCoreNative();
  console.log(
    `[${runId}] Native pipeline-core ${native ? "enabled" : "unavailable; using JS fallbacks"}`
  );

  try {
    await fs.mkdir(runDir, { recursive: true });
    await updateRunIndex(outputDir, {
      runId,
      projectId: options.projectId,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    await updateReportStatus({
      runDir,
      runId,
      projectId: options.projectId,
      status: "running",
    });
    emitProgress({
      runId,
      projectId: options.projectId,
      stage: "starting",
      processed: 0,
      total: 0,
    });
    await waitForControl(control);
    const {
      config: baseConfig,
      configPath,
      loadedFromFile,
    } = await loadPipelineConfig(options.pipelineConfigPath);
    const derivedOverrides = buildDerivedOverrides(options, baseConfig);

    const projectOverrides = await loadProjectOverrides(options.projectId);
    const combinedOverrides = mergeOverrides(
      mergeOverrides(projectOverrides.overrides ?? {}, derivedOverrides),
      options.pipelineConfigOverrides ?? {}
    );

    const { resolvedConfig, sources } = resolvePipelineConfig(baseConfig, {
      overrides: combinedOverrides,
      env: process.env,
      configPath,
      loadedFromFile,
      projectConfigPath: projectOverrides.configPath,
      projectOverrides: projectOverrides.overrides,
    });

    configSnapshot = { resolved: resolvedConfig, sources };
    const targetDimensionsMm = {
      width: resolvedConfig.project.target_dimensions.width,
      height: resolvedConfig.project.target_dimensions.height,
    };
    const optionsWithConfig: PipelineRunnerOptions = {
      ...options,
      targetDpi: resolvedConfig.project.dpi,
      targetDimensionsMm,
    };

    await waitForControl(control);
    scanConfig = await scanCorpusWithRetries(optionsWithConfig, runId, errors, control);
    emitProgress({
      runId,
      projectId: options.projectId,
      stage: "scan",
      processed: scanConfig.pages.length,
      total: scanConfig.pages.length,
    });

    const spreadSplitResult = await applySpreadSplitIfEnabled(
      scanConfig,
      optionsWithConfig,
      resolvedConfig,
      runDir
    );
    scanConfig.pages = spreadSplitResult.pages;

    let configToProcess = applySampling(scanConfig, options.sampleCount, runId);
    await waitForControl(control);
    emitProgress({
      runId,
      projectId: options.projectId,
      stage: "analysis",
      processed: 0,
      total: configToProcess.pages.length,
    });
    analysisSummary = await analyzeCorpusSafe(configToProcess, runId, errors);
    const inferredConfig = applyDimensionInference(
      configToProcess,
      analysisSummary,
      DIMENSION_CONFIDENCE_THRESHOLD
    );
    if (inferredConfig !== configToProcess) {
      configToProcess = inferredConfig;
      scanConfig.targetDimensionsMm = inferredConfig.targetDimensionsMm;
      const { bounds, targetPx } = await estimatePageBounds(inferredConfig);
      analysisSummary = {
        ...analysisSummary,
        targetDimensionsMm: inferredConfig.targetDimensionsMm,
        targetDimensionsPx: targetPx,
        estimates: bounds,
        notes: analysisSummary.notes
          ? `${analysisSummary.notes} Inferred target dimensions applied.`
          : "Inferred target dimensions applied.",
      };
    }
    emitProgress({
      runId,
      projectId: options.projectId,
      stage: "analysis",
      processed: configToProcess.pages.length,
      total: configToProcess.pages.length,
      inferredDimensionsMm: analysisSummary.inferredDimensionsMm,
      inferredDpi: analysisSummary.inferredDpi,
      dimensionConfidence: analysisSummary.dimensionConfidence,
      dpiConfidence: analysisSummary.dpiConfidence,
    });

    // Phase 3: Normalization
    console.log(`[${runId}] Running normalization pipeline...`);
    await waitForControl(control);
    await cleanupNormalizedOutput(runDir, configToProcess.pages);
    await writeRunManifestSnapshot({
      runId,
      runDir,
      projectRoot: options.projectRoot,
      status: "running",
      configSnapshot,
    });
    const concurrency = Math.max(1, Number(process.env.ASTERIA_NORMALIZE_CONCURRENCY ?? 6));
    const priors = deriveNormalizationPriors(analysisSummary);
    const bookPriorsConfig = resolvedConfig.steps.book_priors;
    const qaConfig = resolvedConfig.steps.qa;

    const bookModel = await buildBookModelIfEnabled({
      configToProcess,
      analysisSummary,
      runDir,
      priors,
      concurrency,
      options,
      bookPriorsConfig,
      errors,
      control,
    });

    const normalizationOptions: NormalizationOptions = {
      priors,
      generatePreviews: true,
      skewRefinement: "on",
      confidenceGate: {
        deskewMin: qaConfig.skew_confidence_min,
        shadingMin: qaConfig.shading_confidence_min,
      },
      shading: {
        confidenceFloor: qaConfig.shading_confidence_min,
      },
      bookPriors: {
        model: bookModel,
        maxTrimDriftPx: bookPriorsConfig.max_trim_drift_px,
        maxContentDriftPx: bookPriorsConfig.max_content_drift_px,
        minConfidence: bookPriorsConfig.min_confidence,
      },
    };
    await waitForControl(control);
    normalizationResults = await normalizePagesConcurrent({
      pages: configToProcess.pages,
      analysis: analysisSummary,
      runDir,
      options: normalizationOptions,
      concurrency,
      onError: (pageId, message) => {
        errors.push({ phase: "normalization", message: `[${pageId}] ${message}` });
      },
      control,
      onStageProgress: (stage, processed, total, throughput) => {
        options.onProgress?.({
          runId,
          projectId: options.projectId,
          stage,
          processed,
          total,
          throughput,
          timestamp: new Date().toISOString(),
        });
      },
    });
    console.log(`[${runId}] Normalized ${normalizationResults.size} pages`);

    const qualityContext: QualityGateContext = {
      bookModel,
      outputDimensionsPx: analysisSummary.targetDimensionsPx,
    };
    await waitForControl(control);
    const secondPassCandidates = buildSecondPassCandidates(
      configToProcess.pages,
      normalizationResults,
      qualityContext,
      qaConfig
    );

    normalizationResults = await applySecondPassCorrections({
      runId,
      projectId: options.projectId,
      secondPassCandidates,
      analysisSummary,
      runDir,
      normalizationOptions,
      bookModel,
      bookPriorsConfig,
      concurrency,
      errors,
      control,
      normalizationResults,
      onProgress: options.onProgress,
    });

    const normArray = Array.from(normalizationResults.values());
    const avgSkew =
      normArray.reduce((sum, n) => sum + Math.abs(n.skewAngle), 0) / Math.max(1, normArray.length);
    const avgMaskCoverage =
      normArray.reduce((sum, n) => sum + n.stats.maskCoverage, 0) / Math.max(1, normArray.length);
    const shadowRate =
      normArray.filter((n) => n.shadow.present).length / Math.max(1, normArray.length);
    const lowCoverageCount = normArray.filter(
      (n) => n.stats.maskCoverage < qaConfig.mask_coverage_min
    ).length;

    const medianMaskCoverage = median(normArray.map((n) => n.stats.maskCoverage));
    reviewQueue = buildReviewQueue(
      configToProcess.pages,
      normalizationResults,
      runId,
      options.projectId,
      {
        ...qualityContext,
        medianMaskCoverage,
      },
      resolvedConfig,
      spreadSplitResult.spreadMetaByPageId,
      spreadSplitResult.gutterByPageId
    );
    emitProgress({
      runId,
      projectId: options.projectId,
      stage: "review",
      processed: reviewQueue.items.length,
      total: reviewQueue.items.length,
    });
    await waitForControl(control);
    await attachOverlays(
      reviewQueue,
      normalizationResults,
      runDir,
      bookModel,
      spreadSplitResult.gutterByPageId,
      control
    );
    const strictAcceptCount = normArray.filter(
      (norm) =>
        computeQualityGate(norm, { ...qualityContext, medianMaskCoverage }, qaConfig).accepted
    ).length;

    const appVersion = await getAppVersion();
    const configHash = hashConfig(configSnapshot.resolved);

    const pipelineResult: PipelineRunResult = {
      runId,
      runDir,
      status: "success",
      pagesProcessed: configToProcess.pages.length,
      errors: [],
      metrics: {
        durationMs: Date.now() - startTime,
        estimatedPages: analysisSummary.pageCount,
        targetDpi: analysisSummary.dpi,
        normalizedPages: normalizationResults.size,
        normalization: {
          avgSkewDeg: avgSkew,
          avgMaskCoverage,
          shadowRate,
          lowCoverageCount,
          reviewQueueCount: reviewQueue.items.length,
          strictAcceptRate: strictAcceptCount / Math.max(1, normArray.length),
          secondPassCount: secondPassCandidates.length,
        },
      },
    };
    console.log(`[${runId}] Pipeline complete in ${pipelineResult.metrics.durationMs}ms`);

    // Phase 4: Save results
    if (options.outputDir) {
      await savePipelineOutputs({
        runId,
        outputDir: options.outputDir,
        runDir,
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        scanConfig,
        analysisSummary,
        pipelineResult,
        bookModel,
        reviewQueue,
        normalizationResults,
        configToProcess,
        native,
        appVersion,
        configHash,
        configSnapshot: configSnapshot ?? { resolved: resolvedConfig, sources },
        gutterByPageId: spreadSplitResult.gutterByPageId,
        spreadMetaByPageId: spreadSplitResult.spreadMetaByPageId,
        control,
      });
    }

    emitProgress({
      runId,
      projectId: options.projectId,
      stage: "complete",
      processed: configToProcess.pages.length,
      total: configToProcess.pages.length,
    });

    return {
      success: true,
      runId,
      projectId: options.projectId,
      pageCount: configToProcess.pages.length,
      durationMs: Date.now() - startTime,
      scanConfig: configToProcess,
      analysisSummary,
      pipelineResult,
      errors,
    };
  } catch (error) {
    const isCancelled = error instanceof RunCancelledError;
    const message = error instanceof Error ? error.message : String(error);
    if (isCancelled) {
      errors.push({ phase: "pipeline", message: "Run cancelled" });
      console.warn(`[${runId}] Pipeline cancelled by user.`);
      emitProgress({
        runId,
        projectId: options.projectId,
        stage: "cancelled",
        processed: normalizationResults.size,
        total: scanConfig?.pages.length ?? 0,
      });
    } else {
      errors.push({ phase: "pipeline", message });
      console.error(`[${runId}] Pipeline failed:`, message);
      emitProgress({
        runId,
        projectId: options.projectId,
        stage: "error",
        processed: normalizationResults.size,
        total: scanConfig?.pages.length ?? 0,
      });
    }

    const pipelineResult: PipelineRunResult = {
      runId,
      runDir,
      status: isCancelled ? "cancelled" : "error",
      pagesProcessed: normalizationResults.size,
      errors: errors.map((e) => ({ pageId: e.phase, message: e.message })),
      metrics: { durationMs: Date.now() - startTime },
    };

    if (options.outputDir && configSnapshot) {
      await saveRunFailureOutputs({
        runId,
        outputDir: options.outputDir,
        runDir,
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        scanConfig:
          scanConfig ??
          ({
            projectId: options.projectId,
            pages: [],
            targetDpi: options.targetDpi ?? 300,
            targetDimensionsMm: options.targetDimensionsMm ?? { width: 210, height: 297 },
          } as PipelineRunConfig),
        analysisSummary:
          analysisSummary ??
          ({
            projectId: options.projectId,
            pageCount: 0,
            dpi: options.targetDpi ?? 300,
            targetDimensionsMm: options.targetDimensionsMm ?? { width: 210, height: 297 },
            targetDimensionsPx: { width: 0, height: 0 },
            estimates: [],
          } as CorpusSummary),
        pipelineResult,
        reviewQueue,
        normalizationResults,
        configSnapshot,
      });
    }

    return {
      success: false,
      runId,
      projectId: options.projectId,
      pageCount: 0,
      durationMs: Date.now() - startTime,
      scanConfig: {
        projectId: options.projectId,
        pages: [],
        targetDpi: options.targetDpi ?? 300,
        targetDimensionsMm: options.targetDimensionsMm ?? { width: 210, height: 297 },
      },
      analysisSummary: {
        projectId: options.projectId,
        pageCount: 0,
        dpi: options.targetDpi ?? 300,
        targetDimensionsMm: options.targetDimensionsMm ?? { width: 210, height: 297 },
        targetDimensionsPx: { width: 0, height: 0 },
        estimates: [],
      },
      pipelineResult,
      errors,
    };
  }
}

const writeSidecars = async (
  config: PipelineRunConfig,
  analysis: CorpusSummary,
  normalization: Map<string, NormalizationResult>,
  runDir: string,
  runId: string,
  native: PipelineCoreNative | null,
  bookModel?: BookModel,
  pipelineConfig?: PipelineConfig,
  gutterByPageId?: Map<string, GutterRatio>,
  spreadMetaByPageId?: Map<string, SpreadMetadata>,
  control?: RunControl
): Promise<
  Map<string, { profile: LayoutProfile; confidence: number; elementCount: number; source: string }>
> => {
  const sidecarDir = getSidecarDir(runDir);
  await fs.mkdir(sidecarDir, { recursive: true });

  const estimatesById = new Map(analysis.estimates.map((e) => [e.pageId, e]));
  const layoutSummaries = new Map<
    string,
    { profile: LayoutProfile; confidence: number; elementCount: number; source: string }
  >();

  const outputWidth = Math.max(1, Math.round(analysis.targetDimensionsPx.width));
  const outputHeight = Math.max(1, Math.round(analysis.targetDimensionsPx.height));
  const ornamentVarianceMin = 120;

  const sidecarEntries = (
    await Promise.all(
      config.pages.map(async (page, index) => {
        await waitForControl(control);
        const estimate = estimatesById.get(page.id);
        const norm = normalization.get(page.id);
        if (!estimate || !norm) return;

        const bleedMm = norm.bleedMm;
        const trimMm = norm.trimMm;
        const assessment = inferLayoutProfile(page, index, norm, config.pages.length);
        const layoutConfidence = computeLayoutConfidence(assessment, norm);
        const deskewConfidence = Math.min(1, norm.stats.skewConfidence + 0.25);
        const maskBoxOut = mapBoxToOutput(norm.maskBox, norm.cropBox, outputWidth, outputHeight);
        const cropBoxOut: [number, number, number, number] = [
          0,
          0,
          outputWidth - 1,
          outputHeight - 1,
        ];
        const cropWidth = Math.max(1, norm.cropBox[2] - norm.cropBox[0] + 1);
        const scale = outputWidth / cropWidth;
        const localElements = buildElementBoxes(
          page.id,
          outputWidth,
          outputHeight,
          maskBoxOut,
          bookModel
        );
        const remoteElements = await requestRemoteLayout(
          page.id,
          norm.normalizedPath,
          outputWidth,
          outputHeight
        );
        const nativeElements = remoteElements
          ? null
          : await loadNativeLayoutElements(page.id, norm.normalizedPath, native);
        const elements = remoteElements ?? nativeElements ?? localElements;
        const layoutSource = remoteElements ? "remote" : nativeElements ? "native" : "local";
        layoutSummaries.set(page.id, {
          profile: assessment.profile,
          confidence: layoutConfidence,
          elementCount: elements.length,
          source: layoutSource,
        });

        const baselineLineCount = norm.corrections?.baseline?.textLineCount ?? 0;
        const baselineData = computeBaselineGridData(norm.corrections?.baseline, outputHeight);
        const cropHeight = Math.max(1, norm.cropBox[3] - norm.cropBox[1] + 1);
        const fallbackSpacingPx =
          baselineLineCount > 0 ? cropHeight / baselineLineCount : undefined;
        const medianSpacingPx = baselineData.spacingPx ?? fallbackSpacingPx;
        const lineStraightnessResidual = Math.abs(norm.corrections?.baseline?.residualAngle ?? 0);
        const baselineSummary = {
          medianSpacingPx,
          spacingMAD: baselineData.spacingMADPx,
          lineStraightnessResidual,
          confidence:
            norm.corrections?.baseline?.confidence ?? norm.stats.baselineConsistency ?? 0.5,
          peaksY: baselineData.peaksY,
        };
        const baselineGridGuide: BaselineGridGuide | undefined = shouldRenderBaselineGrid(
          assessment.profile,
          baselineData
        )
          ? {
              spacingPx: baselineData.spacingPx,
              offsetPx: baselineData.offsetPx,
              angleDeg: baselineData.angleDeg,
              confidence: baselineData.confidence,
              source: "auto",
            }
          : undefined;
        const spread = resolveSpreadMetadata(page.id, spreadMetaByPageId, gutterByPageId);

        const textFeatures = computeTextFeatures({
          elements,
          maskBox: maskBoxOut,
          width: outputWidth,
          height: outputHeight,
        });
        const folioBandScore = computeFolioBandScore(elements, bookModel?.folioModel, outputHeight);
        const ornamentHash = norm.normalizedPath
          ? await hashBand(norm.normalizedPath, ORNAMENT_BAND)
          : null;
        const ornamentHashes =
          ornamentHash && ornamentHash.variance >= ornamentVarianceMin ? [ornamentHash.hash] : [];
        const gutterSignature =
          spread?.gutter &&
          spread.gutter.startRatio !== undefined &&
          spread.gutter.endRatio !== undefined
            ? (spread.gutter.startRatio + spread.gutter.endRatio) / 2
            : undefined;
        const baselineSpacingRatio =
          baselineSummary.medianSpacingPx !== undefined
            ? baselineSummary.medianSpacingPx / Math.max(1, outputHeight)
            : undefined;
        const margins = {
          top: clamp01(textFeatures.contentBox[1] / Math.max(1, outputHeight)),
          right: clamp01((outputWidth - 1 - textFeatures.contentBox[2]) / Math.max(1, outputWidth)),
          bottom: clamp01(
            (outputHeight - 1 - textFeatures.contentBox[3]) / Math.max(1, outputHeight)
          ),
          left: clamp01(textFeatures.contentBox[0] / Math.max(1, outputWidth)),
        };

        const templateFeatures: PageTemplateFeatures = {
          pageId: page.id,
          pageType: assessment.profile,
          margins,
          columnCount: textFeatures.columnCount,
          columnValleyRatio: textFeatures.columnValleyRatio,
          headBandRatio: textFeatures.headBandRatio,
          footerBandRatio: textFeatures.footerBandRatio,
          folioBandScore,
          ornamentHashes,
          textDensity: textFeatures.textDensity,
          whitespaceRatio: textFeatures.whitespaceRatio,
          baselineConsistency: norm.stats.baselineConsistency,
          baselineSpacingPx: baselineSummary.medianSpacingPx,
          baselineSpacingRatio,
          gutterSignature,
        };

        return {
          page,
          norm,
          assessment,
          layoutConfidence,
          deskewConfidence,
          outputWidth,
          outputHeight,
          maskBoxOut,
          cropBoxOut,
          scale,
          bleedMm,
          trimMm,
          elements,
          baselineSummary,
          baselineGridGuide,
          spread,
          templateFeatures,
        };
      })
    )
  ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const templateConfig = pipelineConfig?.templates?.clustering ?? {
    min_pages: 6,
    min_similarity: 0.7,
    max_clusters: 12,
  };
  const templatesEnabled = pipelineConfig?.templates?.enabled ?? false;
  const templateResult = templatesEnabled
    ? clusterPageTemplates(
        sidecarEntries.map((entry) => entry.templateFeatures),
        templateConfig
      )
    : { templates: [], assignments: [] };
  const assignmentByPageId = new Map(
    templateResult.assignments.map((assignment) => [assignment.pageId, assignment])
  );
  const enrichedBookModel =
    templateResult.templates.length > 0
      ? { ...(bookModel ?? {}), pageTemplates: templateResult.templates }
      : bookModel;

  await Promise.all(
    sidecarEntries.map(async (entry) => {
      const assignment = assignmentByPageId.get(entry.page.id);
      const sidecar = {
        version: "1.0.0",
        pageId: entry.page.id,
        pageType: entry.assessment.profile,
        templateId: assignment?.templateId,
        templateConfidence: assignment?.confidence,
        source: {
          path: entry.page.originalPath,
          checksum: entry.page.checksum ?? "",
        },
        spread: entry.spread,
        dimensions: {
          width: entry.norm.dimensionsMm.width,
          height: entry.norm.dimensionsMm.height,
          unit: "mm",
        },
        dpi: Math.round(entry.norm.dpi),
        normalization: {
          cropBox: entry.cropBoxOut,
          pageMask: entry.maskBoxOut,
          dpiSource: entry.norm.dpiSource,
          bleed: entry.bleedMm,
          trim: entry.trimMm,
          scale: entry.scale,
          skewAngle: entry.norm.skewAngle,
          warp: { method: "affine", residual: 0 },
          shadow: entry.norm.shadow,
          shading: entry.norm.shading
            ? {
                method: entry.norm.shading.method,
                backgroundModel: entry.norm.shading.backgroundModel,
                spineShadowModel: entry.norm.shading.spineShadowModel,
                params: entry.norm.shading.params,
                confidence: entry.norm.shading.confidence,
              }
            : undefined,
          guides: entry.baselineGridGuide ? { baselineGrid: entry.baselineGridGuide } : undefined,
        },
        elements: entry.elements,
        overrides: {},
        metrics: {
          processingMs: (analysis as unknown as { processingMs?: number }).processingMs ?? 0,
          deskewConfidence: entry.deskewConfidence,
          shadowScore: entry.norm.stats.shadowScore,
          maskCoverage: entry.norm.stats.maskCoverage,
          backgroundStd: entry.norm.stats.backgroundStd,
          backgroundMean: entry.norm.stats.backgroundMean,
          illuminationResidual: entry.norm.stats.illuminationResidual,
          spineShadowScore: entry.norm.stats.spineShadowScore,
          layoutScore: entry.layoutConfidence,
          baseline: entry.baselineSummary,
        },
        bookModel: enrichedBookModel,
      };

      const outPath = getRunSidecarPath(runDir, entry.page.id);
      try {
        await writeJsonAtomic(outPath, sidecar);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[${runId}] Failed to write sidecar for ${entry.page.id}: ${message}`);
      }
    })
  );
  return layoutSummaries;
};

const analyzeDimensions = (
  estimates: CorpusSummary["estimates"],
  pageCount: number
): {
  observations: string[];
  recommendations: string[];
  metrics: Record<string, number>;
} => {
  if (estimates.length === 0) {
    return { observations: [], recommendations: [], metrics: {} };
  }

  const widths = estimates.map((e) => e.widthPx);
  const heights = estimates.map((e) => e.heightPx);
  const avgWidth = widths.reduce((a, b) => a + b, 0) / Math.max(1, widths.length);
  const avgHeight = heights.reduce((a, b) => a + b, 0) / Math.max(1, heights.length);
  const minWidth = Math.min(...widths);
  const maxWidth = Math.max(...widths);
  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);

  const observations = [
    `Scanned ${pageCount} pages, analyzed ${estimates.length} bounds`,
    `Average page dimensions: ${Math.round(avgWidth)} x ${Math.round(avgHeight)} px`,
    `Width range: ${minWidth} - ${maxWidth} px`,
    `Height range: ${minHeight} - ${maxHeight} px`,
  ];

  const widthStdDev =
    Math.sqrt(widths.reduce((sum, w) => sum + Math.pow(w - avgWidth, 2), 0) / widths.length) /
    Math.max(1, avgWidth);
  const heightStdDev =
    Math.sqrt(heights.reduce((sum, h) => sum + Math.pow(h - avgHeight, 2), 0) / heights.length) /
    Math.max(1, avgHeight);

  const recommendations = [] as string[];
  if (widthStdDev > 0.1 || heightStdDev > 0.1) {
    recommendations.push(
      `High page dimension variance detected (${(widthStdDev * 100).toFixed(1)}% width, ${(heightStdDev * 100).toFixed(1)}% height)`
    );
  }

  const metrics = {
    widthVariance: widthStdDev,
    heightVariance: heightStdDev,
  } as Record<string, number>;

  const bleeds = estimates.map((e) => e.bleedPx);
  const trims = estimates.map((e) => e.trimPx);
  const avgBleed = bleeds.reduce((a, b) => a + b, 0) / Math.max(1, bleeds.length);
  const avgTrim = trims.reduce((a, b) => a + b, 0) / Math.max(1, trims.length);
  observations.push(
    `Average bleed: ${avgBleed.toFixed(1)} px, average trim: ${avgTrim.toFixed(1)} px`
  );

  if (avgBleed === 0 || avgTrim === 0) {
    observations.push("Bleed/trim detection used fallback values");
    recommendations.push("Verify JPEG SOF markers are readable; consider improving marker parsing");
  }

  return { observations, recommendations, metrics };
};

const analyzeNormalizationMetrics = (
  normalizationMetrics:
    | {
        avgSkewDeg?: number;
        avgMaskCoverage?: number;
        shadowRate?: number;
        lowCoverageCount?: number;
        reviewQueueCount?: number;
        strictAcceptRate?: number;
        secondPassCount?: number;
      }
    | undefined
): { observations: string[]; recommendations: string[] } => {
  if (!normalizationMetrics) {
    return { observations: [], recommendations: [] };
  }

  const observations: string[] = [];
  const recommendations: string[] = [];

  if (normalizationMetrics.avgSkewDeg !== undefined) {
    observations.push(`Average residual skew: ${normalizationMetrics.avgSkewDeg.toFixed(2)}°`);
  }
  if (normalizationMetrics.avgMaskCoverage !== undefined) {
    observations.push(
      `Average mask coverage: ${(normalizationMetrics.avgMaskCoverage * 100).toFixed(1)}%`
    );
  }
  if (normalizationMetrics.shadowRate !== undefined) {
    observations.push(
      `Shadow detection rate: ${(normalizationMetrics.shadowRate * 100).toFixed(1)}%`
    );
  }
  if ((normalizationMetrics.lowCoverageCount ?? 0) > 0) {
    recommendations.push(
      `${normalizationMetrics.lowCoverageCount} pages have low mask coverage (<50%); review crop padding or thresholding`
    );
  }
  if ((normalizationMetrics.shadowRate ?? 0) > 0.15) {
    recommendations.push(
      "Spine/edge shadows frequent; increase edge margin or shadow compensation"
    );
  }
  if ((normalizationMetrics.avgMaskCoverage ?? 1) < 0.7) {
    recommendations.push("Tight crops detected; increase padding or relax mask threshold");
  }
  if ((normalizationMetrics.reviewQueueCount ?? 0) > 0) {
    observations.push(`Review queue size: ${normalizationMetrics.reviewQueueCount}`);
  }
  if ((normalizationMetrics.strictAcceptRate ?? 1) < 0.75) {
    recommendations.push(
      "Strict acceptance rate below 75%; refine priors or add a targeted correction pass"
    );
  }
  if ((normalizationMetrics.secondPassCount ?? 0) > 0) {
    observations.push(`Second-pass corrections applied: ${normalizationMetrics.secondPassCount}`);
  }

  return { observations, recommendations };
};

/**
 * Evaluate pipeline results and recommend improvements.
 */
export function evaluateResults(result: PipelineRunnerResult): {
  success: boolean;
  metrics: Record<string, unknown>;
  observations: string[];
  recommendations: string[];
} {
  const observations: string[] = [];
  const recommendations: string[] = [];

  if (!result.success) {
    observations.push(`Pipeline failed with ${result.errors.length} error(s)`);
    result.errors.forEach((e) => {
      recommendations.push(`[${e.phase}] ${e.message}`);
    });
    return { success: false, metrics: {}, observations, recommendations };
  }

  // Metrics
  const metrics: Record<string, unknown> = {
    totalPages: result.pageCount,
    durationMs: result.durationMs,
    throughputPagesPerSecond: (result.pageCount / result.durationMs) * 1000,
    avgTimePerPageMs: result.durationMs / Math.max(1, result.pageCount),
    normalization: (result.pipelineResult.metrics as { normalization?: unknown }).normalization,
  };

  // Page bounds analysis
  const dimensionInsights = analyzeDimensions(result.analysisSummary.estimates, result.pageCount);
  observations.push(...dimensionInsights.observations);
  recommendations.push(...dimensionInsights.recommendations);
  Object.assign(metrics, dimensionInsights.metrics);

  const targetObservations = [
    `Target DPI: ${result.analysisSummary.dpi}`,
    `Target dimensions: ${result.analysisSummary.targetDimensionsMm.width}mm x ${result.analysisSummary.targetDimensionsMm.height}mm`,
  ];
  observations.push(...targetObservations);

  const normalizationMetrics = (
    result.pipelineResult.metrics as { normalization?: Record<string, number> }
  ).normalization;
  const normalizationInsights = analyzeNormalizationMetrics(
    normalizationMetrics as {
      avgSkewDeg?: number;
      avgMaskCoverage?: number;
      shadowRate?: number;
      lowCoverageCount?: number;
      secondPassCount?: number;
    }
  );
  observations.push(...normalizationInsights.observations);
  recommendations.push(...normalizationInsights.recommendations);

  // General recommendations
  const generalRecommendations: string[] = [];
  if (result.pageCount > 100) {
    generalRecommendations.push("Consider batch processing for large corpora (100+ pages)");
  }

  if (result.analysisSummary.estimates.some((e) => e.pageBounds[2] === 0)) {
    generalRecommendations.push("Some pages have zero content bounds; review detection logic");
  }

  generalRecommendations.push(
    "Integrate Rust pipeline-core for advanced dewarp and detection outputs",
    "Implement parallel processing for page analysis and normalization"
  );
  recommendations.push(...generalRecommendations);

  return {
    success: true,
    metrics,
    observations,
    recommendations,
  };
}
