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
  peaksY?: number[];
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

export interface PageTemplate {
  id: string;
  pageType: LayoutProfile;
  pageIds: string[];
  margins?: { top: number; right: number; bottom: number; left: number };
  columns?: { count: number; valleyRatio?: number };
  headBand?: { ratio: number };
  footerBand?: { ratio: number };
  baseline?: { spacingPx?: number; consistency?: number };
  gutter?: { meanRatio?: number };
  ornamentHashes?: string[];
  textDensity?: number;
  whitespaceRatio?: number;
  confidence: number;
export interface BaselineGridGuide {
  spacingPx?: number;
  offsetPx?: number;
  angleDeg?: number;
  confidence?: number;
  source?: "auto" | "user";
}

export interface BookModel {
  trimBoxPx?: BoxDistribution;
  contentBoxPx?: BoxDistribution;
  runningHeadTemplates?: RunningHeadTemplate[];
  folioModel?: FolioModel;
  ornamentLibrary?: OrnamentAnchor[];
  baselineGrid?: BaselineGridModel;
  pageTemplates?: PageTemplate[];
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

export interface TemplateTrainingSignal {
  templateId: string;
  scope: "template" | "section";
  appliedAt: string;
  pages: string[];
  overrides: Record<string, unknown>;
  sourcePageId?: string;
  layoutProfile?: LayoutProfile;
  runId?: string;
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
  spread?: {
    sourcePageId: string;
    side: "left" | "right";
    gutter?: { startRatio: number; endRatio: number };
  };
}

export interface ReviewQueue {
  runId: string;
  projectId: string;
  generatedAt: string;
  items: ReviewItem[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  inputPath: string;
  configPath?: string;
  pageCount?: number;
  lastRun?: string;
  status?: "idle" | "processing" | "completed" | "error";
}

export interface ImportCorpusRequest {
  inputPath: string;
  name?: string;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  projectId: string;
  generatedAt: string;
  reviewCount: number;
  status?: "queued" | "running" | "paused" | "cancelling" | "cancelled" | "error" | "success";
  startedAt?: string;
  updatedAt?: string;
  reportPath?: string;
  inferredDimensionsMm?: { width: number; height: number };
  inferredDpi?: number;
  dimensionConfidence?: number;
  dpiConfidence?: number;
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

export interface GuideLine {
  id: string;
  axis: "x" | "y";
  position: number;
  kind: "major" | "minor";
  label?: string;
}

export interface GuideLayerData {
  id: string;
  guides: GuideLine[];
}

export interface GuideLayout {
  layers: GuideLayerData[];
}

export interface PageLayoutSidecar {
  pageId: string;
  pageType?: LayoutProfile;
  templateId?: string;
  templateConfidence?: number;
  source: { path: string; checksum: string; pageIndex?: number };
  spread?: {
    sourcePageId: string;
    side: "left" | "right";
    gutter?: { startRatio: number; endRatio: number };
  };
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
    guides?: {
      baselineGrid?: BaselineGridGuide;
    };
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
  decisions?: {
    accepted?: boolean;
    notes?: string;
    overrides?: string[];
    overrideAppliedAt?: string;
  };
  adjustments?: {
    rotationDelta?: number;
    cropOffsets?: [number, number, number, number];
    trimOffsets?: [number, number, number, number];
    elementEdits?: Array<{
      action: "add" | "update" | "remove";
      elementId?: string;
      before?: PageLayoutElement;
      after?: PageLayoutElement;
    }>;
    appliedAt?: string;
    source?: "review";
  };
  overrides?: Record<string, unknown>;
  guides?: GuideLayout;
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
  runDir: string;
  status: "success" | "error" | "cancelled" | "running" | "paused";
  pagesProcessed: number;
  errors: Array<{ pageId: string; message: string }>;
  metrics: Record<string, unknown>;
}

export interface RunProgressEvent {
  runId: string;
  projectId: string;
  stage: string;
  processed: number;
  total: number;
  throughput?: number;
  inferredDimensionsMm?: { width: number; height: number };
  inferredDpi?: number;
  dimensionConfidence?: number;
  dpiConfidence?: number;
  timestamp: string;
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
  inferredDimensionsMm?: { width: number; height: number };
  inferredDpi?: number;
  dimensionConfidence?: number;
  dpiConfidence?: number;
  estimates: PageBoundsEstimate[];
  notes?: string;
}

export interface ScanCorpusOptions {
  projectId?: string;
  targetDpi?: number;
  targetDimensionsMm?: { width: number; height: number };
  includeChecksums?: boolean;
}

export interface PipelineConfig {
  version: string;
  project: {
    name: string | null;
    target_dimensions: { width: number; height: number; unit: "mm" | "cm" | "in" };
    dpi: number;
    bleed_mm: number;
    trim_mm: number;
    color_profile: string;
    storage: "local" | "remote";
  };
  models: {
    execution_mode: "auto" | "local" | "remote";
    endpoints: {
      remote_url: string | null;
      remote_layout_endpoint: string | null;
      remote_layout_token_env: string;
      remote_layout_timeout_ms: number;
    };
    ocr: { engine: string; languages: string[] };
    detector: { name: string; version: string };
    dewarp: { name: string; version: string };
  };
  steps: {
    ingest: { enabled: boolean; checksum: string };
    preprocess: {
      enabled: boolean;
      denoise: boolean;
      contrast_enhance: boolean;
      binarize_for_hints: boolean;
    };
    deskew: { enabled: boolean; max_angle: number; quality_threshold: number };
    dewarp: { enabled: boolean; quality_threshold: number };
    layout_detect: { enabled: boolean; confidence_threshold: number; nms_iou: number };
    spread_split: {
      enabled: boolean;
      confidence_threshold: number;
      gutter_min_width_px: number;
      gutter_max_width_px: number;
    };
    normalize: {
      enabled: boolean;
      snap_to_grid: boolean;
      preserve_aspect: boolean;
      bleed_mm: number;
      trim_mm: number;
    };
    shading_correct: {
      enabled: boolean;
      max_residual_increase: number;
      max_highlight_shift: number;
      confidence_floor: number;
      spine_shadow_min_width_px: number;
      spine_shadow_max_width_px: number;
    };
    book_priors: {
      enabled: boolean;
      sample_pages: number;
      max_trim_drift_px: number;
      max_content_drift_px: number;
      min_confidence: number;
    };
    ornament_hash: { enabled: boolean; min_confidence: number };
    baseline_grid: { enabled: boolean; confidence_floor: number };
    qa: {
      enabled: boolean;
      route_low_confidence: boolean;
      confidence_floor: number;
      warp_score_ceiling: number;
      mask_coverage_min: number;
      mask_coverage_drop_ratio: number;
      skew_confidence_min: number;
      shadow_score_max: number;
      background_std_max: number;
      shading_residual_max: number;
      shading_confidence_min: number;
      baseline_residual_max: number;
      baseline_consistency_min: number;
      baseline_skew_confidence_min: number;
      baseline_noise_std_max: number;
      book_model_min_coverage: number;
      book_model_min_confidence: number;
      semantic_thresholds: Record<LayoutProfile, number>;
    };
  };
  export: {
    formats: string[];
    include_pdf: boolean;
    include_json_sidecars: boolean;
    naming: string;
  };
  snapping: {
    enabled: boolean;
    radius_px: number;
    min_confidence: {
      template: number;
      detected: number;
      baseline: number;
      user: number;
    };
    weighting: {
      template: number;
      detected: number;
      baseline: number;
      user: number;
    };
  };
  templates: {
    enabled: boolean;
    clustering: {
      min_pages: number;
      min_similarity: number;
      max_clusters: number;
    };
  };
  guides: {
    lod: {
      major_only_zoom: number;
      labels_zoom: number;
    };
  };
  logging: { level: string; per_page_logs: boolean; keep_logs: boolean };
}

type PipelineStepOverrides = {
  [K in keyof PipelineConfig["steps"]]?: Partial<PipelineConfig["steps"][K]>;
};

export type PipelineConfigOverrides = Omit<Partial<PipelineConfig>, "project" | "steps"> & {
  project?: Partial<PipelineConfig["project"]>;
  steps?: PipelineStepOverrides;
};

export interface PipelineConfigSources {
  configPath: string;
  loadedFromFile: boolean;
  overrides?: PipelineConfigOverrides;
  envOverrides?: PipelineConfigOverrides;
  projectConfigPath?: string;
  projectOverrides?: PipelineConfigOverrides;
}

export interface PipelineConfigSnapshot {
  baseConfig: PipelineConfig;
  resolvedConfig: PipelineConfig;
  sources: PipelineConfigSources;
}

export interface RunConfigSnapshot {
  resolvedConfig: PipelineConfig;
  sources: PipelineConfigSources;
}

export interface RunManifestSummary {
  runId: string;
  status: string;
  exportedAt: string;
  sourceRoot: string;
  count: number;
}

export interface IpcChannels {
  "asteria:start-run": (_config: PipelineRunConfig) => Promise<PipelineRunResult>;
  "asteria:cancel-run": (_runId: string) => Promise<void>;
  "asteria:pause-run": (_runId: string) => Promise<void>;
  "asteria:resume-run": (_runId: string) => Promise<void>;
  "asteria:fetch-page": (_runId: string, _runDir: string, _pageId: string) => Promise<PageData>;
  "asteria:fetch-sidecar": (
    _runId: string,
    _runDir: string,
    _pageId: string
  ) => Promise<PageLayoutSidecar | null>;
  "asteria:apply-override": (
    _runId: string,
    _runDir: string,
    _pageId: string,
    _overrides: Record<string, unknown>
  ) => Promise<void>;
  "asteria:export-run": (
    _runId: string,
    _runDir: string,
    _formats: Array<"png" | "tiff" | "pdf">
  ) => Promise<string>;
  "asteria:analyze-corpus": (_config: PipelineRunConfig) => Promise<CorpusSummary>;
  "asteria:scan-corpus": (
    _rootPath: string,
    _options?: ScanCorpusOptions
  ) => Promise<PipelineRunConfig>;
  "asteria:pick-corpus-dir": () => Promise<string | null>;
  "asteria:list-projects": () => Promise<ProjectSummary[]>;
  "asteria:import-corpus": (_request: ImportCorpusRequest) => Promise<ProjectSummary>;
  "asteria:list-runs": () => Promise<RunSummary[]>;
  "asteria:get-run-manifest": (
    _runId: string,
    _runDir: string
  ) => Promise<RunManifestSummary | null>;
  "asteria:get-pipeline-config": (_projectId?: string) => Promise<PipelineConfigSnapshot>;
  "asteria:save-project-config": (
    _projectId: string,
    _overrides: PipelineConfigOverrides
  ) => Promise<void>;
  "asteria:get-run-config": (_runId: string) => Promise<RunConfigSnapshot | null>;
  "asteria:fetch-review-queue": (_runId: string) => Promise<ReviewQueue>;
  "asteria:submit-review": (_runId: string, _decisions: ReviewDecision[]) => Promise<void>;
  "asteria:record-template-training": (
    _runId: string,
    _signal: TemplateTrainingSignal
  ) => Promise<void>;
}
