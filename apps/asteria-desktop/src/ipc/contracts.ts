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

export interface IpcChannels {
  "asteria:start-run": (config: PipelineRunConfig) => Promise<PipelineRunResult>;
  "asteria:cancel-run": (runId: string) => Promise<void>;
  "asteria:fetch-page": (pageId: string) => Promise<PageData>;
  "asteria:apply-override": (pageId: string, overrides: Record<string, unknown>) => Promise<void>;
  "asteria:export-run": (runId: string, format: "png" | "tiff" | "pdf") => Promise<string>;
}
