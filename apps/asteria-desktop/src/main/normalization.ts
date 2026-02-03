import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BookModel, CorpusSummary, PageBoundsEstimate, PageData } from "../ipc/contracts.js";
import { getPipelineCoreNative, type PipelineCoreNative } from "./pipeline-core-native.js";
import { getNormalizedDir, getPreviewDir } from "./run-paths.js";

const MAX_PREVIEW_DIM = 1600;
const DEFAULT_PADDING_PX = 12;
const BORDER_SAMPLE_RATIO = 0.05;
const EDGE_THRESHOLD_SCALE = 1.15;
const MAX_SKEW_DEGREES = 8;
const COMMON_SIZES_MM = [
  { name: "A4", width: 210, height: 297 },
  { name: "Letter", width: 216, height: 279 },
  { name: "B5", width: 176, height: 250 },
  { name: "A5", width: 148, height: 210 },
  { name: "A3", width: 297, height: 420 },
];

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const getNativeCore = (): PipelineCoreNative | null => getPipelineCoreNative();

const computeRowSums = (preview: PreviewImage): number[] => {
  const { data, width, height } = preview;
  const native = getNativeCore();
  if (native) {
    const sums = native.projectionProfileY(Buffer.from(data), width, height);
    if (sums.length === height) {
      const maxRow = width * 255;
      return sums.map((sum) => maxRow - sum);
    }
  }

  const rowSums = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      sum += 255 - v;
    }
    rowSums[y] = sum;
  }
  return rowSums;
};

const computeColSums = (preview: PreviewImage): number[] => {
  const { data, width, height } = preview;
  const native = getNativeCore();
  if (native) {
    const sums = native.projectionProfileX(Buffer.from(data), width, height);
    if (sums.length === width) {
      const maxCol = height * 255;
      return sums.map((sum) => maxCol - sum);
    }
  }

  const colSums = new Array<number>(width).fill(0);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      const v = data[y * width + x];
      sum += 255 - v;
    }
    colSums[x] = sum;
  }
  return colSums;
};

interface PreviewImage {
  data: Uint8Array;
  width: number;
  height: number;
  scale: number;
}

interface ShadowDetection {
  present: boolean;
  side: "left" | "right" | "top" | "bottom" | "none";
  widthPx: number;
  confidence: number;
  darkness: number;
}

interface ShadingModel {
  method: string;
  backgroundModel: string;
  spineShadowModel: string;
  params: Record<string, number>;
  confidence: number;
  spineShadowScore: number;
  borderMean: number;
  borderStd: number;
  residual?: number;
  applied: boolean;
}

type ShadingEstimate = {
  shadow: ShadowDetection;
  spineShadowScore: number;
  confidence: number;
  field: { data: Float32Array; width: number; height: number; mean: number; std: number };
};

export interface NormalizationPriors {
  targetAspectRatio: number;
  medianBleedPx: number;
  medianTrimPx: number;
  adaptivePaddingPx: number;
  edgeThresholdScale: number;
  intensityThresholdBias: number;
  shadowTrimScale: number;
  maxAspectRatioDrift: number;
}

export interface NormalizationOptions {
  priors?: NormalizationPriors;
  generatePreviews?: boolean;
  skewRefinement?: "off" | "on" | "forced";
  shading?: {
    enabled?: boolean;
    maxResidualIncrease?: number;
    maxHighlightShift?: number;
    confidenceFloor?: number;
  };
  confidenceGate?: {
    deskewMin?: number;
    shadingMin?: number;
  };
  bookPriors?: {
    model?: BookModel;
    maxTrimDriftPx?: number;
    maxContentDriftPx?: number;
    minConfidence?: number;
  };
}

interface MorphologyPlan {
  denoise: boolean;
  contrastBoost: boolean;
  sharpen: boolean;
  reason: string[];
}

interface AlignmentResult {
  box: [number, number, number, number];
  drift: number;
  applied: boolean;
  reason?: string;
}

interface BookSnapResult {
  applied: boolean;
  drift: number;
  reason?: string;
}

interface BaselineMetrics {
  residualAngle: number;
  lineConsistency: number;
  textLineCount: number;
  peaksY: number[];
  spacingNorm?: number;
  spacingMADNorm?: number;
  offsetNorm?: number;
  angleDeg?: number;
  confidence?: number;
  peakSharpness?: number;
}

interface ColumnMetrics {
  columnCount: number;
  columnSeparation: number;
}

export interface NormalizationResult {
  pageId: string;
  normalizedPath: string;
  cropBox: [number, number, number, number];
  maskBox: [number, number, number, number];
  dimensionsMm: { width: number; height: number };
  dpi: number;
  dpiSource: "metadata" | "inferred" | "fallback";
  trimMm: number;
  bleedMm: number;
  skewAngle: number;
  shadow: ShadowDetection;
  previews?: {
    source?: { path: string; width: number; height: number };
    normalized?: { path: string; width: number; height: number };
  };
  corrections?: {
    deskewAngle: number;
    skewResidualAngle?: number;
    skewRefined?: boolean;
    edgeFallbackApplied?: boolean;
    edgeAnchorApplied?: boolean;
    baseline?: BaselineMetrics;
    columns?: ColumnMetrics;
    alignment?: AlignmentResult;
    bookSnap?: BookSnapResult;
    morphology?: MorphologyPlan;
    deskewApplied?: boolean;
  };
  confidenceGate?: {
    passed: boolean;
    reasons: string[];
  };
  stats: {
    backgroundMean: number;
    backgroundStd: number;
    maskCoverage: number;
    skewConfidence: number;
    shadowScore: number;
    baselineConsistency?: number;
    columnCount?: number;
    illuminationResidual?: number;
    spineShadowScore?: number;
  };
  shading?: ShadingModel;
}

const pxToMm = (px: number, dpi: number): number => (px / dpi) * 25.4;
const mmToInches = (mm: number): number => mm / 25.4;

type PhysicalSizeResult = {
  widthMm: number;
  heightMm: number;
  dpi: number;
  source: NormalizationResult["dpiSource"];
};

const buildPhysicalSizeResult = (
  widthMm: number,
  heightMm: number,
  dpi: number,
  source: NormalizationResult["dpiSource"]
): PhysicalSizeResult => ({
  widthMm,
  heightMm,
  dpi,
  source,
});

const resolveDensityPhysicalSize = (
  widthPx: number,
  heightPx: number,
  density: number | undefined,
  targetAspect: number | undefined,
  ratio: number
): PhysicalSizeResult | null => {
  if (!density || density <= 1) return null;
  if (targetAspect) {
    const drift = Math.abs(ratio - targetAspect) / Math.max(0.01, targetAspect);
    if (drift >= 0.05) return null;
  }
  return buildPhysicalSizeResult(
    pxToMm(widthPx, density),
    pxToMm(heightPx, density),
    density,
    "metadata"
  );
};

const resolveTargetPhysicalSize = (
  targetDimensionsMm: { width: number; height: number } | undefined,
  targetDpi: number | undefined,
  targetAspect: number | undefined,
  ratio: number
): PhysicalSizeResult | null => {
  if (!targetDimensionsMm || !targetDpi) return null;
  const drift = targetAspect ? Math.abs(ratio - targetAspect) / Math.max(0.01, targetAspect) : 0;
  return buildPhysicalSizeResult(
    targetDimensionsMm.width,
    targetDimensionsMm.height,
    targetDpi,
    drift < 0.05 ? "inferred" : "fallback"
  );
};

const inferCommonPhysicalSize = (
  ratio: number,
  widthPx: number,
  fallbackDpi: number
): PhysicalSizeResult | null => {
  let best = { score: Number.POSITIVE_INFINITY, widthMm: 0, heightMm: 0, dpi: fallbackDpi };

  for (const size of COMMON_SIZES_MM) {
    const variants: Array<{ width: number; height: number }> = [
      { width: size.width, height: size.height },
      { width: size.height, height: size.width },
    ];
    for (const variant of variants) {
      const sizeRatio = variant.width / variant.height;
      const score = Math.abs(sizeRatio - ratio);
      if (score < best.score) {
        best = {
          score,
          widthMm: variant.width,
          heightMm: variant.height,
          dpi: widthPx / mmToInches(variant.width),
        };
      }
    }
  }

  if (best.score < 0.02) {
    return buildPhysicalSizeResult(best.widthMm, best.heightMm, best.dpi, "inferred");
  }
  return null;
};

const inferPhysicalSize = (
  widthPx: number,
  heightPx: number,
  density?: number,
  fallbackDpi = 300,
  targetDimensionsMm?: { width: number; height: number },
  targetDpi?: number
): PhysicalSizeResult => {
  const ratio = widthPx / Math.max(1, heightPx);
  const targetAspect = targetDimensionsMm
    ? targetDimensionsMm.width / Math.max(1, targetDimensionsMm.height)
    : undefined;
  const densityResult = resolveDensityPhysicalSize(widthPx, heightPx, density, targetAspect, ratio);
  if (densityResult) return densityResult;

  const targetResult = resolveTargetPhysicalSize(
    targetDimensionsMm,
    targetDpi,
    targetAspect,
    ratio
  );
  if (targetResult) return targetResult;

  const commonSize = inferCommonPhysicalSize(ratio, widthPx, fallbackDpi);
  if (commonSize) return commonSize;

  return buildPhysicalSizeResult(
    pxToMm(widthPx, fallbackDpi),
    pxToMm(heightPx, fallbackDpi),
    fallbackDpi,
    "fallback"
  );
};

const angleToBucket = (angle: number): number => {
  let normalized = angle;
  if (normalized > 90) normalized -= 180;
  if (normalized < -90) normalized += 180;
  return Math.max(0, Math.min(180, Math.round(normalized + 90)));
};

const gradientAt = (
  data: Uint8Array,
  width: number,
  x: number,
  y: number,
  gxKernel: number[],
  gyKernel: number[]
): { magnitude: number; angle: number } => {
  const idx = (ix: number, iy: number): number => iy * width + ix;
  let gx = 0;
  let gy = 0;
  let k = 0;
  for (let ky = -1; ky <= 1; ky++) {
    for (let kx = -1; kx <= 1; kx++) {
      const val = data[idx(x + kx, y + ky)];
      gx += gxKernel[k] * val;
      gy += gyKernel[k] * val;
      k++;
    }
  }
  return { magnitude: Math.hypot(gx, gy), angle: (Math.atan2(gy, gx) * 180) / Math.PI };
};

const computeGradientHistogram = (preview: PreviewImage): Float64Array => {
  const { data, width, height } = preview;
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [1, 2, 1, 0, 0, 0, -1, -2, -1];
  const histogram = new Float64Array(181); // -90..90 degrees

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const { magnitude, angle } = gradientAt(data, width, x, y, gxKernel, gyKernel);
      if (magnitude < 10) continue;
      const bucket = angleToBucket(angle);
      histogram[bucket] += magnitude;
    }
  }

  return histogram;
};

const loadPreview = async (imagePath: string): Promise<PreviewImage> => {
  const image = sharp(imagePath);
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(width, height, 1));
  const resized =
    scale < 1 ? image.resize(Math.round(width * scale), Math.round(height * scale)) : image;
  const { data, info } = await resized
    .ensureAlpha()
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, scale };
};

const buildPreviewFromSharp = async (image: sharp.Sharp): Promise<PreviewImage> => {
  const { data, info } = await image
    .clone()
    .ensureAlpha()
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, scale: 1 };
};

const estimateSkewAngle = (preview: PreviewImage): { angle: number; confidence: number } => {
  const native = getNativeCore();
  if (native) {
    const estimate = native.estimateSkewAngle(
      Buffer.from(preview.data),
      preview.width,
      preview.height
    );
    if (Number.isFinite(estimate.angle) && Number.isFinite(estimate.confidence)) {
      return { angle: estimate.angle, confidence: estimate.confidence };
    }
  }
  const histogram = computeGradientHistogram(preview);
  const { width, height } = preview;

  let bestBucket = 90;
  let bestVal = 0;
  histogram.forEach((val, i) => {
    if (val > bestVal) {
      bestVal = val;
      bestBucket = i;
    }
  });

  // Weighted average around the best bucket to smooth
  const window = 3;
  let num = 0;
  let den = 0;
  for (let i = Math.max(0, bestBucket - window); i <= Math.min(180, bestBucket + window); i++) {
    const w = histogram[i];
    num += (i - 90) * w;
    den += w;
  }
  const angle = den > 0 ? num / den : 0;
  const clipped = Math.max(-MAX_SKEW_DEGREES, Math.min(MAX_SKEW_DEGREES, angle));
  const confidence = Math.min(1, bestVal / (width * height * 4));
  return { angle: clipped, confidence };
};

const computeBorderStats = (preview: PreviewImage): { mean: number; std: number } => {
  const { data, width, height } = preview;
  const border = Math.max(1, Math.round(Math.min(width, height) * BORDER_SAMPLE_RATIO));
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  const sample = (x: number, y: number): void => {
    const v = data[y * width + x];
    sum += v;
    sumSq += v * v;
    count++;
  };

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < border; y++) sample(x, y);
    for (let y = height - border; y < height; y++) sample(x, y);
  }
  for (let y = border; y < height - border; y++) {
    for (let x = 0; x < border; x++) sample(x, y);
    for (let x = width - border; x < width; x++) sample(x, y);
  }

  const mean = count > 0 ? sum / count : 255;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  return { mean, std: Math.sqrt(variance) };
};

const computeEdgeDensity = (preview: PreviewImage, bounds: { x0: number; x1: number }): number => {
  const { data, width, height } = preview;
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [1, 2, 1, 0, 0, 0, -1, -2, -1];
  const threshold = computeEdgeThreshold(preview);
  let count = 0;
  let hits = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = Math.max(1, bounds.x0); x < Math.min(width - 1, bounds.x1); x++) {
      const { magnitude } = gradientAt(data, width, x, y, gxKernel, gyKernel);
      if (magnitude > threshold) hits++;
      count++;
    }
  }
  return count > 0 ? hits / count : 0;
};

const buildLowFrequencyField = (
  preview: PreviewImage,
  maxSize = 96
): { data: Float32Array; width: number; height: number; mean: number; std: number } => {
  const { data, width, height } = preview;
  const fieldWidth = Math.max(8, Math.min(maxSize, width));
  const fieldHeight = Math.max(8, Math.min(maxSize, height));
  const field = new Float32Array(fieldWidth * fieldHeight);

  const xScale = width / fieldWidth;
  const yScale = height / fieldHeight;

  let sum = 0;
  let sumSq = 0;
  for (let fy = 0; fy < fieldHeight; fy++) {
    for (let fx = 0; fx < fieldWidth; fx++) {
      const xStart = Math.floor(fx * xScale);
      const xEnd = Math.min(width, Math.floor((fx + 1) * xScale));
      const yStart = Math.floor(fy * yScale);
      const yEnd = Math.min(height, Math.floor((fy + 1) * yScale));
      let cellSum = 0;
      let cellCount = 0;
      for (let y = yStart; y < yEnd; y++) {
        const row = y * width;
        for (let x = xStart; x < xEnd; x++) {
          cellSum += data[row + x];
          cellCount++;
        }
      }
      const value = cellCount > 0 ? cellSum / cellCount : 255;
      field[fy * fieldWidth + fx] = value;
      sum += value;
      sumSq += value * value;
    }
  }

  const count = field.length;
  const mean = count > 0 ? sum / count : 255;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;

  return { data: field, width: fieldWidth, height: fieldHeight, mean, std: Math.sqrt(variance) };
};

const estimateShadingModel = (
  preview: PreviewImage,
  border: { mean: number; std: number }
): ShadingEstimate => {
  const shadow = detectShadows(preview);
  const strip = Math.max(4, Math.round(preview.width * 0.05));
  const leftStrip = { x0: 0, x1: strip };
  const rightStrip = { x0: preview.width - strip, x1: preview.width };
  const leftEdgeDensity = computeEdgeDensity(preview, leftStrip);
  const rightEdgeDensity = computeEdgeDensity(preview, rightStrip);
  const innerLeftDensity = computeEdgeDensity(preview, { x0: strip, x1: strip * 2 });
  const innerRightDensity = computeEdgeDensity(preview, {
    x0: preview.width - strip * 2,
    x1: preview.width - strip,
  });

  const shadowEdgeDensity = shadow.side === "left" ? leftEdgeDensity : rightEdgeDensity;
  const innerEdgeDensity = shadow.side === "left" ? innerLeftDensity : innerRightDensity;
  const edgeContinuity = 1 - Math.min(1, Math.abs(innerEdgeDensity - shadowEdgeDensity) * 2.5);
  const spineShadowScore = clamp01(
    (shadow.darkness / 50) * (1 - shadowEdgeDensity) * (innerEdgeDensity + 0.1) * edgeContinuity
  );

  const illuminationVarianceScore = clamp01((border.std - 6) / 18);
  const confidence = clamp01(
    shadow.confidence * 0.35 +
      spineShadowScore * 0.3 +
      illuminationVarianceScore * 0.35 +
      (border.std < 10 ? 0.05 : 0)
  );
  const field = buildLowFrequencyField(preview);

  return {
    shadow,
    spineShadowScore,
    confidence,
    field,
  };
};

const applyShadingToPreview = (
  preview: PreviewImage,
  field: { data: Float32Array; width: number; height: number },
  targetMean: number,
  maxShift: number
): PreviewImage => {
  const { data, width, height } = preview;
  const corrected = new Uint8Array(data.length);
  const xScale = field.width / width;
  const yScale = field.height / height;

  for (let y = 0; y < height; y++) {
    const fy = Math.min(field.height - 1, Math.floor(y * yScale));
    for (let x = 0; x < width; x++) {
      const fx = Math.min(field.width - 1, Math.floor(x * xScale));
      const bg = field.data[fy * field.width + fx];
      const gain = Math.min(1 + maxShift, Math.max(1 - maxShift, targetMean / Math.max(1, bg)));
      const idx = y * width + x;
      const v = data[idx] / 255;
      const vLin = v * v;
      const correctedLin = Math.min(1, Math.max(0, vLin * gain));
      corrected[idx] = Math.round(Math.sqrt(correctedLin) * 255);
    }
  }

  return { data: corrected, width, height, scale: preview.scale };
};

const applyShadingCorrection = async (
  image: sharp.Sharp,
  preview: PreviewImage,
  border: { mean: number; std: number },
  options: Required<NonNullable<NormalizationOptions["shading"]>>
): Promise<{ corrected: sharp.Sharp; model: ShadingModel } | null> => {
  const shading = estimateShadingModel(preview, border);
  const method = "border-regression";
  const backgroundModel = "lowpass-field";
  const spineShadowModel = "edge-aware-band";

  const model: ShadingModel = {
    method,
    backgroundModel,
    spineShadowModel,
    params: {
      fieldWidth: shading.field.width,
      fieldHeight: shading.field.height,
    },
    confidence: shading.confidence,
    spineShadowScore: shading.spineShadowScore,
    borderMean: border.mean,
    borderStd: border.std,
    residual: undefined,
    applied: false,
  };

  if (!options.enabled) {
    return { corrected: image, model };
  }

  const correctedPreview = applyShadingToPreview(
    preview,
    shading.field,
    border.mean,
    options.maxHighlightShift
  );
  const correctedStats = computeBorderStats(correctedPreview);
  const residual = border.std > 0 ? correctedStats.std / border.std : 1;
  model.residual = residual;

  if (shading.confidence < options.confidenceFloor) {
    return { corrected: image, model };
  }

  if (residual > 1 + options.maxResidualIncrease) {
    return { corrected: image, model };
  }

  const { data, info } = await image
    .clone()
    .ensureAlpha()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buffer = Buffer.from(data);
  const channels = info.channels ?? 3;
  const xScale = shading.field.width / info.width;
  const yScale = shading.field.height / info.height;
  const maxShift = options.maxHighlightShift;

  for (let y = 0; y < info.height; y++) {
    const fy = Math.min(shading.field.height - 1, Math.floor(y * yScale));
    for (let x = 0; x < info.width; x++) {
      const fx = Math.min(shading.field.width - 1, Math.floor(x * xScale));
      const bg = shading.field.data[fy * shading.field.width + fx];
      const gain = Math.min(1 + maxShift, Math.max(1 - maxShift, border.mean / Math.max(1, bg)));
      const idx = (y * info.width + x) * channels;
      for (let c = 0; c < Math.min(3, channels); c++) {
        const v = buffer[idx + c] / 255;
        const vLin = v * v;
        const correctedLin = Math.min(1, Math.max(0, vLin * gain));
        buffer[idx + c] = Math.round(Math.sqrt(correctedLin) * 255);
      }
    }
  }

  model.applied = true;
  return {
    corrected: sharp(buffer, { raw: { width: info.width, height: info.height, channels } }),
    model,
  };
};

const computeMaskBox = (
  preview: PreviewImage,
  intensityThreshold: number
): { box: [number, number, number, number]; coverage: number } => {
  const { data, width, height } = preview;
  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      if (v < intensityThreshold) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }

  const rowLimit = Math.max(2, Math.floor(width * 0.008));
  const colLimit = Math.max(2, Math.floor(height * 0.008));
  let top = 0;
  while (top < height && rowCounts[top] < rowLimit) top++;
  let bottom = height - 1;
  while (bottom > top && rowCounts[bottom] < rowLimit) bottom--;
  let left = 0;
  while (left < width && colCounts[left] < colLimit) left++;
  let right = width - 1;
  while (right > left && colCounts[right] < colLimit) right--;

  const maskArea = (bottom - top + 1) * (right - left + 1);
  const coverage = Math.max(0, maskArea) / (width * height);
  return { box: [left, top, right, bottom], coverage };
};

const computeEdgeBox = (
  preview: PreviewImage,
  threshold: number
): [number, number, number, number] => {
  const { data, width, height } = preview;
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [1, 2, 1, 0, 0, 0, -1, -2, -1];
  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const { magnitude } = gradientAt(data, width, x, y, gxKernel, gyKernel);
      if (magnitude > threshold) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }

  const rowLimit = Math.max(2, Math.floor(width * 0.004));
  const colLimit = Math.max(2, Math.floor(height * 0.004));
  let top = 0;
  while (top < height && rowCounts[top] < rowLimit) top++;
  let bottom = height - 1;
  while (bottom > top && rowCounts[bottom] < rowLimit) bottom--;
  let left = 0;
  while (left < width && colCounts[left] < colLimit) left++;
  let right = width - 1;
  while (right > left && colCounts[right] < colLimit) right--;

  return [left, top, right, bottom];
};

const computeMagnitudeStats = (
  width: number,
  height: number,
  sampleMagnitude: (x: number, y: number, rowOffset: number) => number
): { mean: number; std: number } => {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 2) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x += 2) {
      const magnitude = sampleMagnitude(x, y, rowOffset);
      sum += magnitude;
      sumSq += magnitude * magnitude;
      count++;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  return { mean, std: Math.sqrt(variance) };
};

const computeEdgeThreshold = (preview: PreviewImage): number => {
  const { data, width, height } = preview;
  const native = getNativeCore();
  if (native) {
    const magnitudes = native.sobelMagnitude(Buffer.from(data), width, height);
    if (magnitudes.length === width * height) {
      const { mean, std } = computeMagnitudeStats(width, height, (x, _y, rowOffset) => {
        return magnitudes[rowOffset + x] ?? 0;
      });
      return Math.max(8, mean + std * EDGE_THRESHOLD_SCALE);
    }
  }
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [1, 2, 1, 0, 0, 0, -1, -2, -1];
  const { mean, std } = computeMagnitudeStats(width, height, (x, y) => {
    return gradientAt(data, width, x, y, gxKernel, gyKernel).magnitude;
  });
  return Math.max(8, mean + std * EDGE_THRESHOLD_SCALE);
};

const projectionStats = (values: number[]): { mean: number; std: number } => {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const computeBaselineSignal = (
  rowSums: number[],
  residualAngle: number
): {
  peaksY: number[];
  spacingNorm: number;
  spacingMADNorm: number;
  offsetNorm: number;
  angleDeg: number;
  confidence: number;
  peakSharpness: number;
  textLineCount: number;
  lineConsistency: number;
} => {
  const { mean, std } = projectionStats(rowSums);
  const consistencyRaw = mean > 0 ? 1 - Math.min(1, std / (mean * 2)) : 0;
  const threshold = mean + std * 0.6;
  const peaks: number[] = [];
  const sharpnessValues: number[] = [];
  for (let y = 1; y < rowSums.length - 1; y++) {
    if (rowSums[y] > threshold && rowSums[y] > rowSums[y - 1] && rowSums[y] > rowSums[y + 1]) {
      peaks.push(y);
      const neighborAvg = 0.5 * (rowSums[y - 1] + rowSums[y + 1]);
      const sharpness = rowSums[y] - neighborAvg;
      sharpnessValues.push(std > 0 ? sharpness / std : 0);
    }
  }
  const peakSharpness = sharpnessValues.length > 0 ? median(sharpnessValues) : 0;
  const peaksY =
    rowSums.length > 1 ? peaks.map((y) => y / (rowSums.length - 1)) : new Array(peaks.length).fill(0);
  const deltas = peaksY.slice(1).map((val, idx) => val - peaksY[idx]);
  const spacingNorm = deltas.length > 0 ? median(deltas) : 0;
  const spacingMADNorm =
    spacingNorm > 0 ? median(deltas.map((delta) => Math.abs(delta - spacingNorm))) : 0;
  const offsetNorm =
    spacingNorm > 0 ? median(peaksY.map((peak) => peak % spacingNorm)) : 0;
  const peakCountScore = clamp01((peaks.length - 2) / 8);
  const spacingScore = spacingNorm > 0 ? clamp01(1 - spacingMADNorm / spacingNorm) : 0;
  const sharpnessScore = clamp01(peakSharpness / 3);
  const confidence = clamp01(0.4 * spacingScore + 0.35 * sharpnessScore + 0.25 * peakCountScore);
  return {
    peaksY,
    spacingNorm,
    spacingMADNorm,
    offsetNorm,
    angleDeg: residualAngle,
    confidence,
    peakSharpness,
    textLineCount: peaks.length,
    lineConsistency: clamp01(consistencyRaw),
  };
};

const estimateBaselineMetrics = (preview: PreviewImage, residualAngle: number): BaselineMetrics => {
  const native = getNativeCore();
  if (native) {
    const metrics = native.baselineMetrics(
      Buffer.from(preview.data),
      preview.width,
      preview.height
    );
    const peaksY = metrics.peaksY ?? [];
    return {
      residualAngle: Math.abs(residualAngle),
      lineConsistency: Math.max(0, Math.min(1, metrics.lineConsistency)),
      textLineCount: metrics.textLineCount,
      peaksY,
      spacingNorm: metrics.spacingNorm,
      spacingMADNorm: metrics.spacingMadNorm,
      offsetNorm: metrics.offsetNorm,
      angleDeg: residualAngle,
      confidence: clamp01(metrics.confidence),
      peakSharpness: metrics.peakSharpness,
    };
  }
  const rowSums = computeRowSums(preview);
  const signal = computeBaselineSignal(rowSums, residualAngle);
  return {
    residualAngle: Math.abs(residualAngle),
    lineConsistency: signal.lineConsistency,
    textLineCount: signal.textLineCount,
    peaksY: signal.peaksY,
    spacingNorm: signal.spacingNorm,
    spacingMADNorm: signal.spacingMADNorm,
    offsetNorm: signal.offsetNorm,
    angleDeg: signal.angleDeg,
    confidence: signal.confidence,
    peakSharpness: signal.peakSharpness,
  };
};

const estimateColumnMetrics = (preview: PreviewImage): ColumnMetrics => {
  const native = getNativeCore();
  if (native) {
    const metrics = native.columnMetrics(Buffer.from(preview.data), preview.width, preview.height);
    return {
      columnCount: Math.max(1, Math.round(metrics.columnCount)),
      columnSeparation: metrics.columnSeparation,
    };
  }
  const colSums = computeColSums(preview);

  const { mean, std } = projectionStats(colSums);
  const threshold = mean + std * 0.7;
  let columnBands = 0;
  let inBand = false;
  for (const value of colSums) {
    if (value > threshold) {
      if (!inBand) {
        columnBands++;
        inBand = true;
      }
    } else {
      inBand = false;
    }
  }

  return {
    columnCount: Math.max(1, columnBands),
    columnSeparation: std,
  };
};

const alignCropToAspectRatio = (
  box: [number, number, number, number],
  targetAspectRatio: number,
  width: number,
  height: number,
  maxDrift: number
): AlignmentResult => {
  const currWidth = box[2] - box[0] + 1;
  const currHeight = box[3] - box[1] + 1;
  const currentAspect = currWidth / Math.max(1, currHeight);
  const drift = Math.abs(currentAspect - targetAspectRatio) / Math.max(0.01, targetAspectRatio);
  if (drift > maxDrift) {
    return { box, drift, applied: false, reason: "aspect-drift-too-high" };
  }

  let alignedBox = box;
  if (currentAspect < targetAspectRatio) {
    const desiredWidth = Math.round(currHeight * targetAspectRatio);
    const pad = Math.max(0, Math.round((desiredWidth - currWidth) / 2));
    alignedBox = clampBox([box[0] - pad, box[1], box[2] + pad, box[3]], width, height);
  } else if (currentAspect > targetAspectRatio) {
    const desiredHeight = Math.round(currWidth / targetAspectRatio);
    const pad = Math.max(0, Math.round((desiredHeight - currHeight) / 2));
    alignedBox = clampBox([box[0], box[1] - pad, box[2], box[3] + pad], width, height);
  }

  alignedBox = clampBox(alignedBox, width, height);
  return { box: alignedBox, drift, applied: true, reason: "aspect-alignment" };
};

const buildMorphologyPlan = (
  stats: { backgroundStd: number; maskCoverage: number },
  shadow: ShadowDetection
): MorphologyPlan => {
  const reasons: string[] = [];
  const denoise = stats.backgroundStd > 18 || shadow.present;
  if (denoise) reasons.push("denoise");
  const contrastBoost = stats.maskCoverage < 0.6;
  if (contrastBoost) reasons.push("contrast-boost");
  const sharpen = stats.maskCoverage > 0.7 && stats.backgroundStd < 25;
  if (sharpen) reasons.push("sharpen");
  return {
    denoise,
    contrastBoost,
    sharpen,
    reason: reasons.length > 0 ? reasons : ["none"],
  };
};

const applyMorphology = (image: sharp.Sharp, plan: MorphologyPlan): sharp.Sharp => {
  let pipeline = image;
  if (plan.denoise) {
    pipeline = pipeline.median(1);
  }
  if (plan.contrastBoost) {
    pipeline = pipeline.linear(1.05, -2);
  }
  if (plan.sharpen) {
    pipeline = pipeline.sharpen({ sigma: 0.6 });
  }
  return pipeline;
};

const writePreview = async (
  image: sharp.Sharp,
  outputPath: string
): Promise<{ path: string; width: number; height: number }> => {
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(width, height, 1));
  const resized =
    scale < 1 ? image.resize(Math.round(width * scale), Math.round(height * scale)) : image;
  const info = await resized.png({ compressionLevel: 6 }).toFile(outputPath);
  return { path: outputPath, width: info.width, height: info.height };
};

const unionBox = (
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] => {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
};

const clampBox = (
  box: [number, number, number, number],
  width: number,
  height: number
): [number, number, number, number] => {
  const left = Math.max(0, Math.min(width - 2, box[0]));
  const top = Math.max(0, Math.min(height - 2, box[1]));
  const right = Math.max(left + 1, Math.min(width - 1, box[2]));
  const bottom = Math.max(top + 1, Math.min(height - 1, box[3]));
  return [left, top, right, bottom];
};

const boxCenter = (box: [number, number, number, number]): { x: number; y: number } => ({
  x: (box[0] + box[2]) / 2,
  y: (box[1] + box[3]) / 2,
});

const shiftBox = (
  box: [number, number, number, number],
  dx: number,
  dy: number
): [number, number, number, number] => [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];

const containsBox = (
  outer: [number, number, number, number],
  inner: [number, number, number, number]
): boolean =>
  outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

const applyBookPriors = (
  expanded: [number, number, number, number],
  combined: [number, number, number, number],
  bookPriors: NormalizationOptions["bookPriors"],
  width: number,
  height: number
): { box: [number, number, number, number]; snap: BookSnapResult } => {
  const snap: BookSnapResult = { applied: false, drift: 0 };
  if (!bookPriors?.model?.trimBoxPx?.median) {
    return { box: expanded, snap };
  }

  const median = bookPriors.model.trimBoxPx.median;
  const drift = Math.max(
    Math.abs(expanded[0] - median[0]),
    Math.abs(expanded[1] - median[1]),
    Math.abs(expanded[2] - median[2]),
    Math.abs(expanded[3] - median[3])
  );
  const maxDrift = bookPriors.maxTrimDriftPx ?? 18;
  if (drift > maxDrift) {
    return { box: expanded, snap };
  }

  if (containsBox(median, combined)) {
    snap.applied = true;
    snap.drift = drift;
    snap.reason = "median-trim-box";
    return { box: clampBox(median, width, height), snap };
  }

  const centerShift = {
    dx: boxCenter(median).x - boxCenter(expanded).x,
    dy: boxCenter(median).y - boxCenter(expanded).y,
  };
  const shifted = clampBox(shiftBox(expanded, centerShift.dx, centerShift.dy), width, height);
  if (containsBox(shifted, combined)) {
    snap.applied = true;
    snap.drift = drift;
    snap.reason = "median-center-align";
    return { box: shifted, snap };
  }

  return { box: expanded, snap };
};

const roundBox = (box: [number, number, number, number]): [number, number, number, number] => {
  return [Math.round(box[0]), Math.round(box[1]), Math.round(box[2]), Math.round(box[3])];
};

const detectShadows = (preview: PreviewImage): ShadowDetection => {
  const { data, width, height } = preview;
  const stripSize = Math.max(4, Math.round(width * 0.04));
  const idx = (x: number, y: number): number => y * width + x;

  const columnMean = (xStart: number, xEnd: number): number => {
    let sum = 0;
    let count = 0;
    for (let x = xStart; x < xEnd; x++) {
      for (let y = 0; y < height; y++) {
        sum += data[idx(x, y)];
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  };

  const globalMean = columnMean(0, width);
  const leftMean = columnMean(0, stripSize);
  const rightMean = columnMean(width - stripSize, width);

  const leftDelta = globalMean - leftMean;
  const rightDelta = globalMean - rightMean;
  const darkness = Math.max(leftDelta, rightDelta);
  const isLeft = leftDelta > rightDelta;
  const delta = isLeft ? leftDelta : rightDelta;
  const present = delta > Math.max(8, globalMean * 0.08);
  const confidence = Math.min(1, delta / Math.max(1, globalMean));
  let side: ShadowDetection["side"] = "none";
  if (present) {
    side = isLeft ? "left" : "right";
  }

  return {
    present,
    side,
    widthPx: present ? stripSize : 0,
    confidence,
    darkness,
  };
};

const expandBox = (
  box: [number, number, number, number],
  padding: number,
  width: number,
  height: number
): [number, number, number, number] => {
  const [x0, y0, x1, y1] = box;
  const left = Math.max(0, x0 - padding);
  const top = Math.max(0, y0 - padding);
  const right = Math.min(width - 1, x1 + padding);
  const bottom = Math.min(height - 1, y1 + padding);
  return [left, top, right, bottom];
};

export async function normalizePage(
  page: PageData,
  estimate: PageBoundsEstimate,
  analysis: CorpusSummary,
  outputDir: string,
  options?: NormalizationOptions
): Promise<NormalizationResult> {
  const priors: NormalizationPriors = options?.priors ?? {
    targetAspectRatio:
      analysis.targetDimensionsPx.width / Math.max(1, analysis.targetDimensionsPx.height),
    medianBleedPx: estimate.bleedPx,
    medianTrimPx: estimate.trimPx,
    adaptivePaddingPx: 0,
    edgeThresholdScale: 1,
    intensityThresholdBias: 0,
    shadowTrimScale: 1,
    maxAspectRatioDrift: 0.12,
  };
  const shadingOptions: Required<NonNullable<NormalizationOptions["shading"]>> = {
    enabled: true,
    maxResidualIncrease: 0.12,
    maxHighlightShift: 0.08,
    confidenceFloor: 0.55,
    ...options?.shading,
  };
  const confidenceGate = options?.confidenceGate;
  const shadingConfidenceFloor =
    confidenceGate?.shadingMin !== undefined
      ? Math.max(shadingOptions.confidenceFloor, confidenceGate.shadingMin)
      : shadingOptions.confidenceFloor;
  shadingOptions.confidenceFloor = shadingConfidenceFloor;

  const imageMeta = await sharp(page.originalPath).metadata();
  const widthPx = imageMeta.width ?? estimate.widthPx;
  const heightPx = imageMeta.height ?? estimate.heightPx;
  const density = imageMeta.density ?? undefined;
  const physical = inferPhysicalSize(
    widthPx,
    heightPx,
    density,
    analysis.dpi,
    analysis.targetDimensionsMm,
    analysis.dpi
  );

  const preview = await loadPreview(page.originalPath);
  const skew = estimateSkewAngle(preview);
  const refinementMode = options?.skewRefinement ?? "on";

  let finalAngle = skew.angle;
  let deskewApplied = true;
  let rotated = sharp(page.originalPath).rotate(finalAngle, {
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  });
  let rotatedPreview = await buildPreviewFromSharp(rotated);
  let residual = estimateSkewAngle(rotatedPreview);
  let skewRefined = false;

  if (confidenceGate?.deskewMin !== undefined && skew.confidence < confidenceGate.deskewMin) {
    finalAngle = 0;
    deskewApplied = false;
    rotated = sharp(page.originalPath);
    rotatedPreview = await buildPreviewFromSharp(rotated);
    residual = estimateSkewAngle(rotatedPreview);
  }

  const shouldRefine =
    refinementMode === "forced" ||
    (refinementMode === "on" &&
      ((residual.confidence > 0.2 && Math.abs(residual.angle) > 0.1) || skew.confidence < 0.25));

  if (shouldRefine && deskewApplied) {
    finalAngle = skew.angle + residual.angle;
    rotated = sharp(page.originalPath).rotate(finalAngle, {
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
    rotatedPreview = await buildPreviewFromSharp(rotated);
    residual = estimateSkewAngle(rotatedPreview);
    skewRefined = true;
  }

  const borderStats = computeBorderStats(rotatedPreview);
  const baselineMetrics = estimateBaselineMetrics(rotatedPreview, residual.angle);
  const columnMetrics = estimateColumnMetrics(rotatedPreview);
  const shadingResult = await applyShadingCorrection(
    rotated,
    rotatedPreview,
    borderStats,
    shadingOptions
  );
  const shadingModel = shadingResult?.model;
  const shadingCorrected = shadingResult?.corrected ?? rotated;
  const confidenceGateReasons: string[] = [];
  if (!deskewApplied) {
    confidenceGateReasons.push("deskew-low-confidence");
  }
  if (
    shadingModel &&
    !shadingModel.applied &&
    shadingModel.confidence < (confidenceGate?.shadingMin ?? shadingConfidenceFloor)
  ) {
    confidenceGateReasons.push("shading-low-confidence");
  }
  const computeBoxes = (
    bias: number,
    edgeScale: number
  ): {
    intensityThreshold: number;
    intensityMask: ReturnType<typeof computeMaskBox>;
    edgeThreshold: number;
    edgeBox: ReturnType<typeof computeEdgeBox>;
    combinedBox: ReturnType<typeof unionBox>;
  } => {
    const intensityThreshold = Math.max(
      0,
      Math.min(borderStats.mean - borderStats.std * (0.25 + bias), borderStats.mean - 3)
    );
    const intensityMask = computeMaskBox(rotatedPreview, intensityThreshold);
    const edgeThreshold = computeEdgeThreshold(rotatedPreview) * edgeScale;
    const edgeBox = computeEdgeBox(rotatedPreview, edgeThreshold);
    const combinedBox = unionBox(intensityMask.box, edgeBox);
    return { intensityThreshold, intensityMask, edgeThreshold, edgeBox, combinedBox };
  };

  let edgeFallbackApplied = false;
  let edgeAnchorApplied = false;
  let { intensityMask, combinedBox } = computeBoxes(
    priors.intensityThresholdBias,
    priors.edgeThresholdScale
  );
  const initialCoverage = intensityMask.coverage;
  const initialCombinedCoverage =
    ((combinedBox[2] - combinedBox[0] + 1) * (combinedBox[3] - combinedBox[1] + 1)) /
    (rotatedPreview.width * rotatedPreview.height);

  if (initialCoverage < 0.6 || initialCombinedCoverage < 0.45) {
    const relaxedBias = Math.max(-0.2, priors.intensityThresholdBias - 0.2);
    const relaxedEdgeScale = Math.max(0.75, priors.edgeThresholdScale * 0.85);
    const relaxed = computeBoxes(relaxedBias, relaxedEdgeScale);
    intensityMask = relaxed.intensityMask;
    combinedBox = relaxed.combinedBox;
    edgeFallbackApplied = true;
  }

  const combinedCoverage =
    ((combinedBox[2] - combinedBox[0] + 1) * (combinedBox[3] - combinedBox[1] + 1)) /
    (rotatedPreview.width * rotatedPreview.height);
  if (combinedCoverage < 0.5) {
    const edgeThreshold = computeEdgeThreshold(rotatedPreview) * 0.6;
    const edgeBox = computeEdgeBox(rotatedPreview, edgeThreshold);
    combinedBox = unionBox(combinedBox, edgeBox);
    edgeAnchorApplied = true;
  }

  const anchoredCoverage =
    ((combinedBox[2] - combinedBox[0] + 1) * (combinedBox[3] - combinedBox[1] + 1)) /
    (rotatedPreview.width * rotatedPreview.height);
  if (anchoredCoverage < 0.35) {
    combinedBox = clampBox(estimate.contentBounds, rotatedPreview.width, rotatedPreview.height);
    edgeAnchorApplied = true;
  }

  const shadow = detectShadows(rotatedPreview);
  if (shadow.present && shadow.confidence > 0.25) {
    const trimPx = Math.round(shadow.widthPx * 0.75 * priors.shadowTrimScale);
    if (shadow.side === "left") {
      combinedBox = [combinedBox[0] + trimPx, combinedBox[1], combinedBox[2], combinedBox[3]];
    }
    if (shadow.side === "right") {
      combinedBox = [combinedBox[0], combinedBox[1], combinedBox[2] - trimPx, combinedBox[3]];
    }
  }

  combinedBox = unionBox(combinedBox, roundBox(estimate.contentBounds));
  combinedBox = clampBox(combinedBox, rotatedPreview.width, rotatedPreview.height);

  const marginPad = Math.round(Math.max(estimate.bleedPx, estimate.trimPx) * 0.6);
  const autoPadding = Math.max(
    DEFAULT_PADDING_PX,
    Math.round(Math.min(rotatedPreview.width, rotatedPreview.height) * 0.004) +
      Math.round(priors.adaptivePaddingPx) +
      marginPad
  );
  let expanded = expandBox(combinedBox, autoPadding, rotatedPreview.width, rotatedPreview.height);
  const alignment = alignCropToAspectRatio(
    expanded,
    priors.targetAspectRatio,
    rotatedPreview.width,
    rotatedPreview.height,
    priors.maxAspectRatioDrift
  );
  expanded = alignment.box;
  const bookSnap = applyBookPriors(
    expanded,
    combinedBox,
    options?.bookPriors,
    rotatedPreview.width,
    rotatedPreview.height
  );
  expanded = bookSnap.box;
  const cropWidth = expanded[2] - expanded[0] + 1;
  const cropHeight = expanded[3] - expanded[1] + 1;

  const normalizedDir = getNormalizedDir(outputDir);
  await fs.mkdir(normalizedDir, { recursive: true });
  const normalizedPath = path.join(normalizedDir, `${page.id}.png`);

  const morphologyPlan = buildMorphologyPlan(
    { backgroundStd: borderStats.std, maskCoverage: intensityMask.coverage },
    shadow
  );
  const corrected = applyMorphology(shadingCorrected.clone(), morphologyPlan);

  const targetWidth = Math.round(analysis.targetDimensionsPx.width);
  const targetHeight = Math.round(analysis.targetDimensionsPx.height);
  await corrected
    .extract({ left: expanded[0], top: expanded[1], width: cropWidth, height: cropHeight })
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .withMetadata({ density: physical.dpi })
    .png({ compressionLevel: 6 })
    .toFile(normalizedPath);

  const trimMm = pxToMm(estimate.trimPx, physical.dpi);
  const bleedMm = pxToMm(estimate.bleedPx, physical.dpi);
  const maskArea = (expanded[2] - expanded[0] + 1) * (expanded[3] - expanded[1] + 1);
  const maskCoverage = Math.max(0, maskArea) / (rotatedPreview.width * rotatedPreview.height);

  const previews: NormalizationResult["previews"] = {};
  if (options?.generatePreviews) {
    const previewDir = getPreviewDir(outputDir);
    await fs.mkdir(previewDir, { recursive: true });
    const sourcePreviewPath = path.join(previewDir, `${page.id}-source.png`);
    const normalizedPreviewPath = path.join(previewDir, `${page.id}-normalized.png`);
    const sourcePreview = await writePreview(sharp(page.originalPath), sourcePreviewPath);
    const normalizedPreview = await writePreview(sharp(normalizedPath), normalizedPreviewPath);
    previews.source = sourcePreview;
    previews.normalized = normalizedPreview;
  }

  return {
    pageId: page.id,
    normalizedPath,
    cropBox: [expanded[0], expanded[1], expanded[2], expanded[3]],
    maskBox: combinedBox,
    dimensionsMm: { width: physical.widthMm, height: physical.heightMm },
    dpi: physical.dpi,
    dpiSource: physical.source,
    trimMm,
    bleedMm,
    skewAngle: finalAngle,
    shadow,
    previews,
    corrections: {
      deskewAngle: finalAngle,
      skewResidualAngle: residual.angle,
      skewRefined,
      edgeFallbackApplied,
      edgeAnchorApplied,
      baseline: baselineMetrics,
      columns: columnMetrics,
      alignment,
      bookSnap: bookSnap.snap,
      morphology: morphologyPlan,
      deskewApplied,
    },
    confidenceGate:
      confidenceGateReasons.length > 0
        ? { passed: false, reasons: confidenceGateReasons }
        : confidenceGate
          ? { passed: true, reasons: [] }
          : undefined,
    stats: {
      backgroundMean: borderStats.mean,
      backgroundStd: borderStats.std,
      maskCoverage,
      skewConfidence: Math.max(skew.confidence, residual.confidence),
      shadowScore: shadow.darkness,
      baselineConsistency: baselineMetrics.lineConsistency,
      columnCount: columnMetrics.columnCount,
      illuminationResidual: shadingModel?.residual,
      spineShadowScore: shadingModel?.spineShadowScore,
    },
    shading: shadingModel,
  };
}

export async function normalizePages(
  pages: PageData[],
  analysis: CorpusSummary,
  outputDir: string,
  options?: NormalizationOptions
): Promise<Map<string, NormalizationResult>> {
  const estimateById = new Map(analysis.estimates.map((e) => [e.pageId, e]));
  const results = new Map<string, NormalizationResult>();

  await Promise.all(
    pages.map(async (page) => {
      const estimate = estimateById.get(page.id);
      if (!estimate) return;
      const normalized = await normalizePage(page, estimate, analysis, outputDir, options);
      results.set(page.id, normalized);
    })
  );

  return results;
}
