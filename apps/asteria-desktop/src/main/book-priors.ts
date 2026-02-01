import fs from "node:fs/promises";
import sharp from "sharp";
import type {
  BookModel,
  FolioModel,
  OrnamentAnchor,
  RunningHeadTemplate,
} from "../ipc/contracts.ts";

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export type BandSpec = {
  yStartRatio: number;
  yEndRatio: number;
};

const computeDHash = (data: Uint8Array, width: number, height: number): string => {
  let bits = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = data[y * width + x];
      const right = data[y * width + x + 1];
      bits += left < right ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const chunk = bits.slice(i, i + 4);
    hex += Number.parseInt(chunk, 2).toString(16);
  }
  return hex;
};

const computeVariance = (data: Uint8Array): number => {
  if (data.length === 0) return 0;
  const mean = data.reduce((sum, v) => sum + v, 0) / data.length;
  const variance = data.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / data.length;
  return variance;
};

const hashBand = async (
  imagePath: string,
  band: BandSpec
): Promise<{ hash: string; variance: number } | null> => {
  try {
    await fs.access(imagePath);
    const meta = await sharp(imagePath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;

    const yStart = Math.round(height * band.yStartRatio);
    const yEnd = Math.round(height * band.yEndRatio);
    const bandHeight = Math.max(1, yEnd - yStart);

    const { data } = await sharp(imagePath)
      .extract({ left: 0, top: yStart, width, height: bandHeight })
      .resize(9, 8)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const bytes = new Uint8Array(data);
    return {
      hash: computeDHash(bytes, 9, 8),
      variance: computeVariance(bytes),
    };
  } catch {
    return null;
  }
};

export const deriveRunningHeadTemplates = async (
  imagePaths: string[],
  outputSize: { width: number; height: number },
  minCount = 3
): Promise<RunningHeadTemplate[]> => {
  const band = { yStartRatio: 0.02, yEndRatio: 0.14 };
  const counts = new Map<string, number>();
  for (const imagePath of imagePaths) {
    const hashed = await hashBand(imagePath, band);
    if (!hashed) continue;
    counts.set(hashed.hash, (counts.get(hashed.hash) ?? 0) + 1);
  }

  const templates: RunningHeadTemplate[] = [];
  counts.forEach((count, hash) => {
    if (count >= minCount) {
      templates.push({
        id: `running-head-${hash.slice(0, 8)}`,
        bbox: [0, 0, outputSize.width, Math.round(outputSize.height * band.yEndRatio)],
        hash,
        confidence: clamp01(count / Math.max(minCount, imagePaths.length)),
      });
    }
  });
  return templates;
};

export const deriveFolioModel = async (
  imagePaths: string[],
  outputSize: { width: number; height: number },
  minCount = 3
): Promise<FolioModel | undefined> => {
  const band = { yStartRatio: 0.86, yEndRatio: 0.98 };
  const counts = new Map<string, number>();
  for (const imagePath of imagePaths) {
    const hashed = await hashBand(imagePath, band);
    if (!hashed) continue;
    counts.set(hashed.hash, (counts.get(hashed.hash) ?? 0) + 1);
  }

  let strongest = { hash: "", count: 0 };
  counts.forEach((count, hash) => {
    if (count > strongest.count) strongest = { hash, count };
  });
  if (strongest.count < minCount) return undefined;

  return {
    positionBands: [
      {
        side: "center",
        band: [
          Math.round(outputSize.height * band.yStartRatio),
          Math.round(outputSize.height * band.yEndRatio),
        ],
        confidence: clamp01(strongest.count / Math.max(minCount, imagePaths.length)),
      },
    ],
  };
};

export const deriveOrnamentLibrary = async (
  imagePaths: string[],
  outputSize: { width: number; height: number },
  minCount = 2
): Promise<OrnamentAnchor[]> => {
  const band = { yStartRatio: 0.14, yEndRatio: 0.24 };
  const hashes: Array<{ hash: string; variance: number }> = [];
  for (const imagePath of imagePaths) {
    const hashed = await hashBand(imagePath, band);
    if (hashed && hashed.variance > 120) {
      hashes.push(hashed);
    }
  }

  const counts = new Map<string, number>();
  hashes.forEach((entry) => {
    counts.set(entry.hash, (counts.get(entry.hash) ?? 0) + 1);
  });

  const ornaments: OrnamentAnchor[] = [];
  counts.forEach((count, hash) => {
    if (count >= minCount) {
      ornaments.push({
        hash,
        bbox: [
          Math.round(outputSize.width * 0.35),
          Math.round(outputSize.height * band.yStartRatio),
          Math.round(outputSize.width * 0.65),
          Math.round(outputSize.height * band.yEndRatio),
        ],
        confidence: clamp01(count / Math.max(minCount, imagePaths.length)),
      });
    }
  });

  return ornaments;
};

export const deriveBookModelFromImages = async (
  imagePaths: string[],
  outputSize: { width: number; height: number }
): Promise<Pick<BookModel, "runningHeadTemplates" | "folioModel" | "ornamentLibrary">> => {
  const minCount = Math.max(2, Math.round(imagePaths.length * 0.2));
  const runningHeads = await deriveRunningHeadTemplates(imagePaths, outputSize, minCount);
  const folioModel = await deriveFolioModel(imagePaths, outputSize, minCount);
  const ornamentLibrary = await deriveOrnamentLibrary(imagePaths, outputSize, minCount);

  return {
    runningHeadTemplates: runningHeads,
    folioModel,
    ornamentLibrary,
  };
};
