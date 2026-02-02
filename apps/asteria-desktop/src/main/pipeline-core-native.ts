import { createRequire } from "node:module";

export type PipelineCoreNative = {
  processPageStub: (pageId: string) => string;
  estimateSkewAngle: (
    data: Buffer,
    width: number,
    height: number
  ) => { angle: number; confidence: number };
  baselineMetrics: (
    data: Buffer,
    width: number,
    height: number
  ) => { lineConsistency: number; textLineCount: number };
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

let cached: PipelineCoreNative | null | undefined;

const loadPipelineCoreNative = (): PipelineCoreNative | null => {
  if (cached !== undefined) return cached;
  const require = createRequire(import.meta.url);
  const candidates = [
    "../../../packages/pipeline-core",
    "../../../../packages/pipeline-core",
    "pipeline-core",
  ];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate) as Partial<PipelineCoreNative>;
      if (
        typeof mod?.processPageStub === "function" &&
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
    } catch {
      // ignore resolution errors
    }
  }

  cached = null;
  return null;
};

export const getPipelineCoreNative = (): PipelineCoreNative | null => loadPipelineCoreNative();
