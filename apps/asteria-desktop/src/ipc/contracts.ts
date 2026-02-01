/**
 * IPC channel contracts and types for Asteria Studio.
 * Defines the shape of messages between renderer and main process.
 */

export interface PageData {
  id: string;
  filename: string;
  originalPath: string;
  confidenceScores: Record<string, number>;
}

export interface PipelineRunConfig {
  projectId: string;
  pages: PageData[];
  targetDpi: number;
  targetDimensionsMm: { width: number; height: number };
}

export interface PipelineRunResult {
  runId: string;
  status: "success" | "error" | "cancelled";
  pagesProcessed: number;
  errors: Array<{ pageId: string; message: string }>;
  metrics: Record<string, unknown>;
}

export interface PageBoundsEstimate {
  pageId: string;
  widthPx: number;
  heightPx: number;
  bleedPx: number;
  trimPx: number;
  pageBounds: [number, number, number, number];
  contentBounds: [number, number, number, number];
}

export interface CorpusSummary {
  projectId: string;
  pageCount: number;
  dpi: number;
  targetDimensionsPx: { width: number; height: number };
  estimates: PageBoundsEstimate[];
  notes?: string;
}

export interface ScanCorpusOptions {
  projectId?: string;
  targetDpi?: number;
  targetDimensionsMm?: { width: number; height: number };
  includeChecksums?: boolean;
}

export interface IpcChannels {
  "asteria:start-run": (_config: PipelineRunConfig) => Promise<PipelineRunResult>;
  "asteria:cancel-run": (_runId: string) => Promise<void>;
  "asteria:fetch-page": (_pageId: string) => Promise<PageData>;
  "asteria:apply-override": (_pageId: string, _overrides: Record<string, unknown>) => Promise<void>;
  "asteria:export-run": (_runId: string, _format: "png" | "tiff" | "pdf") => Promise<string>;
  "asteria:analyze-corpus": (_config: PipelineRunConfig) => Promise<CorpusSummary>;
  "asteria:scan-corpus": (
    _rootPath: string,
    _options?: ScanCorpusOptions
  ) => Promise<PipelineRunConfig>;
}
