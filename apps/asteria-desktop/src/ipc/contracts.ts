/**
 * IPC channel contracts and types for Asteria Studio.
 * Defines the shape of messages between renderer and main process.
 */

export interface PageData {
  id: string;
  filename: string;
  originalPath: string;
  checksum?: string;
  confidenceScores: Record<string, number>;
}

export type LayoutProfile =
  | "cover"
  | "title"
  | "front-matter"
  | "chapter-opening"
  | "body"
  | "illustration"
  | "table"
  | "index"
  | "appendix"
  | "back-matter"
  | "blank"
  | "unknown";

export interface NormalizationShading {
  method?: string;
  backgroundModel?: string;
  spineShadowModel?: string;
  params?: Record<string, number | string | boolean>;
  confidence?: number;
}

export interface BaselineSummary {
  medianSpacingPx?: number;
  spacingMAD?: number;
  lineStraightnessResidual?: number;
  confidence?: number;
}

export interface BoxDistribution {
  median?: [number, number, number, number];
  dispersion?: [number, number, number, number];
}

export interface RunningHeadTemplate {
  id: string;
  bbox: [number, number, number, number];
  hash: string;
  confidence: number;
}

export interface FolioPositionBand {
  side: "left" | "center" | "right";
  band: [number, number];
  confidence: number;
}

export interface FolioModel {
  positionBands?: FolioPositionBand[];
  numeralStyle?: string;
  ocrConfidenceSummary?: { mean?: number; median?: number; p90?: number };
}

export interface OrnamentAnchor {
  hash: string;
  bbox: [number, number, number, number];
  confidence: number;
}

export interface BaselineGridModel {
  dominantSpacingPx?: number;
  spacingMAD?: number;
  confidence?: number;
}

export interface BookModel {
  trimBoxPx?: BoxDistribution;
  contentBoxPx?: BoxDistribution;
  runningHeadTemplates?: RunningHeadTemplate[];
  folioModel?: FolioModel;
  ornamentLibrary?: OrnamentAnchor[];
  baselineGrid?: BaselineGridModel;
}

export interface ReviewPreview {
  kind: "source" | "normalized" | "overlay";
  path: string;
  width: number;
  height: number;
}

export interface ReviewDecision {
  pageId: string;
  decision: "accept" | "reject" | "adjust";
  notes?: string;
  overrides?: Record<string, unknown>;
}

export interface ReviewItem {
  pageId: string;
  filename: string;
  layoutProfile: LayoutProfile;
  layoutConfidence: number;
  qualityGate: { accepted: boolean; reasons: string[] };
  reason: "quality-gate" | "semantic-layout";
  previews: ReviewPreview[];
  suggestedAction: "confirm" | "adjust";
}

export interface ReviewQueue {
  runId: string;
  projectId: string;
  generatedAt: string;
  items: ReviewItem[];
}

export interface PageLayoutElement {
  id: string;
  type:
    | "page_bounds"
    | "text_block"
    | "title"
    | "running_head"
    | "folio"
    | "ornament"
    | "drop_cap"
    | "footnote"
    | "marginalia";
  bbox: [number, number, number, number];
  confidence: number;
  text?: string;
  notes?: string;
  flags?: string[];
  source?: string;
}

export interface PageLayoutSidecar {
  pageId: string;
  source: { path: string; checksum: string; pageIndex?: number };
  dimensions: { width: number; height: number; unit: "mm" | "cm" | "in" };
  dpi: number;
  normalization: {
    skewAngle?: number;
    dpiSource?: "metadata" | "inferred" | "fallback";
    warp?: { method?: string; residual?: number };
    pageMask?: [number, number, number, number];
    cropBox?: [number, number, number, number];
    scale?: number;
    bleed?: number;
    trim?: number;
    shadow?: {
      present?: boolean;
      side?: "left" | "right" | "top" | "bottom" | "none";
      widthPx?: number;
      confidence?: number;
      darkness?: number;
    };
    shading?: NormalizationShading;
  };
  elements: PageLayoutElement[];
  metrics: {
    deskewConfidence?: number;
    warpScore?: number;
    layoutScore?: number;
    processingMs?: number;
    maskCoverage?: number;
    shadowScore?: number;
    backgroundStd?: number;
    backgroundMean?: number;
    illuminationResidual?: number;
    spineShadowScore?: number;
    baseline?: BaselineSummary;
  };
  decisions?: { accepted?: boolean; notes?: string; overrides?: string[] };
  bookModel?: BookModel;
  version?: string;
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
  targetDimensionsMm: { width: number; height: number };
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
  "asteria:fetch-review-queue": (_runId: string) => Promise<ReviewQueue>;
  "asteria:submit-review": (_runId: string, _decisions: ReviewDecision[]) => Promise<void>;
}
