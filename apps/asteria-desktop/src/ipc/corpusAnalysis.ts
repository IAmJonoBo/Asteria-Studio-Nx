import fs from "node:fs/promises";
import path from "node:path";
import type { CorpusSummary, PageBoundsEstimate, PipelineRunConfig } from "./contracts";
import { validatePipelineRunConfig } from "./validation";

const MM_PER_INCH = 25.4;
const DEFAULT_BLEED_MM = 3;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const round = (value: number): number => Math.round(value * 1000) / 1000;

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
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024); // read first 64KB
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 4) return null;

    let offset = 2; // skip SOI
    while (offset + 9 < bytesRead) {
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
      if (length <= 2) break;
      offset += 2 + length;
    }
  } finally {
    await handle.close();
  }
  return null;
};

const shouldProbe = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg";
};

export const estimatePageBounds = async (
  config: PipelineRunConfig,
  options?: { dimensionProvider?: DimensionProvider; bleedMm?: number; trimMm?: number }
): Promise<{ bounds: PageBoundsEstimate[]; targetPx: { width: number; height: number } }> => {
  const { targetDimensionsMm, targetDpi, pages } = config;
  const targetPx = computeTargetDimensionsPx(targetDimensionsMm, targetDpi);
  const bleedPx = mmToPx(options?.bleedMm ?? DEFAULT_BLEED_MM, targetDpi);
  const trimPx = mmToPx(options?.trimMm ?? 0, targetDpi);
  const dimensionProvider = options?.dimensionProvider ?? probeJpegSize;

  const bounds: PageBoundsEstimate[] = [];
  for (const page of pages) {
    let baseDimensions: { width: number; height: number } | null = null;
    if (shouldProbe(page.originalPath)) {
      baseDimensions = await dimensionProvider(page.originalPath);
    }

    const pageWidth = baseDimensions?.width ?? targetPx.width;
    const pageHeight = baseDimensions?.height ?? targetPx.height;

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
  const { bounds, targetPx } = await estimatePageBounds(config);

  return {
    projectId: config.projectId,
    pageCount: config.pages.length,
    dpi: config.targetDpi,
    targetDimensionsPx: targetPx,
    estimates: bounds,
    notes:
      "Corpus analysis uses target dimensions and probed image dimensions to seed layout bounds; replace with CV outputs when ready.",
  };
};
