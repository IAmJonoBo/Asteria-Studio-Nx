import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  PipelineConfig,
  PipelineConfigOverrides,
  PipelineConfigSources,
} from "../ipc/contracts";

export type { PipelineConfig, PipelineConfigOverrides, PipelineConfigSources };

const defaultConfig: PipelineConfig = {
  version: "0.1.0",
  project: {
    name: null,
    target_dimensions: { width: 210, height: 297, unit: "mm" },
    dpi: 400,
    bleed_mm: 3,
    trim_mm: 0,
    color_profile: "sRGB",
    storage: "local",
  },
  models: {
    execution_mode: "auto",
    endpoints: {
      remote_url: null,
      remote_layout_endpoint: null,
      remote_layout_token_env: "ASTERIA_REMOTE_LAYOUT_TOKEN",
      remote_layout_timeout_ms: 5000,
    },
    ocr: { engine: "tesseract", languages: ["eng"] },
    detector: { name: "layout-detector", version: "0.1.0" },
    dewarp: { name: "dewarp-unet", version: "0.1.0" },
  },
  steps: {
    ingest: { enabled: true, checksum: "sha256" },
    preprocess: { enabled: true, denoise: true, contrast_enhance: true, binarize_for_hints: true },
    deskew: { enabled: true, max_angle: 5, quality_threshold: 0.7 },
    dewarp: { enabled: true, quality_threshold: 0.6 },
    layout_detect: { enabled: true, confidence_threshold: 0.4, nms_iou: 0.3 },
    spread_split: {
      enabled: false,
      confidence_threshold: 0.7,
      gutter_min_width_px: 12,
      gutter_max_width_px: 80,
    },
    normalize: {
      enabled: true,
      snap_to_grid: true,
      preserve_aspect: true,
      bleed_mm: 3,
      trim_mm: 0,
    },
    shading_correct: {
      enabled: true,
      max_residual_increase: 0.12,
      max_highlight_shift: 0.08,
      confidence_floor: 0.55,
      spine_shadow_min_width_px: 10,
      spine_shadow_max_width_px: 120,
    },
    book_priors: {
      enabled: true,
      sample_pages: 40,
      max_trim_drift_px: 18,
      max_content_drift_px: 24,
      min_confidence: 0.6,
    },
    ornament_hash: { enabled: true, min_confidence: 0.65 },
    baseline_grid: { enabled: true, confidence_floor: 0.6 },
    qa: {
      enabled: true,
      route_low_confidence: true,
      confidence_floor: 0.5,
      warp_score_ceiling: 0.25,
      mask_coverage_min: 0.65,
      mask_coverage_drop_ratio: 0.7,
      skew_confidence_min: 0.35,
      shadow_score_max: 28,
      background_std_max: 32,
      shading_residual_max: 1.12,
      shading_confidence_min: 0.45,
      baseline_residual_max: 0.15,
      baseline_consistency_min: 0.55,
      baseline_skew_confidence_min: 0.5,
      baseline_noise_std_max: 20,
      book_model_min_coverage: 0.6,
      book_model_min_confidence: 0.6,
      semantic_thresholds: {
        body: 0.88,
        "chapter-opening": 0.85,
        title: 0.75,
        cover: 0.75,
        "front-matter": 0.82,
        "back-matter": 0.82,
        appendix: 0.8,
        index: 0.8,
        illustration: 0.7,
        table: 0.8,
        blank: 0.65,
        unknown: 0.95,
      },
    },
  },
  export: {
    formats: ["png", "tiff"],
    include_pdf: true,
    include_json_sidecars: true,
    naming: "{projectId}_{pageId}_{runId}",
  },
  logging: { level: "info", per_page_logs: true, keep_logs: true },
};

const resolveConfigPath = (configPath?: string): string =>
  configPath ??
  process.env.ASTERIA_PIPELINE_CONFIG_PATH ??
  path.join(process.cwd(), "spec", "pipeline_config.yaml");

const mergeDeep = <T extends object>(target: T, source: Record<string, unknown>): T => {
  const output = { ...(target as Record<string, unknown>) } as Record<string, unknown>;
  Object.entries(source).forEach(([key, value]) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      output[key] = value;
      return;
    }
    if (value && typeof value === "object") {
      const base = output[key];
      if (base && typeof base === "object" && !Array.isArray(base)) {
        output[key] = mergeDeep(base as Record<string, unknown>, value as Record<string, unknown>);
        return;
      }
    }
    output[key] = value as unknown;
  });
  return output as T;
};

export type LoadedPipelineConfig = {
  config: PipelineConfig;
  configPath: string;
  loadedFromFile: boolean;
};

export type LoadedProjectOverrides = {
  overrides?: PipelineConfigOverrides;
  configPath?: string;
};

export const loadPipelineConfig = async (configPath?: string): Promise<LoadedPipelineConfig> => {
  const resolvedPath = resolveConfigPath(configPath);
  try {
    const raw = await fs.readFile(resolvedPath, "utf-8");
    const parsed = YAML.parse(raw) as Partial<PipelineConfig> | null;
    if (!parsed || typeof parsed !== "object") {
      return { config: defaultConfig, configPath: resolvedPath, loadedFromFile: false };
    }
    const merged = mergeDeep(defaultConfig, parsed as Record<string, unknown>);
    return { config: merged, configPath: resolvedPath, loadedFromFile: true };
  } catch {
    return { config: defaultConfig, configPath: resolvedPath, loadedFromFile: false };
  }
};

export const loadProjectOverrides = async (projectId: string): Promise<LoadedProjectOverrides> => {
  const projectRoot = path.join(process.cwd(), "projects", projectId);
  const candidates = [
    path.join(projectRoot, "pipeline.config.yaml"),
    path.join(projectRoot, "pipeline.config.yml"),
    path.join(projectRoot, "pipeline.config.json"),
  ];

  for (const configPath of candidates) {
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const overrides = configPath.endsWith(".json")
        ? (JSON.parse(raw) as PipelineConfigOverrides)
        : (YAML.parse(raw) as PipelineConfigOverrides);
      if (overrides && typeof overrides === "object") {
        return { overrides, configPath };
      }
    } catch {
      // ignore missing files
    }
  }

  return {};
};

export const resolvePipelineConfig = (
  baseConfig: PipelineConfig,
  options?: {
    overrides?: PipelineConfigOverrides;
    env?: Record<string, string | undefined>;
    configPath?: string;
    loadedFromFile?: boolean;
    projectConfigPath?: string;
    projectOverrides?: PipelineConfigOverrides;
  }
): { resolvedConfig: PipelineConfig; sources: PipelineConfigSources } => {
  const overrides = options?.overrides;
  const env = options?.env ?? {};

  const envOverrides: PipelineConfigOverrides = {};
  const targetDpi = Number(env.ASTERIA_TARGET_DPI);
  const targetWidth = Number(env.ASTERIA_TARGET_WIDTH_MM);
  const targetHeight = Number(env.ASTERIA_TARGET_HEIGHT_MM);
  if (Number.isFinite(targetDpi) && targetDpi > 0) {
    envOverrides.project = { ...envOverrides.project, dpi: targetDpi };
  }
  if (
    Number.isFinite(targetWidth) &&
    Number.isFinite(targetHeight) &&
    targetWidth > 0 &&
    targetHeight > 0
  ) {
    envOverrides.project = {
      ...envOverrides.project,
      target_dimensions: { width: targetWidth, height: targetHeight, unit: "mm" },
    };
  }

  const merged = mergeDeep(
    mergeDeep(baseConfig, (overrides ?? {}) as Record<string, unknown>),
    envOverrides as Record<string, unknown>
  );

  return {
    resolvedConfig: merged,
    sources: {
      configPath: options?.configPath ?? resolveConfigPath(),
      loadedFromFile: options?.loadedFromFile ?? false,
      overrides,
      envOverrides,
      projectConfigPath: options?.projectConfigPath,
      projectOverrides: options?.projectOverrides,
    },
  };
};
