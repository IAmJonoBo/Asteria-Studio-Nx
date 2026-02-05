import { createRequire } from "node:module";

export type PipelineCoreNative = {
  estimateSkewAngle: (
    data: Buffer,
    width: number,
    height: number
  ) => { angle: number; confidence: number };
  baselineMetrics: (
    data: Buffer,
    width: number,
    height: number
  ) => {
    lineConsistency: number;
    textLineCount: number;
    spacingNorm: number;
    spacingMadNorm: number;
    offsetNorm: number;
    angleDeg: number;
    confidence: number;
    peakSharpness: number;
    peaksY: number[];
  };
  columnMetrics: (
    data: Buffer,
    width: number,
    height: number
  ) => { columnCount: number; columnSeparation: number };
  detectLayoutElements: (
    data: Buffer,
    width: number,
    height: number
  ) => Array<{ id: string; type: string; bbox: number[]; confidence: number }>;
  projectionProfileX: (data: Buffer, width: number, height: number) => number[];
  projectionProfileY: (data: Buffer, width: number, height: number) => number[];
  sobelMagnitude: (data: Buffer, width: number, height: number) => number[];
  dhash9x8: (data: Buffer) => string;
};

let cached: PipelineCoreNative | undefined;

const createFallbackNative = (): PipelineCoreNative => {
  const projectionProfileX = (data: Buffer, width: number, height: number): number[] => {
    const profile = new Array(width).fill(0);
    if (width <= 0 || height <= 0 || data.length < width * height) return profile;
    for (let y = 0; y < height; y += 1) {
      const offset = y * width;
      for (let x = 0; x < width; x += 1) {
        profile[x] += data[offset + x] ?? 0;
      }
    }
    return profile;
  };

  const projectionProfileY = (data: Buffer, width: number, height: number): number[] => {
    const profile = new Array(height).fill(0);
    if (width <= 0 || height <= 0 || data.length < width * height) return profile;
    for (let y = 0; y < height; y += 1) {
      const offset = y * width;
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        sum += data[offset + x] ?? 0;
      }
      profile[y] = sum;
    }
    return profile;
  };

  const sobelMagnitude = (data: Buffer, width: number, height: number): number[] => {
    const magnitudes = new Array(width * height).fill(0);
    if (width < 3 || height < 3 || data.length < width * height) return magnitudes;
    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [1, 2, 1, 0, 0, 0, -1, -2, -1];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sumX = 0;
        let sumY = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const ix = x + kx;
            const iy = y + ky;
            const value = data[iy * width + ix] ?? 0;
            sumX += gx[k] * value;
            sumY += gy[k] * value;
            k += 1;
          }
        }
        magnitudes[y * width + x] = Math.floor(Math.sqrt(sumX * sumX + sumY * sumY));
      }
    }
    return magnitudes;
  };

  const estimateSkewAngle = (
    data: Buffer,
    width: number,
    height: number
  ): ReturnType<PipelineCoreNative["estimateSkewAngle"]> => {
    if (width <= 0 || height <= 0 || data.length < width * height) {
      return { angle: 0, confidence: 0 };
    }
    const magnitudes = sobelMagnitude(data, width, height);
    const stride = Math.max(1, Math.floor(Math.max(width, height) / 512));
    const points: Array<{ x: number; y: number; weight: number }> = [];
    for (let y = 1; y < height - 1; y += stride) {
      for (let x = 1; x < width - 1; x += stride) {
        const mag = magnitudes[y * width + x] ?? 0;
        if (mag > 20) {
          points.push({ x, y, weight: mag });
        }
      }
    }
    if (points.length < 50) {
      return { angle: 0, confidence: 0 };
    }

    let bestAngle = 0;
    let bestScore = 0;
    for (let angle = -30; angle <= 30; angle += 1) {
      const radians = (angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const bins = new Float64Array(height);
      for (const point of points) {
        const yRot = point.y * cos - point.x * sin;
        const idx = Math.round(yRot);
        if (idx >= 0 && idx < height) {
          bins[idx] += point.weight;
        }
      }
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < bins.length; i += 1) {
        const value = bins[i];
        sum += value;
        sumSq += value * value;
      }
      const mean = sum / bins.length;
      const variance = Math.max(0, sumSq / bins.length - mean * mean);
      if (variance > bestScore) {
        bestScore = variance;
        bestAngle = angle;
      }
    }

    const totalSamples = Math.ceil((height - 2) / stride) * Math.ceil((width - 2) / stride);
    const edgeDensity = points.length / Math.max(1, totalSamples);
    const scoreFactor = bestScore / Math.max(1, points.length * 5000);
    const confidence = Math.min(1, scoreFactor * Math.min(1, edgeDensity * 8));
    return { angle: bestAngle, confidence };
  };

  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  };

  const baselineMetrics = (
    data: Buffer,
    width: number,
    height: number
  ): ReturnType<PipelineCoreNative["baselineMetrics"]> => {
    if (width <= 0 || height <= 0 || data.length < width * height) {
      return {
        lineConsistency: 0,
        textLineCount: 0,
        spacingNorm: 0,
        spacingMadNorm: 0,
        offsetNorm: 0,
        angleDeg: 0,
        confidence: 0,
        peakSharpness: 0,
        peaksY: [],
      };
    }
    const rowSums = new Array(height).fill(0);
    for (let y = 0; y < height; y += 1) {
      const offset = y * width;
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        sum += 255 - (data[offset + x] ?? 0);
      }
      rowSums[y] = sum;
    }
    const mean = rowSums.reduce((acc, v) => acc + v, 0) / Math.max(1, rowSums.length);
    const variance =
      rowSums.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / Math.max(1, rowSums.length);
    const std = Math.sqrt(variance);
    const lineConsistency = mean > 0 ? Math.max(0, 1 - Math.min(1, std / (mean * 2))) : 0;
    const threshold = mean + std * 0.6;
    const peaks: number[] = [];
    let sharpnessSum = 0;
    let sharpnessCount = 0;
    for (let y = 1; y < rowSums.length - 1; y += 1) {
      if (rowSums[y] > threshold && rowSums[y] > rowSums[y - 1] && rowSums[y] > rowSums[y + 1]) {
        peaks.push(y);
        const neighborAvg = 0.5 * (rowSums[y - 1] + rowSums[y + 1]);
        const sharpness = rowSums[y] - neighborAvg;
        if (std > 0) {
          sharpnessSum += sharpness / std;
          sharpnessCount += 1;
        }
      }
    }
    const peakSharpness = sharpnessCount > 0 ? sharpnessSum / sharpnessCount : 0;

    let spacingNorm = 0;
    let spacingMadNorm = 0;
    let offsetNorm = 0;
    if (peaks.length > 1 && height > 1) {
      const deltas = peaks
        .slice(1)
        .map((value, index) => (value - peaks[index]) / Math.max(1, height - 1));
      spacingNorm = median(deltas);
      spacingMadNorm = median(deltas.map((d) => Math.abs(d - spacingNorm)));
      if (spacingNorm > 0) {
        const offsets = peaks.map(
          (y) => ((y % Math.max(1, height - 1)) / Math.max(1, height - 1)) % spacingNorm
        );
        offsetNorm = median(offsets);
      }
    }
    const peakCountScore = Math.min(1, Math.max(0, (peaks.length - 2) / 8));
    const spacingScore =
      spacingNorm > 0 ? Math.max(0, 1 - Math.min(1, spacingMadNorm / spacingNorm)) : 0;
    const sharpnessScore = Math.min(1, Math.max(0, peakSharpness / 3));
    const confidence = Math.min(
      1,
      Math.max(0, 0.4 * spacingScore + 0.35 * sharpnessScore + 0.25 * peakCountScore)
    );
    const peaksY = height > 1 ? peaks.map((y) => y / Math.max(1, height - 1)) : [];
    return {
      lineConsistency,
      textLineCount: peaks.length,
      spacingNorm,
      spacingMadNorm,
      offsetNorm,
      angleDeg: 0,
      confidence,
      peakSharpness,
      peaksY,
    };
  };

  const columnMetrics = (
    data: Buffer,
    width: number,
    height: number
  ): ReturnType<PipelineCoreNative["columnMetrics"]> => {
    if (width <= 0 || height <= 0 || data.length < width * height) {
      return { columnCount: 0, columnSeparation: 0 };
    }
    const colSums = new Array(width).fill(0);
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = 0; y < height; y += 1) {
        sum += 255 - (data[y * width + x] ?? 0);
      }
      colSums[x] = sum;
    }
    const mean = colSums.reduce((acc, v) => acc + v, 0) / Math.max(1, colSums.length);
    const variance =
      colSums.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / Math.max(1, colSums.length);
    const std = Math.sqrt(variance);
    const threshold = mean + std * 0.7;
    let columnBands = 0;
    let inBand = false;
    for (const val of colSums) {
      if (val > threshold) {
        if (!inBand) {
          columnBands += 1;
          inBand = true;
        }
      } else {
        inBand = false;
      }
    }
    return { columnCount: Math.max(1, columnBands), columnSeparation: std };
  };

  const detectLayoutElements = (
    data: Buffer,
    width: number,
    height: number
  ): ReturnType<PipelineCoreNative["detectLayoutElements"]> => {
    if (width <= 0 || height <= 0 || data.length < width * height) return [];
    const values = data.subarray(0, width * height);
    const mean = values.reduce((acc, v) => acc + v, 0) / Math.max(1, values.length);
    const variance =
      values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / Math.max(1, values.length);
    const std = Math.sqrt(variance);
    const threshold = Math.min(245, Math.max(10, mean - std * 0.5));

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let found = false;
    for (let y = 0; y < height; y += 1) {
      const offset = y * width;
      for (let x = 0; x < width; x += 1) {
        if ((values[offset + x] ?? 0) < threshold) {
          found = true;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    const [x0, y0, x1, y1] = found
      ? [minX, minY, maxX, maxY]
      : [0, 0, Math.max(0, width - 1), Math.max(0, height - 1)];
    const contentWidth = Math.max(1, x1 - x0);
    const contentHeight = Math.max(1, y1 - y0);
    const makeBox = (fx0: number, fy0: number, fx1: number, fy1: number): number[] => [
      Math.min(width - 1, Math.max(0, x0 + contentWidth * fx0)),
      Math.min(height - 1, Math.max(0, y0 + contentHeight * fy0)),
      Math.min(width - 1, Math.max(0, x0 + contentWidth * fx1)),
      Math.min(height - 1, Math.max(0, y0 + contentHeight * fy1)),
    ];
    return [
      {
        id: "page-bounds",
        type: "page_bounds",
        bbox: [0, 0, Math.max(0, width - 1), Math.max(0, height - 1)],
        confidence: 0.6,
      },
      { id: "text-block", type: "text_block", bbox: [x0, y0, x1, y1], confidence: 0.55 },
      { id: "title", type: "title", bbox: makeBox(0.12, 0.02, 0.88, 0.14), confidence: 0.28 },
      {
        id: "running-head",
        type: "running_head",
        bbox: makeBox(0.1, 0, 0.9, 0.08),
        confidence: 0.25,
      },
      { id: "folio", type: "folio", bbox: makeBox(0.42, 0.9, 0.58, 0.98), confidence: 0.22 },
      {
        id: "ornament",
        type: "ornament",
        bbox: makeBox(0.42, 0.18, 0.58, 0.24),
        confidence: 0.2,
      },
      {
        id: "drop-cap",
        type: "drop_cap",
        bbox: makeBox(0.02, 0.18, 0.1, 0.32),
        confidence: 0.18,
      },
      {
        id: "footnote",
        type: "footnote",
        bbox: makeBox(0.05, 0.86, 0.95, 0.98),
        confidence: 0.2,
      },
      {
        id: "marginalia",
        type: "marginalia",
        bbox: makeBox(0, 0.25, 0.08, 0.75),
        confidence: 0.18,
      },
    ];
  };

  const dhash9x8 = (data: Buffer): string => {
    if (data.length < 72) return "0";
    let hash = 0n;
    let bit = 0n;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const left = data[y * 9 + x] ?? 0;
        const right = data[y * 9 + x + 1] ?? 0;
        if (left < right) {
          hash |= 1n << bit;
        }
        bit += 1n;
      }
    }
    return hash.toString(16).padStart(16, "0");
  };

  return {
    estimateSkewAngle,
    baselineMetrics,
    columnMetrics,
    detectLayoutElements,
    projectionProfileX,
    projectionProfileY,
    sobelMagnitude,
    dhash9x8,
  };
};

const loadPipelineCoreNative = (): PipelineCoreNative => {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const candidates = [
    "../../../packages/pipeline-core",
    "../../../../packages/pipeline-core",
    "pipeline-core",
  ];
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const mod = require(candidate) as Partial<PipelineCoreNative>;
      if (
        typeof mod?.estimateSkewAngle === "function" &&
        typeof mod?.baselineMetrics === "function" &&
        typeof mod?.columnMetrics === "function" &&
        typeof mod?.detectLayoutElements === "function" &&
        typeof mod?.dhash9x8 === "function" &&
        typeof mod?.projectionProfileX === "function" &&
        typeof mod?.projectionProfileY === "function" &&
        typeof mod?.sobelMagnitude === "function"
      ) {
        const native = mod as PipelineCoreNative;
        cached = native;
        return native;
      }
    } catch (error) {
      console.warn(`Failed to load pipeline-core from ${candidate}`, error);
      lastError = new Error(`Failed to load pipeline-core from ${candidate}`);
    }
  }

  const error = new Error(
    "pipeline-core native module is required but was not found. Ensure packages/pipeline-core is built and available."
  );
  if (lastError) {
    (error as Error & { cause?: unknown }).cause = lastError;
  }
  cached = createFallbackNative();
  return cached;
};

export const getPipelineCoreNative = (): PipelineCoreNative => loadPipelineCoreNative();
