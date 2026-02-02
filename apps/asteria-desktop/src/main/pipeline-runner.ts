/* eslint-disable no-console */
/**
 * Pipeline Runner: End-to-end execution of corpus ingestion, analysis, and processing.
 * Used for testing and evaluation of the normalization pipeline.
 */

import path from "node:path";
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
  ReviewItem,
  ReviewQueue,
  PageLayoutElement,
} from "../ipc/contracts.ts";
import { scanCorpus } from "../ipc/corpusScanner.ts";
import { analyzeCorpus, computeTargetDimensionsPx } from "../ipc/corpusAnalysis.ts";
import { deriveBookModelFromImages } from "./book-priors.ts";
import { getPipelineCoreNative, type PipelineCoreNative } from "./pipeline-core-native.ts";
import {
  normalizePage,
  type NormalizationResult,
  type NormalizationOptions,
  type NormalizationPriors,
} from "./normalization.ts";
import { requestRemoteLayout } from "./remote-inference.ts";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const safeReadJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const getAppVersion = async (): Promise<string> => {
  const cwdPackage = path.join(process.cwd(), "package.json");
  const fallbackPackage = path.resolve(__dirname, "..", "..", "package.json");
  const pkg =
    (await safeReadJson<{ version?: string }>(cwdPackage)) ??
    (await safeReadJson<{ version?: string }>(fallbackPackage));
  return pkg?.version ?? "unknown";
};

const hashConfig = (config: PipelineRunConfig): string => {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(config));
  return hash.digest("hex");
};

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

const splitSpreadPage = async (
  page: PageData,
  split: SpreadSplitResult,
  outputDir: string
): Promise<PageData[] | null> => {
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

  const splitDir = path.join(outputDir, "spreads");
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

  return [leftPage, rightPage];
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
  const verticalProfile = [0.33, 0.67, 1.0].map((ratio) =>
    Math.min(1, norm.stats.maskCoverage * (1 + (0.5 - ratio) * 0.4))
  );

  // Horizontal thirds for left/center/right density
  const horizontalProfile = [0.33, 0.67, 1.0].map((ratio) =>
    Math.min(1, norm.stats.maskCoverage * (1 + (0.5 - Math.abs(0.5 - ratio)) * 0.3))
  );

  // Detect large blank areas (low coverage with low background noise)
  const hasLargeBlankAreas = norm.stats.maskCoverage < 0.35 && norm.stats.backgroundStd < 15;

  // Estimate content alignment
  let contentAlignment: StructuralAnalysis["contentAlignment"] = "justified";
  if (norm.stats.backgroundMean > 200) contentAlignment = "left";
  else if (norm.stats.backgroundMean < 50) contentAlignment = "right";

  // Two-column detection: higher horizontal density variation
  const horizontalVariance =
    horizontalProfile.reduce((sum, val, i, arr) => {
      const mean = arr.reduce((a, b) => a + b) / arr.length;
      return sum + Math.pow(val - mean, 2);
    }, 0) / horizontalProfile.length;
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

  // Filename-based detection (highest confidence)
  if (index === 0 || name.includes("cover")) {
    return { profile: "cover", confidence: 0.95, rationale: ["cover-detected"] };
  }
  if (name.includes("title") || name.includes("frontispiece")) {
    return { profile: "title", confidence: 0.9, rationale: ["title-detected"] };
  }
  if (name.includes("toc") || name.includes("contents")) {
    return { profile: "front-matter", confidence: 0.85, rationale: ["contents-detected"] };
  }
  if (name.includes("preface") || name.includes("foreword") || name.includes("introduction")) {
    return { profile: "front-matter", confidence: 0.8, rationale: ["front-matter"] };
  }
  if (name.includes("appendix")) {
    return { profile: "appendix", confidence: 0.85, rationale: ["appendix-detected"] };
  }
  if (name.includes("index")) {
    return { profile: "index", confidence: 0.85, rationale: ["index-detected"] };
  }
  if (name.includes("glossary") || name.includes("colophon")) {
    return { profile: "back-matter", confidence: 0.8, rationale: ["back-matter"] };
  }
  if (name.includes("plate") || name.includes("illustration") || name.includes("fig")) {
    return { profile: "illustration", confidence: 0.8, rationale: ["illustration-detected"] };
  }
  if (name.includes("table")) {
    return { profile: "table", confidence: 0.75, rationale: ["table-detected"] };
  }
  if (name.includes("chapter") || name.includes("chap") || name.includes("page_001")) {
    return { profile: "chapter-opening", confidence: 0.8, rationale: ["chapter-detected"] };
  }

  // Structural analysis for intelligent categorization
  const structure = analyzePageStructure(norm, norm.maskBox);

  // Blank or near-blank pages
  if (norm.stats.maskCoverage < 0.12 && norm.stats.backgroundStd < 8) {
    return { profile: "blank", confidence: 0.9, rationale: ["low-coverage", "clean-border"] };
  }

  // Illustration-heavy pages (low text, clean margins)
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

  // Position-based front-matter (before 10% of corpus)
  if (positionRatio < 0.1 && norm.stats.maskCoverage < 0.55) {
    const frontMatterConfidence = 0.55 + positionRatio * 0.15; // Earlier = more confident
    return {
      profile: "front-matter",
      confidence: Math.min(0.75, frontMatterConfidence),
      rationale: ["early-pages", "sparse-content"],
    };
  }

  // Position-based back-matter (after 90% of corpus)
  if (positionRatio > 0.9 && norm.stats.maskCoverage < 0.55) {
    return {
      profile: "back-matter",
      confidence: 0.65,
      rationale: ["late-pages", "sparse-content"],
    };
  }

  // Body text: high coverage + aligned + multiple lines
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

  // Table/structured content: dense + organized layout
  if (norm.stats.maskCoverage > 0.45 && structure.isDoubleColumn) {
    return {
      profile: "table",
      confidence: 0.7,
      rationale: ["multi-column", "structured-layout"],
    };
  }

  // Default: body
  return {
    profile: "body",
    confidence: clamp01(0.45 + norm.stats.maskCoverage * 0.3),
    rationale: ["default-assumption"],
  };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

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

const normalizePagesConcurrent = async (
  pages: PageData[],
  analysis: CorpusSummary,
  outputDir: string,
  options: NormalizationOptions,
  concurrency: number,
  onError: (pageId: string, message: string) => void
): Promise<Map<string, NormalizationResult>> => {
  const results = new Map<string, NormalizationResult>();
  const estimateById = new Map(analysis.estimates.map((e) => [e.pageId, e]));
  const queue = pages.slice();
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const page = queue.shift();
      if (!page) continue;
      const estimate = estimateById.get(page.id);
      if (!estimate) continue;
      try {
        const normalized = await normalizePage(page, estimate, analysis, outputDir, options);
        if (!normalized) {
          onError(page.id, "Normalization returned no result");
          continue;
        }
        results.set(page.id, normalized);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(page.id, message);
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
    estimates,
    notes: "Fallback summary generated after analysis failure.",
  };
};

const cleanupNormalizedOutput = async (outputDir: string, pages: PageData[]): Promise<void> => {
  const normalizedDir = path.join(outputDir, "normalized");
  const previewDir = path.join(outputDir, "previews");
  const manifestPath = path.join(normalizedDir, "manifest.json");

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

const resolveProjectOutputDir = (projectRoot: string): string | null => {
  const normalizedRoot = path.resolve(projectRoot);
  const base = path.basename(normalizedRoot);
  const parent = path.basename(path.dirname(normalizedRoot));
  if (base !== "raw" || parent !== "input") return null;
  const projectBase = path.resolve(normalizedRoot, "..", "..");
  return path.join(projectBase, "output", "normalized");
};

const syncNormalizedExports = async (
  outputDir: string,
  projectRoot: string,
  pages: PageData[],
  results: Map<string, NormalizationResult>
): Promise<void> => {
  const projectOutput = resolveProjectOutputDir(projectRoot);
  if (!projectOutput) return;

  await fs.mkdir(projectOutput, { recursive: true });
  const checksumById = new Map(pages.map((page) => [page.id, page.checksum ?? ""]));

  const manifestPath = path.join(projectOutput, "manifest.json");
  try {
    const existing = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(existing) as {
      pages?: Array<{ pageId: string; checksum?: string; normalizedFile?: string }>;
    };
    const currentChecksums = new Map(pages.map((page) => [page.id, page.checksum ?? ""]));
    const deletions = (manifest.pages ?? [])
      .filter((entry) => {
        const current = currentChecksums.get(entry.pageId);
        return current === undefined || current !== entry.checksum;
      })
      .map((entry) => entry.normalizedFile)
      .filter((file): file is string => Boolean(file));

    await Promise.all(
      deletions.map(async (file) => {
        try {
          await fs.unlink(path.join(projectOutput, file));
        } catch {
          // ignore
        }
      })
    );
  } catch {
    // no manifest
  }

  await Promise.all(
    Array.from(results.values()).map(async (norm) => {
      const src = norm.normalizedPath;
      const filename = `${norm.pageId}.png`;
      const dest = path.join(projectOutput, filename);
      await fs.copyFile(src, dest);
    })
  );

  const manifest = {
    runId: path.basename(outputDir),
    exportedAt: new Date().toISOString(),
    sourceRoot: projectRoot,
    count: results.size,
    pages: Array.from(results.values()).map((norm) => ({
      pageId: norm.pageId,
      checksum: checksumById.get(norm.pageId) ?? "",
      normalizedFile: `${norm.pageId}.png`,
    })),
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
};

const buildSecondPassOptions = (
  priors: NormalizationPriors,
  bookModel?: BookModel
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
    maxTrimDriftPx: 18,
    maxContentDriftPx: 24,
    minConfidence: 0.6,
  },
});

type QualityGateContext = {
  medianMaskCoverage?: number;
  bookModel?: BookModel;
  outputDimensionsPx?: { width: number; height: number };
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
  context?: QualityGateContext
): { accepted: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  if (norm.stats.maskCoverage < 0.65) reasons.push("low-mask-coverage");
  if (context?.medianMaskCoverage && norm.stats.maskCoverage < context.medianMaskCoverage * 0.7) {
    reasons.push("mask-coverage-drop");
  }
  if (norm.stats.skewConfidence < 0.35) reasons.push("low-skew-confidence");
  if (norm.stats.shadowScore > 28) reasons.push("shadow-heavy");
  if (norm.stats.backgroundStd > 32) reasons.push("noisy-background");
  if (norm.shading?.residual !== undefined && norm.shading.residual > 1.12) {
    reasons.push("shading-residual-worse");
  }
  if (norm.shading && norm.shading.confidence < 0.45) {
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
    const minCoverage = 0.6;

    (context.bookModel.runningHeadTemplates ?? []).forEach((template) => {
      if (template.confidence < 0.6) return;
      if (intersectionRatio(maskOut, template.bbox) < minCoverage) {
        reasons.push("book-head-missing");
      }
    });

    (context.bookModel.folioModel?.positionBands ?? []).forEach((band) => {
      if (band.confidence < 0.6) return;
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
      if (ornament.confidence < 0.6) return;
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
  profile: LayoutProfile
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
  if (residualAngle > 0.15) {
    flags.push(`residual-skew-${residualAngle.toFixed(2)}deg`);
  }

  // Combined check: low skew confidence + high background std = potential misalignment
  if (norm.stats.skewConfidence < 0.5 && norm.stats.backgroundStd > 20) {
    flags.push("potential-baseline-misalignment");
  }

  if ((norm.stats.baselineConsistency ?? 1) < 0.55) {
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

  const profileWeight = textHeavy ? 0.55 : visualHeavy ? 0.35 : 0.5;
  const qualityWeight = 1 - profileWeight;

  return clamp01(profileWeight * profileScore + qualityWeight * qualityScore);
};

const buildReviewQueue = (
  pages: PageData[],
  normalization: Map<string, NormalizationResult>,
  runId: string,
  projectId: string,
  context?: QualityGateContext
): ReviewQueue => {
  const items: ReviewItem[] = [];

  // Adaptive semantic threshold based on layout type distribution
  // Higher confidence required for uncertain layout types, lower for high-confidence detections
  const getSemanticThreshold = (profile: LayoutProfile): number => {
    const thresholds: Record<LayoutProfile, number> = {
      body: 0.88, // Text pages need high confidence for confirmation
      "chapter-opening": 0.85,
      title: 0.75, // Titles are easier to identify
      cover: 0.75,
      "front-matter": 0.82,
      "back-matter": 0.82,
      appendix: 0.8,
      index: 0.8,
      illustration: 0.7, // Visual pages more flexible
      table: 0.8,
      blank: 0.65, // Blank pages easy to identify
      unknown: 0.95, // Strict for unknown types
    };
    return thresholds[profile] ?? 0.82;
  };

  pages.forEach((page, index) => {
    const norm = normalization.get(page.id);
    if (!norm) return;

    const assessment = inferLayoutProfile(page, index, norm, pages.length);
    const layoutConfidence = computeLayoutConfidence(assessment, norm);
    const qualityGate = computeQualityGate(norm, context);

    // Validate baseline alignment for text pages
    const baselineValidation = validateBodyTextBaselines(norm, assessment.profile);
    if (!baselineValidation.aligned) {
      qualityGate.reasons.push(...baselineValidation.flags);
    }

    const spreadConfidence = page.confidenceScores.spreadSplit;
    if (typeof spreadConfidence === "number" && spreadConfidence < 0.7) {
      qualityGate.reasons.push("spread-split-low-confidence");
    }

    // Use adaptive threshold per layout type
    const semanticThreshold = getSemanticThreshold(assessment.profile);
    const needsSemanticConfirmation = layoutConfidence >= semanticThreshold;
    const needsReview = !qualityGate.accepted || needsSemanticConfirmation;

    if (!needsReview) return;

    const previews = [] as ReviewItem["previews"];
    if (norm.previews?.source) {
      previews.push({ kind: "source", ...norm.previews.source });
    }
    if (norm.previews?.normalized) {
      previews.push({ kind: "normalized", ...norm.previews.normalized });
    }

    items.push({
      pageId: page.id,
      filename: page.filename,
      layoutProfile: assessment.profile,
      layoutConfidence,
      qualityGate,
      reason: qualityGate.accepted ? "semantic-layout" : "quality-gate",
      previews,
      suggestedAction: qualityGate.accepted ? "confirm" : "adjust",
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

  elements.push({
    id: `${pageId}-page-bounds`,
    type: "page_bounds",
    bbox: pageBox,
    confidence: 0.6,
    source: "local",
    flags: ["derived"],
  });

  elements.push({
    id: `${pageId}-text-block`,
    type: "text_block",
    bbox: safeContent,
    confidence: 0.55,
    source: "local",
    flags: ["mask-derived"],
  });

  const titleBox = fromContent(0.12, 0.02, 0.88, 0.14);
  elements.push({
    id: `${pageId}-title`,
    type: "title",
    bbox: titleBox,
    confidence: 0.28,
    source: "local",
    flags: ["heuristic"],
  });

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
      bbox: fromContent(0.1, 0.0, 0.9, 0.08),
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

  elements.push({
    id: `${pageId}-drop-cap`,
    type: "drop_cap",
    bbox: fromContent(0.02, 0.18, 0.1, 0.32),
    confidence: 0.18,
    source: "local",
    flags: ["heuristic"],
  });

  elements.push({
    id: `${pageId}-footnote`,
    type: "footnote",
    bbox: fromContent(0.05, 0.86, 0.95, 0.98),
    confidence: 0.2,
    source: "local",
    flags: ["heuristic"],
  });

  elements.push({
    id: `${pageId}-marginalia`,
    type: "marginalia",
    bbox: fromContent(0.0, 0.25, 0.08, 0.75),
    confidence: 0.18,
    source: "local",
    flags: ["heuristic"],
  });

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
  outputDir: string,
  bookModel?: BookModel,
  gutterByPageId?: Map<string, { start: number; end: number }>
): Promise<void> => {
  const overlayDir = path.join(outputDir, "overlays");
  await fs.mkdir(overlayDir, { recursive: true });

  await Promise.all(
    reviewQueue.items.map(async (item) => {
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
          const gx0 = Math.max(0, Math.round(width * gutter.start));
          const gx1 = Math.min(width - 1, Math.round(width * gutter.end));
          overlayBoxes.push({
            box: [gx0, 0, gx1, height - 1],
            color: "#facc15",
            label: "gutter",
          });
        }

        const svg = buildOverlaySvg(width, height, overlayBoxes);
        const overlayPath = path.join(overlayDir, `${item.pageId}-overlay.png`);
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

/**
 * Execute full pipeline: scan -> analyze -> process.
 */
export async function runPipeline(options: PipelineRunnerOptions): Promise<PipelineRunnerResult> {
  const startTime = Date.now();
  const runId = `run-${Date.now()}`;
  const errors: Array<{ phase: string; message: string }> = [];

  const native = getPipelineCoreNative();
  console.log(
    `[${runId}] Native pipeline-core ${native ? "enabled" : "unavailable; using JS fallbacks"}`
  );

  try {
    // Phase 1: Scan corpus
    console.log(`[${runId}] Scanning corpus at ${options.projectRoot}...`);
    let scanConfig: PipelineRunConfig | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
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

    // Apply overrides if provided
    if (options.targetDpi) {
      scanConfig.targetDpi = options.targetDpi;
    }
    if (options.targetDimensionsMm) {
      scanConfig.targetDimensionsMm = options.targetDimensionsMm;
    }
    scanConfig.projectId = options.projectId;

    const gutterByPageId = new Map<string, { start: number; end: number }>();
    if (options.enableSpreadSplit) {
      const splitOutputDir = options.outputDir ?? path.join(process.cwd(), "pipeline-results");
      const splitPages: PageData[] = [];
      const threshold = options.spreadSplitConfidence ?? 0.7;
      for (const page of scanConfig.pages) {
        const split = await detectSpread(page);
        if (split.shouldSplit && split.confidence >= threshold) {
          const splitResult = await splitSpreadPage(page, split, splitOutputDir);
          if (splitResult) {
            splitPages.push(...splitResult);
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
              start: split.gutterStartRatio,
              end: split.gutterEndRatio,
            });
          }
        }
        splitPages.push(page);
      }
      scanConfig.pages = splitPages;
    }

    // Sample if requested
    let configToProcess = scanConfig;
    if (options.sampleCount && options.sampleCount < scanConfig.pages.length) {
      configToProcess = {
        ...scanConfig,
        pages: scanConfig.pages.slice(0, options.sampleCount),
      };
      console.log(
        `[${runId}] Sampling ${options.sampleCount} of ${scanConfig.pages.length} pages for evaluation`
      );
    }

    // Phase 2: Analyze corpus
    console.log(`[${runId}] Analyzing corpus bounds for ${configToProcess.pages.length} pages...`);
    let analysisSummary: CorpusSummary;
    try {
      analysisSummary = await analyzeCorpus(configToProcess);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ phase: "analysis", message });
      analysisSummary = buildFallbackSummary(configToProcess);
    }
    console.log(
      `[${runId}] Analysis complete: page bounds computed, ${analysisSummary.estimates.length} estimates`
    );

    // Phase 3: Normalization
    console.log(`[${runId}] Running normalization pipeline...`);
    const outputDir = options.outputDir ?? path.join(process.cwd(), "pipeline-results");
    await cleanupNormalizedOutput(outputDir, configToProcess.pages);
    const concurrency = Math.max(1, Number(process.env.ASTERIA_NORMALIZE_CONCURRENCY ?? 6));
    const priors = deriveNormalizationPriors(analysisSummary);

    let bookModel: BookModel | undefined;
    const enableBookPriors = options.enableBookPriors ?? true;
    const sampleCount = Math.min(options.bookPriorsSampleCount ?? 40, configToProcess.pages.length);
    if (enableBookPriors && sampleCount > 0) {
      const samplePages = configToProcess.pages.slice(0, sampleCount);
      const sampleDir = path.join(outputDir, "priors-sample");
      await fs.mkdir(sampleDir, { recursive: true });
      try {
        const sampleResults = await normalizePagesConcurrent(
          samplePages,
          analysisSummary,
          sampleDir,
          {
            priors,
            generatePreviews: false,
            skewRefinement: "on",
          },
          Math.max(1, Math.min(4, concurrency)),
          () => {
            // ignore sampling errors
          }
        );
        bookModel = await deriveBookModel(
          Array.from(sampleResults.values()),
          analysisSummary.targetDimensionsPx
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ phase: "book-priors", message });
      }
    }

    const normalizationOptions: NormalizationOptions = {
      priors,
      generatePreviews: true,
      skewRefinement: "on",
      bookPriors: {
        model: bookModel,
        maxTrimDriftPx: 18,
        maxContentDriftPx: 24,
        minConfidence: 0.6,
      },
    };
    const normalizationResults = await normalizePagesConcurrent(
      configToProcess.pages,
      analysisSummary,
      outputDir,
      normalizationOptions,
      concurrency,
      (pageId, message) => {
        errors.push({ phase: "normalization", message: `[${pageId}] ${message}` });
      }
    );
    console.log(`[${runId}] Normalized ${normalizationResults.size} pages`);

    const qualityContext: QualityGateContext = {
      bookModel,
      outputDimensionsPx: analysisSummary.targetDimensionsPx,
    };
    const secondPassCandidates: PageData[] = [];
    configToProcess.pages.forEach((page, index) => {
      const norm = normalizationResults.get(page.id);
      if (!norm) return;
      const assessment = inferLayoutProfile(page, index, norm, configToProcess.pages.length);
      const qualityGate = computeQualityGate(norm, qualityContext);
      const baselineValidation = validateBodyTextBaselines(norm, assessment.profile);
      if (!qualityGate.accepted || !baselineValidation.aligned) {
        secondPassCandidates.push(page);
      }
    });

    if (secondPassCandidates.length > 0) {
      console.log(
        `[${runId}] Running second-pass corrections for ${secondPassCandidates.length} pages...`
      );
      const secondPassOptions = buildSecondPassOptions(normalizationOptions.priors!, bookModel);
      const secondPassResults = await normalizePagesConcurrent(
        secondPassCandidates,
        analysisSummary,
        outputDir,
        secondPassOptions,
        Math.max(1, Math.floor(concurrency / 2)),
        (pageId, message) => {
          errors.push({ phase: "second-pass", message: `[${pageId}] ${message}` });
        }
      );
      secondPassResults.forEach((value, key) => {
        normalizationResults.set(key, value);
      });
      console.log(`[${runId}] Second-pass corrections complete`);
    }

    const normArray = Array.from(normalizationResults.values());
    const avgSkew =
      normArray.reduce((sum, n) => sum + Math.abs(n.skewAngle), 0) / Math.max(1, normArray.length);
    const avgMaskCoverage =
      normArray.reduce((sum, n) => sum + n.stats.maskCoverage, 0) / Math.max(1, normArray.length);
    const shadowRate =
      normArray.filter((n) => n.shadow.present).length / Math.max(1, normArray.length);
    const lowCoverageCount = normArray.filter((n) => n.stats.maskCoverage < 0.5).length;

    const medianMaskCoverage = median(normArray.map((n) => n.stats.maskCoverage));
    const reviewQueue = buildReviewQueue(
      configToProcess.pages,
      normalizationResults,
      runId,
      options.projectId,
      {
        ...qualityContext,
        medianMaskCoverage,
      }
    );
    await attachOverlays(reviewQueue, normalizationResults, outputDir, bookModel, gutterByPageId);
    const strictAcceptCount = normArray.filter(
      (norm) => computeQualityGate(norm, { ...qualityContext, medianMaskCoverage }).accepted
    ).length;

    const appVersion = await getAppVersion();
    const configHash = hashConfig(configToProcess);

    const pipelineResult: PipelineRunResult = {
      runId,
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
      await fs.mkdir(options.outputDir, { recursive: true });
      const reportPath = path.join(options.outputDir, `${runId}-report.json`);
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          {
            runId,
            projectId: options.projectId,
            scanConfig: {
              pageCount: scanConfig.pages.length,
              targetDpi: scanConfig.targetDpi,
              targetDimensionsMm: scanConfig.targetDimensionsMm,
            },
            analysisSummary,
            pipelineResult,
            bookModel,
            determinism: {
              appVersion,
              configHash,
              rustModuleVersion: "unknown",
              modelHashes: [],
              seed: "static",
            },
            reviewQueue,
          },
          null,
          2
        )
      );
      console.log(`[${runId}] Report saved to ${reportPath}`);

      await writeSidecars(
        configToProcess,
        analysisSummary,
        normalizationResults,
        options.outputDir,
        runId,
        native,
        bookModel
      );

      const normalizedDir = path.join(options.outputDir, "normalized");
      await fs.mkdir(normalizedDir, { recursive: true });
      const checksumById = new Map(configToProcess.pages.map((page) => [page.id, page.checksum]));
      const dhashEntries = await Promise.all(
        Array.from(normalizationResults.values()).map(async (norm) => ({
          pageId: norm.pageId,
          dhash: await computePageDhash(norm.normalizedPath, native),
        }))
      );
      const dhashById = new Map(dhashEntries.map((entry) => [entry.pageId, entry.dhash]));
      const manifest = {
        runId,
        exportedAt: new Date().toISOString(),
        sourceRoot: options.projectRoot,
        count: normalizationResults.size,
        determinism: {
          appVersion,
          configHash,
          rustModuleVersion: "unknown",
          modelHashes: [],
          seed: "static",
        },
        pages: Array.from(normalizationResults.values()).map((norm) => ({
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
        })),
      };
      await fs.writeFile(
        path.join(normalizedDir, "manifest.json"),
        JSON.stringify(manifest, null, 2)
      );

      await syncNormalizedExports(
        options.outputDir,
        options.projectRoot,
        configToProcess.pages,
        normalizationResults
      );

      const reviewPath = path.join(options.outputDir, `${runId}-review-queue.json`);
      await fs.writeFile(reviewPath, JSON.stringify(reviewQueue, null, 2));
      console.log(`[${runId}] Review queue saved to ${reviewPath}`);
    }

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
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ phase: "pipeline", message });
    console.error(`[${runId}] Pipeline failed:`, message);

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
      pipelineResult: {
        runId,
        status: "error",
        pagesProcessed: 0,
        errors: errors.map((e) => ({ pageId: e.phase, message: e.message })),
        metrics: { durationMs: Date.now() - startTime },
      },
      errors,
    };
  }
}

const writeSidecars = async (
  config: PipelineRunConfig,
  analysis: CorpusSummary,
  normalization: Map<string, NormalizationResult>,
  outputDir: string,
  runId: string,
  native: PipelineCoreNative | null,
  bookModel?: BookModel
): Promise<void> => {
  const sidecarDir = path.join(outputDir, "sidecars");
  await fs.mkdir(sidecarDir, { recursive: true });

  const estimatesById = new Map(analysis.estimates.map((e) => [e.pageId, e]));

  await Promise.all(
    config.pages.map(async (page, index) => {
      const estimate = estimatesById.get(page.id);
      const norm = normalization.get(page.id);
      if (!estimate || !norm) return;

      const bleedMm = norm.bleedMm;
      const trimMm = norm.trimMm;
      const assessment = inferLayoutProfile(page, index, norm, config.pages.length);
      const layoutConfidence = computeLayoutConfidence(assessment, norm);
      const deskewConfidence = Math.min(1, norm.stats.skewConfidence + 0.25);
      const outputWidth = Math.max(1, Math.round(analysis.targetDimensionsPx.width));
      const outputHeight = Math.max(1, Math.round(analysis.targetDimensionsPx.height));
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

      const baselineLineCount = norm.corrections?.baseline?.textLineCount ?? 0;
      const cropHeight = Math.max(1, norm.cropBox[3] - norm.cropBox[1] + 1);
      const medianSpacingPx = baselineLineCount > 0 ? cropHeight / baselineLineCount : undefined;
      const lineStraightnessResidual = Math.abs(norm.corrections?.baseline?.residualAngle ?? 0);
      const baselineSummary = {
        medianSpacingPx,
        spacingMAD: undefined,
        lineStraightnessResidual,
        confidence: norm.stats.baselineConsistency ?? 0.5,
      };

      const sidecar = {
        version: "1.0.0",
        pageId: page.id,
        source: {
          path: page.originalPath,
          checksum: page.checksum ?? "",
        },
        dimensions: {
          width: norm.dimensionsMm.width,
          height: norm.dimensionsMm.height,
          unit: "mm",
        },
        dpi: Math.round(norm.dpi),
        normalization: {
          cropBox: cropBoxOut,
          pageMask: maskBoxOut,
          dpiSource: norm.dpiSource,
          bleed: bleedMm,
          trim: trimMm,
          scale,
          skewAngle: norm.skewAngle,
          warp: { method: "affine", residual: 0 },
          shadow: norm.shadow,
          shading: norm.shading
            ? {
                method: norm.shading.method,
                backgroundModel: norm.shading.backgroundModel,
                spineShadowModel: norm.shading.spineShadowModel,
                params: norm.shading.params,
                confidence: norm.shading.confidence,
              }
            : undefined,
        },
        elements,
        metrics: {
          processingMs: (analysis as unknown as { processingMs?: number }).processingMs ?? 0,
          deskewConfidence,
          shadowScore: norm.stats.shadowScore,
          maskCoverage: norm.stats.maskCoverage,
          backgroundStd: norm.stats.backgroundStd,
          backgroundMean: norm.stats.backgroundMean,
          illuminationResidual: norm.stats.illuminationResidual,
          spineShadowScore: norm.stats.spineShadowScore,
          layoutScore: layoutConfidence,
          baseline: baselineSummary,
        },
        bookModel: bookModel,
      };

      const outPath = path.join(sidecarDir, `${page.id}.json`);
      try {
        await fs.writeFile(outPath, JSON.stringify(sidecar, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[${runId}] Failed to write sidecar for ${page.id}: ${message}`);
      }
    })
  );
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
