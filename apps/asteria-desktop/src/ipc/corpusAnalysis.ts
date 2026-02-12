import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { CorpusSummary, PageBoundsEstimate, PipelineRunConfig } from "./contracts.js";
import { validatePipelineRunConfig } from "./validation.js";

const MM_PER_INCH = 25.4;
const DEFAULT_BLEED_MM = 3;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const round = (value: number): number => Math.round(value * 1000) / 1000;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

export const mmToPx = (mm: number, dpi: number): number => round((mm / MM_PER_INCH) * dpi);

export const computeTargetDimensionsPx = (
  targetDimensionsMm: { width: number; height: number },
  dpi: number
): { width: number; height: number } => ({
  width: mmToPx(targetDimensionsMm.width, dpi),
  height: mmToPx(targetDimensionsMm.height, dpi),
});

type DimensionProvider = (filePath: string) => Promise<{ width: number; height: number } | null>;

const probeJpegSize: DimensionProvider = async (filePath) => {
  const MAX_BYTES = 2 * 1024 * 1024; // cap probe size to avoid large reads
  const data = await fs.readFile(filePath);
  const buffer = data.length > MAX_BYTES ? data.subarray(0, MAX_BYTES) : data;
  if (buffer.length < 4) return null;

  let offset = 2; // skip SOI
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    if (length <= 2) {
      offset += 1;
      continue;
    }
    offset += 2 + length;
  }
  return null;
};

const shouldProbe = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  return (
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".png" ||
    ext === ".tif" ||
    ext === ".tiff" ||
    ext === ".pdf"
  );
};

const probeImageSize: DimensionProvider = async (filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isPdf = ext === ".pdf";
    const image = isPdf ? sharp(filePath, { density: 300, page: 0 }) : sharp(filePath);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
};

const computeVariance = (values: number[]): number => {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  return variance;
};

const inferTargetMetrics = async (
  config: PipelineRunConfig,
  _dimensionProvider: DimensionProvider
): Promise<{
  inferredDimensionsMm?: { width: number; height: number };
  dimensionConfidence: number;
  inferredDpi?: number;
  dpiConfidence: number;
}> => {
  const samples = await Promise.all(
    config.pages.map(async (page) => {
      if (!shouldProbe(page.originalPath)) return null;
      try {
        const ext = path.extname(page.originalPath).toLowerCase();
        const dimensions =
          ext === ".jpg" || ext === ".jpeg"
            ? await probeJpegSize(page.originalPath)
            : await probeImageSize(page.originalPath);
        return dimensions ? { width: dimensions.width, height: dimensions.height } : null;
      } catch {
        return null;
      }
    })
  );
  const pixelSamples = samples.filter((sample): sample is { width: number; height: number } =>
    Boolean(sample)
  );
  if (pixelSamples.length === 0) {
    return {
      dimensionConfidence: 0,
      dpiConfidence: 0,
    };
  }

  const inferredWidthsMm = pixelSamples.map((sample) => (sample.width / config.targetDpi) * 25.4);
  const inferredHeightsMm = pixelSamples.map((sample) => (sample.height / config.targetDpi) * 25.4);
  const inferredDimensionsMm = {
    width: round(median(inferredWidthsMm)),
    height: round(median(inferredHeightsMm)),
  };
  const widthCv =
    Math.sqrt(computeVariance(inferredWidthsMm)) / Math.max(1, inferredDimensionsMm.width);
  const heightCv =
    Math.sqrt(computeVariance(inferredHeightsMm)) / Math.max(1, inferredDimensionsMm.height);
  const dimensionStability = 1 - clamp01((widthCv + heightCv) / 2);
  const dimensionCoverage = pixelSamples.length / Math.max(1, config.pages.length);
  const dimensionConfidence = clamp01(dimensionCoverage * dimensionStability);

  const inferredDpiSamples = pixelSamples.flatMap((sample) => [
    (sample.width / config.targetDimensionsMm.width) * 25.4,
    (sample.height / config.targetDimensionsMm.height) * 25.4,
  ]);
  const inferredDpi = round(median(inferredDpiSamples));
  const dpiCv = Math.sqrt(computeVariance(inferredDpiSamples)) / Math.max(1, inferredDpi);
  const dpiStability = 1 - clamp01(dpiCv);
  const dpiCoverage = pixelSamples.length / Math.max(1, config.pages.length);
  const dpiConfidence = clamp01(dpiCoverage * dpiStability);

  return {
    inferredDimensionsMm,
    dimensionConfidence,
    inferredDpi,
    dpiConfidence,
  };
};

export const applyDimensionInference = (
  config: PipelineRunConfig,
  summary: CorpusSummary,
  threshold: number
): PipelineRunConfig => {
  if (
    summary.dimensionConfidence !== undefined &&
    summary.inferredDimensionsMm &&
    summary.dimensionConfidence >= threshold
  ) {
    return {
      ...config,
      targetDimensionsMm: summary.inferredDimensionsMm,
    };
  }
  return config;
};

export const estimatePageBounds = async (
  config: PipelineRunConfig,
  options?: { dimensionProvider?: DimensionProvider; bleedMm?: number; trimMm?: number }
): Promise<{ bounds: PageBoundsEstimate[]; targetPx: { width: number; height: number } }> => {
  const { targetDimensionsMm, targetDpi, pages } = config;
  const targetPx = computeTargetDimensionsPx(targetDimensionsMm, targetDpi);
  const bleedPx = mmToPx(options?.bleedMm ?? DEFAULT_BLEED_MM, targetDpi);
  const trimPx = mmToPx(options?.trimMm ?? 0, targetDpi);
  const _dimensionProvider = options?.dimensionProvider ?? probeJpegSize;

  const bounds: PageBoundsEstimate[] = [];
  for (const page of pages) {
    let probedDimensions: { width: number; height: number } | null = null;
    if (shouldProbe(page.originalPath)) {
      probedDimensions = await _dimensionProvider(page.originalPath);
    }

    const pageWidth = probedDimensions?.width ?? targetPx.width;
    const pageHeight = probedDimensions?.height ?? targetPx.height;

    const pageBounds: [number, number, number, number] = [0, 0, pageWidth, pageHeight];
    const inset = bleedPx + trimPx;
    const contentBounds: [number, number, number, number] = [
      Math.max(0, inset),
      Math.max(0, inset),
      Math.max(inset, pageWidth - inset),
      Math.max(inset, pageHeight - inset),
    ];

    bounds.push({
      pageId: page.id,
      widthPx: pageWidth,
      heightPx: pageHeight,
      bleedPx,
      trimPx,
      pageBounds,
      contentBounds,
    });
  }

  return { bounds, targetPx };
};

export const analyzeCorpus = async (config: PipelineRunConfig): Promise<CorpusSummary> => {
  validatePipelineRunConfig(config);
  const inference = await inferTargetMetrics(config, probeJpegSize);
  const { bounds, targetPx } = await estimatePageBounds(config);

  return {
    projectId: config.projectId,
    pageCount: config.pages.length,
    dpi: config.targetDpi,
    targetDimensionsMm: config.targetDimensionsMm,
    targetDimensionsPx: targetPx,
    inferredDimensionsMm: inference.inferredDimensionsMm,
    inferredDpi: inference.inferredDpi,
    dimensionConfidence: inference.dimensionConfidence,
    dpiConfidence: inference.dpiConfidence,
    estimates: bounds,
    notes:
      "Corpus analysis uses target dimensions and probed image dimensions to seed layout bounds; replace with CV outputs when ready.",
  };
};
