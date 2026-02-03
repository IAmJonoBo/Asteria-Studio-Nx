import { dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type {
  PipelineRunConfig,
  PipelineRunResult,
  ReviewDecision,
  ReviewQueue,
  PageData,
  RunSummary,
  PipelineConfigOverrides,
  PipelineConfigSnapshot,
  RunConfigSnapshot,
  RunManifestSummary,
  ProjectSummary,
  ImportCorpusRequest,
} from "../ipc/contracts.js";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  validateExportFormats,
  validateImportCorpusRequest,
  validateOverrides,
  validatePageId,
  validatePipelineRunConfig,
  validateRunDir,
  validateRunId,
} from "../ipc/validation.js";
import { analyzeCorpus } from "../ipc/corpusAnalysis.js";
import { scanCorpus } from "../ipc/corpusScanner.js";
import { startRun, cancelRun, pauseRun, resumeRun } from "./run-manager.js";
import {
  loadPipelineConfig,
  loadProjectOverrides,
  resolvePipelineConfig,
} from "./pipeline-config.js";
import {
  getRunDir,
  getRunManifestPath,
  getRunReportPath,
  getRunReviewQueuePath,
  getRunSidecarPath,
  getNormalizedDir,
  getSidecarDir,
  getTrainingDir,
} from "./run-paths.js";
import { writeJsonAtomic } from "./file-utils.js";
import { importCorpus, listProjects, normalizeCorpusPath } from "./projects.js";

type ExportFormat = "png" | "tiff" | "pdf";

const listFilesByExtension = (files: string[], extensions: string[]): string[] =>
  files.filter((file) => extensions.some((ext) => file.toLowerCase().endsWith(ext)));

const exportNormalizedByFormat = async (params: {
  format: ExportFormat;
  exportDir: string;
  normalizedDir: string;
  normalizedFiles: string[];
}): Promise<void> => {
  const formatDir = path.join(params.exportDir, params.format);
  await fs.mkdir(formatDir, { recursive: true });
  const sourceFiles = listFilesByExtension(params.normalizedFiles, [".png"]);

  await Promise.all(
    sourceFiles.map(async (file) => {
      const src = path.join(params.normalizedDir, file);
      if (params.format === "png") {
        await fs.copyFile(src, path.join(formatDir, file));
        return;
      }
      if (params.format === "tiff") {
        const dest = path.join(formatDir, file.replace(/\.png$/i, ".tiff"));
        await sharp(src).tiff({ compression: "lzw" }).toFile(dest);
        return;
      }
      if (params.format === "pdf") {
        const dest = path.join(formatDir, file.replace(/\.png$/i, ".pdf"));
        await sharp(src).toFormat("pdf").toFile(dest);
      }
    })
  );
};

type Box = [number, number, number, number];
type ElementEdit = {
  action: "add" | "update" | "remove";
  elementId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};
type AdjustmentSummary = {
  rotationDelta?: number;
  cropOffsets?: Box;
  trimOffsets?: Box;
  elementEdits?: ElementEdit[];
  appliedAt?: string;
  source?: "review";
};
type BaselineGridGuide = {
  spacingPx?: number | null;
  offsetPx?: number | null;
  angleDeg?: number | null;
  snapToPeaks?: boolean;
  markCorrect?: boolean;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBox = (value: unknown): value is Box =>
  Array.isArray(value) && value.length === 4 && value.every((entry) => isFiniteNumber(entry));

const parseBox = (value: unknown): Box | null => (isBox(value) ? value : null);

const buildOffsets = (base: Box | null, updated: Box | null): Box | null => {
  if (!base || !updated) return null;
  return [
    Number((updated[0] - base[0]).toFixed(2)),
    Number((updated[1] - base[1]).toFixed(2)),
    Number((updated[2] - base[2]).toFixed(2)),
    Number((updated[3] - base[3]).toFixed(2)),
  ];
};

const buildElementEdits = (
  baseElements: unknown,
  overrideElements: unknown
): ElementEdit[] | null => {
  if (!Array.isArray(overrideElements)) return null;
  const baseArray = Array.isArray(baseElements) ? baseElements : [];
  const baseMap = new Map<string, Record<string, unknown>>();
  for (const element of baseArray) {
    if (element && typeof element === "object" && "id" in element && typeof element.id === "string") {
      baseMap.set(element.id, element as Record<string, unknown>);
    }
  }
  const overrideMap = new Map<string, Record<string, unknown>>();
  for (const element of overrideElements) {
    if (element && typeof element === "object" && "id" in element && typeof element.id === "string") {
      overrideMap.set(element.id, element as Record<string, unknown>);
    }
  }

  const edits: ElementEdit[] = [];
  for (const [id, overrideElement] of overrideMap) {
    const baseElement = baseMap.get(id);
    if (!baseElement) {
      edits.push({ action: "add", elementId: id, after: overrideElement });
      continue;
    }
    if (JSON.stringify(baseElement) !== JSON.stringify(overrideElement)) {
      edits.push({ action: "update", elementId: id, before: baseElement, after: overrideElement });
    }
  }
  for (const [id, baseElement] of baseMap) {
    if (!overrideMap.has(id)) {
      edits.push({ action: "remove", elementId: id, before: baseElement });
    }
  }

  return edits.length > 0 ? edits : null;
};

const readBaselineGridOverride = (
  overrides: Record<string, unknown> | null | undefined
): BaselineGridGuide | null => {
  if (!overrides || typeof overrides !== "object") return null;
  const guides =
    "guides" in overrides && overrides.guides && typeof overrides.guides === "object"
      ? (overrides.guides as Record<string, unknown>)
      : null;
  if (!guides) return null;
  const baselineGrid =
    "baselineGrid" in guides && guides.baselineGrid && typeof guides.baselineGrid === "object"
      ? (guides.baselineGrid as Record<string, unknown>)
      : null;
  if (!baselineGrid) return null;

  const spacingRaw = baselineGrid.spacingPx;
  const offsetRaw = baselineGrid.offsetPx;
  const angleRaw = baselineGrid.angleDeg;
  const snapRaw = baselineGrid.snapToPeaks;
  const markRaw = baselineGrid.markCorrect;

  const result: BaselineGridGuide = {};
  if (isFiniteNumber(spacingRaw) || spacingRaw === null) result.spacingPx = spacingRaw as number | null;
  if (isFiniteNumber(offsetRaw) || offsetRaw === null) result.offsetPx = offsetRaw as number | null;
  if (isFiniteNumber(angleRaw) || angleRaw === null) result.angleDeg = angleRaw as number | null;
  if (typeof snapRaw === "boolean") result.snapToPeaks = snapRaw;
  if (typeof markRaw === "boolean") result.markCorrect = markRaw;

  return Object.keys(result).length > 0 ? result : null;
};

const readAutoBaselineGrid = (sidecar: Record<string, unknown> | null): BaselineGridGuide | null => {
  if (!sidecar || typeof sidecar !== "object") return null;
  const bookModel =
    "bookModel" in sidecar && sidecar.bookModel && typeof sidecar.bookModel === "object"
      ? (sidecar.bookModel as Record<string, unknown>)
      : null;
  const baselineModel =
    bookModel && "baselineGrid" in bookModel && bookModel.baselineGrid && typeof bookModel.baselineGrid === "object"
      ? (bookModel.baselineGrid as Record<string, unknown>)
      : null;
  const metrics =
    "metrics" in sidecar && sidecar.metrics && typeof sidecar.metrics === "object"
      ? (sidecar.metrics as Record<string, unknown>)
      : null;
  const baselineMetrics =
    metrics && "baseline" in metrics && metrics.baseline && typeof metrics.baseline === "object"
      ? (metrics.baseline as Record<string, unknown>)
      : null;
  const normalization =
    "normalization" in sidecar && sidecar.normalization && typeof sidecar.normalization === "object"
      ? (sidecar.normalization as Record<string, unknown>)
      : null;

  const spacing =
    (baselineModel && isFiniteNumber(baselineModel.dominantSpacingPx)
      ? baselineModel.dominantSpacingPx
      : null) ??
    (baselineMetrics && isFiniteNumber(baselineMetrics.medianSpacingPx)
      ? baselineMetrics.medianSpacingPx
      : null);
  const angle = normalization && isFiniteNumber(normalization.skewAngle)
    ? normalization.skewAngle
    : null;

  const result: BaselineGridGuide = {};
  if (spacing !== null) result.spacingPx = spacing;
  if (angle !== null) result.angleDeg = angle;

  return Object.keys(result).length > 0 ? result : null;
};

const mergeBaselineGridGuides = (
  auto: BaselineGridGuide | null,
  override: BaselineGridGuide | null
): BaselineGridGuide | null => {
  if (!auto && !override) return null;
  return {
    spacingPx: override?.spacingPx === undefined ? auto?.spacingPx : override.spacingPx,
    offsetPx: override?.offsetPx === undefined ? auto?.offsetPx : override.offsetPx,
    angleDeg: override?.angleDeg === undefined ? auto?.angleDeg : override.angleDeg,
    snapToPeaks: override?.snapToPeaks === undefined ? auto?.snapToPeaks : override.snapToPeaks,
    markCorrect: override?.markCorrect === undefined ? auto?.markCorrect : override.markCorrect,
  };
};

const buildBaselineGridDelta = (
  auto: BaselineGridGuide | null,
  final: BaselineGridGuide | null
): BaselineGridGuide | null => {
  if (!auto || !final) return null;
  const spacingDelta =
    isFiniteNumber(auto.spacingPx) && isFiniteNumber(final.spacingPx)
      ? Number((final.spacingPx - auto.spacingPx).toFixed(2))
      : undefined;
  const offsetDelta =
    isFiniteNumber(auto.offsetPx) && isFiniteNumber(final.offsetPx)
      ? Number((final.offsetPx - auto.offsetPx).toFixed(2))
      : undefined;
  const angleDelta =
    isFiniteNumber(auto.angleDeg) && isFiniteNumber(final.angleDeg)
      ? Number((final.angleDeg - auto.angleDeg).toFixed(2))
      : undefined;

  const result: BaselineGridGuide = {};
  if (spacingDelta !== undefined) result.spacingPx = spacingDelta;
  if (offsetDelta !== undefined) result.offsetPx = offsetDelta;
  if (angleDelta !== undefined) result.angleDeg = angleDelta;

  return Object.keys(result).length > 0 ? result : null;
};

const buildAdjustmentSummary = (params: {
  sidecar: Record<string, unknown> | null;
  overrides: Record<string, unknown> | null;
  appliedAt: string;
}): AdjustmentSummary | null => {
  if (!params.sidecar || !params.overrides) return null;
  const normalization = params.overrides.normalization;
  const sidecarNormalization =
    params.sidecar.normalization && typeof params.sidecar.normalization === "object"
      ? (params.sidecar.normalization as Record<string, unknown>)
      : null;
  const overrideNormalization =
    normalization && typeof normalization === "object"
      ? (normalization as Record<string, unknown>)
      : null;
  const rotationDelta = isFiniteNumber(overrideNormalization?.rotationDeg)
    ? overrideNormalization.rotationDeg
    : null;
  const cropOffsets = buildOffsets(
    parseBox(sidecarNormalization?.cropBox),
    parseBox(overrideNormalization?.cropBox)
  );
  const trimOffsets = buildOffsets(
    parseBox(sidecarNormalization?.trimBox),
    parseBox(overrideNormalization?.trimBox)
  );
  const elementEdits = buildElementEdits(params.sidecar.elements, params.overrides.elements);

  const adjustments: AdjustmentSummary = {
    rotationDelta: rotationDelta ?? undefined,
    cropOffsets: cropOffsets ?? undefined,
    trimOffsets: trimOffsets ?? undefined,
    elementEdits: elementEdits ?? undefined,
    appliedAt: params.appliedAt,
    source: "review",
  };

  const hasSignal =
    adjustments.rotationDelta !== undefined ||
    adjustments.cropOffsets !== undefined ||
    adjustments.trimOffsets !== undefined ||
    adjustments.elementEdits !== undefined;
  return hasSignal ? adjustments : null;
};

/**
 * Register IPC handlers for orchestrator commands.
 * Stubs: replace with actual orchestrator calls as pipeline core is built.
 */

export function registerIpcHandlers(): void {
  const resolveOutputDir = (): string =>
    process.env.ASTERIA_OUTPUT_DIR ?? path.join(process.cwd(), "pipeline-results");

  ipcMain.handle(
    "asteria:start-run",
    async (_event: IpcMainInvokeEvent, config: PipelineRunConfig): Promise<PipelineRunResult> => {
      validatePipelineRunConfig(config);
      if (config.pages.length === 0) {
        throw new Error("Cannot start run: no pages provided");
      }

      const projectRoot = resolveProjectRoot(config.pages);
      const outputDir = resolveOutputDir();
      const runId = await startRun(config, projectRoot, outputDir);
      const runDir = getRunDir(outputDir, runId);
      return {
        runId,
        runDir,
        status: "running",
        pagesProcessed: 0,
        errors: [],
        metrics: {},
      };
    }
  );

  ipcMain.handle(
    "asteria:analyze-corpus",
    async (_event: IpcMainInvokeEvent, config: PipelineRunConfig) => {
      validatePipelineRunConfig(config);
      return analyzeCorpus(config);
    }
  );

  ipcMain.handle(
    "asteria:scan-corpus",
    async (
      _event: IpcMainInvokeEvent,
      rootPath: string,
      options?: Parameters<typeof scanCorpus>[1]
    ) => {
      return scanCorpus(rootPath, options);
    }
  );

  ipcMain.handle("asteria:pick-corpus-dir", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return normalizeCorpusPath(result.filePaths[0]);
  });

  ipcMain.handle("asteria:list-projects", async (): Promise<ProjectSummary[]> => {
    return listProjects();
  });

  ipcMain.handle(
    "asteria:import-corpus",
    async (_event: IpcMainInvokeEvent, request: ImportCorpusRequest) => {
      validateImportCorpusRequest(request);
      return importCorpus(request);
    }
  );

  ipcMain.handle(
    "asteria:cancel-run",
    async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
      validateRunId(runId);
      await cancelRun(runId);
    }
  );

  ipcMain.handle(
    "asteria:pause-run",
    async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
      validateRunId(runId);
      await pauseRun(runId);
    }
  );

  ipcMain.handle(
    "asteria:resume-run",
    async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
      validateRunId(runId);
      await resumeRun(runId);
    }
  );

  ipcMain.handle(
    "asteria:fetch-page",
    async (_event: IpcMainInvokeEvent, runId: string, runDir: string, pageId: string) => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      validatePageId(pageId);
      const runSidecarPath = getRunSidecarPath(runDir, pageId);

      try {
        const raw = await fs.readFile(runSidecarPath, "utf-8");
        const sidecar = JSON.parse(raw) as { source?: { path?: string } };
        const originalPath = sidecar.source?.path ?? "";
        return {
          id: pageId,
          filename: path.basename(originalPath || pageId),
          originalPath,
          confidenceScores: {},
        };
      } catch {
        return {
          id: pageId,
          filename: `page-${pageId}.png`,
          originalPath: "",
          confidenceScores: {},
        };
      }
    }
  );

  ipcMain.handle(
    "asteria:fetch-sidecar",
    async (_event: IpcMainInvokeEvent, runId: string, runDir: string, pageId: string) => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      validatePageId(pageId);
      const runSidecarPath = getRunSidecarPath(runDir, pageId);
      try {
        const raw = await fs.readFile(runSidecarPath, "utf-8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  );

  ipcMain.handle(
    "asteria:apply-override",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      runDir: string,
      pageId: string,
      overrides: Record<string, unknown>
    ) => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      validatePageId(pageId);
      validateOverrides(overrides);
      const overridesDir = path.join(runDir, "overrides");
      await fs.mkdir(overridesDir, { recursive: true });
      const appliedAt = new Date().toISOString();
      const overridePath = path.join(overridesDir, `${pageId}.json`);
      await writeJsonAtomic(overridePath, {
        pageId,
        overrides,
        appliedAt,
      });
      const sidecarPath = getRunSidecarPath(runDir, pageId);
      try {
        const raw = await fs.readFile(sidecarPath, "utf-8");
        const sidecar = JSON.parse(raw) as Record<string, unknown>;
        const decisions =
          (sidecar.decisions && typeof sidecar.decisions === "object"
            ? (sidecar.decisions as Record<string, unknown>)
            : {}) ?? {};
        
        // Extract actual field paths from overrides (e.g., "normalization.cropBox", "normalization.rotationDeg")
        const overrideFieldPaths: string[] = [];
        const collectFieldPaths = (obj: Record<string, unknown>, prefix = ""): void => {
          for (const key of Object.keys(obj)) {
            const fullPath = prefix ? `${prefix}.${key}` : key;
            const value = obj[key];
            if (value && typeof value === "object" && !Array.isArray(value)) {
              collectFieldPaths(value as Record<string, unknown>, fullPath);
            } else {
              overrideFieldPaths.push(fullPath);
            }
          }
        };
        collectFieldPaths(overrides);
        
        await writeJsonAtomic(sidecarPath, {
          ...sidecar,
          overrides,
          decisions: {
            ...decisions,
            overrides: overrideFieldPaths,
            overrideAppliedAt: appliedAt,
          },
        });
      } catch {
        // ignore missing sidecar
      }
      const manifestPath = getRunManifestPath(runDir);
      try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as { pages?: Array<Record<string, unknown>> };
        if (Array.isArray(manifest.pages)) {
          manifest.pages = manifest.pages.map((page) =>
            page.pageId === pageId
              ? { ...page, overrides, overrideAppliedAt: appliedAt }
              : page
          );
          await writeJsonAtomic(manifestPath, manifest);
        }
      } catch {
        // ignore missing manifest
      }
    }
  );

  ipcMain.handle(
    "asteria:export-run",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      runDir: string,
      formats: ExportFormat[]
    ): Promise<string> => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      validateExportFormats(formats);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const exportDir = path.join(runDir, "exports", timestamp);
      await fs.mkdir(exportDir, { recursive: true });

      const manifestPath = getRunManifestPath(runDir);
      const reportPath = getRunReportPath(runDir);
      const reviewQueuePath = getRunReviewQueuePath(runDir);
      try {
        await fs.copyFile(manifestPath, path.join(exportDir, "manifest.json"));
      } catch {
        // ignore missing manifest
      }
      try {
        await fs.copyFile(reportPath, path.join(exportDir, "report.json"));
      } catch {
        // ignore missing report
      }
      try {
        await fs.copyFile(reviewQueuePath, path.join(exportDir, "review-queue.json"));
      } catch {
        // ignore missing review queue
      }

      const sidecarDir = getSidecarDir(runDir);
      const sidecarExportDir = path.join(exportDir, "sidecars");
      try {
        const sidecarFiles = await fs.readdir(sidecarDir);
        await fs.mkdir(sidecarExportDir, { recursive: true });
        await Promise.all(
          sidecarFiles.map((file) =>
            fs.copyFile(path.join(sidecarDir, file), path.join(sidecarExportDir, file))
          )
        );
      } catch {
        // ignore missing sidecars
      }

      const trainingDir = getTrainingDir(runDir);
      const trainingExportDir = path.join(exportDir, "training");
      try {
        const trainingFiles = await fs.readdir(trainingDir);
        await fs.mkdir(trainingExportDir, { recursive: true });
        await Promise.all(
          trainingFiles.map((file) =>
            fs.copyFile(path.join(trainingDir, file), path.join(trainingExportDir, file))
          )
        );
      } catch {
        // ignore missing training signals
      }

      const normalizedDir = getNormalizedDir(runDir);
      let normalizedFiles: string[] = [];
      try {
        normalizedFiles = await fs.readdir(normalizedDir);
      } catch {
        normalizedFiles = [];
      }

      await Promise.all(
        formats.map((format) =>
          exportNormalizedByFormat({ format, exportDir, normalizedDir, normalizedFiles })
        )
      );

      return exportDir;
    }
  );

  ipcMain.handle(
    "asteria:get-pipeline-config",
    async (_event: IpcMainInvokeEvent, projectId?: string): Promise<PipelineConfigSnapshot> => {
      const { config: baseConfig, configPath, loadedFromFile } = await loadPipelineConfig();
      const projectOverrides = projectId ? await loadProjectOverrides(projectId) : {};
      const { resolvedConfig, sources } = resolvePipelineConfig(baseConfig, {
        overrides: projectOverrides.overrides ?? {},
        env: process.env,
        configPath,
        loadedFromFile,
        projectConfigPath: projectOverrides.configPath,
        projectOverrides: projectOverrides.overrides,
      });
      return { baseConfig, resolvedConfig, sources };
    }
  );

  ipcMain.handle(
    "asteria:save-project-config",
    async (
      _event: IpcMainInvokeEvent,
      projectId: string,
      overrides: PipelineConfigOverrides
    ): Promise<void> => {
      if (!projectId || typeof projectId !== "string") {
        throw new Error("Invalid project id");
      }
      validateOverrides(overrides as Record<string, unknown>);
      const projectRoot = path.join(process.cwd(), "projects", projectId);
      await fs.mkdir(projectRoot, { recursive: true });
      const overridePath = path.join(projectRoot, "pipeline.config.json");
      if (Object.keys(overrides).length === 0) {
        await fs.rm(overridePath, { force: true });
        return;
      }
      await fs.writeFile(overridePath, JSON.stringify(overrides, null, 2));
    }
  );

  ipcMain.handle(
    "asteria:get-run-config",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      runDir: string
    ): Promise<RunConfigSnapshot | null> => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      const reportPath = getRunReportPath(runDir);

      try {
        const raw = await fs.readFile(reportPath, "utf-8");
        const report = JSON.parse(raw) as { configSnapshot?: RunConfigSnapshot };
        return report.configSnapshot ?? null;
      } catch {
        return null;
      }
    }
  );

  ipcMain.handle(
    "asteria:get-run-manifest",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      runDir: string
    ): Promise<RunManifestSummary | null> => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      const manifestPath = getRunManifestPath(runDir);
      try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as RunManifestSummary;
        return {
          runId: manifest.runId ?? runId,
          status: manifest.status ?? "unknown",
          exportedAt: manifest.exportedAt ?? "",
          sourceRoot: manifest.sourceRoot ?? "",
          count: typeof manifest.count === "number" ? manifest.count : 0,
        };
      } catch {
        return null;
      }
    }
  );

  ipcMain.handle("asteria:list-runs", async (): Promise<RunSummary[]> => {
    const outputDir = resolveOutputDir();
    const indexPath = path.join(outputDir, "run-index.json");
    try {
      const raw = await fs.readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        runs?: Array<Omit<RunSummary, "runDir"> & { reviewQueuePath?: string }>;
      };
      if (Array.isArray(parsed.runs)) {
        return parsed.runs.map((run) => ({
          runId: run.runId,
          runDir: getRunDir(outputDir, run.runId),
          projectId: run.projectId,
          generatedAt: run.generatedAt,
          reviewCount: run.reviewCount ?? 0,
          status: run.status,
          startedAt: run.startedAt,
          updatedAt: run.updatedAt,
          reportPath: run.reportPath,
          inferredDimensionsMm: run.inferredDimensionsMm,
          inferredDpi: run.inferredDpi,
          dimensionConfidence: run.dimensionConfidence,
          dpiConfidence: run.dpiConfidence,
        }));
      }
    } catch {
      return [];
    }
    return [];
  });

  ipcMain.handle(
    "asteria:fetch-review-queue",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      runDir: string
    ): Promise<ReviewQueue> => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      const reviewPath = getRunReviewQueuePath(runDir);
      try {
        const data = await fs.readFile(reviewPath, "utf-8");
        return JSON.parse(data) as ReviewQueue;
      } catch {
        return {
          runId,
          projectId: "unknown",
          generatedAt: new Date().toISOString(),
          items: [],
        };
      }
    }
  );

  ipcMain.handle(
    "asteria:submit-review",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      runDir: string,
      decisions: ReviewDecision[]
    ): Promise<void> => {
      validateRunId(runId);
      validateRunDir(runDir, runId);
      validateOverrides({ decisions });
      const reviewDir = path.join(runDir, "reviews");
      await fs.mkdir(reviewDir, { recursive: true });
      const reviewPath = path.join(reviewDir, `${runId}.json`);
      const submittedAt = new Date().toISOString();
      await writeJsonAtomic(reviewPath, {
        runId,
        submittedAt,
        decisions,
      });

      const trainingDir = getTrainingDir(runDir);
      await fs.mkdir(trainingDir, { recursive: true });

      const trainingSignals: Array<Record<string, unknown>> = [];

      for (const decision of decisions) {
        const pageId = decision.pageId;
        if (!pageId) continue;
        const sidecarPath = getRunSidecarPath(runDir, pageId);
        const overridePath = path.join(runDir, "overrides", `${pageId}.json`);

        let sidecar: Record<string, unknown> | null = null;
        try {
          const raw = await fs.readFile(sidecarPath, "utf-8");
          sidecar = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          sidecar = null;
        }

        let overrideRecord: { overrides?: Record<string, unknown>; appliedAt?: string } | null = null;
        try {
          const raw = await fs.readFile(overridePath, "utf-8");
          overrideRecord = JSON.parse(raw) as { overrides?: Record<string, unknown>; appliedAt?: string };
        } catch {
          overrideRecord = null;
        }

        const overrides =
          (decision.overrides as Record<string, unknown> | undefined) ??
          overrideRecord?.overrides ??
          (sidecar?.overrides as Record<string, unknown> | undefined) ??
          null;
        const appliedAt = overrideRecord?.appliedAt ?? submittedAt;
        const adjustments = buildAdjustmentSummary({ sidecar, overrides, appliedAt });
        const autoBaselineGrid = readAutoBaselineGrid(sidecar);
        const overrideBaselineGrid = readBaselineGridOverride(overrides ?? undefined);
        const finalBaselineGrid = mergeBaselineGridGuides(autoBaselineGrid, overrideBaselineGrid);
        const deltaBaselineGrid = buildBaselineGridDelta(autoBaselineGrid, finalBaselineGrid);
        const confirmed = Boolean(finalBaselineGrid?.markCorrect ?? false);
        const provenance = {
          source: "review",
          runId,
          pageId,
          submittedAt,
          appliedAt,
          decision: decision.decision,
        };
        const autoPayload = autoBaselineGrid ? { guides: { baselineGrid: autoBaselineGrid } } : null;
        const finalPayload = finalBaselineGrid ? { guides: { baselineGrid: finalBaselineGrid } } : null;
        const deltaPayload = deltaBaselineGrid ? { guides: { baselineGrid: deltaBaselineGrid } } : null;

        if (sidecar && adjustments) {
          await writeJsonAtomic(sidecarPath, {
            ...sidecar,
            adjustments,
          });
        }

        const safePageId = pageId.replace(/[\\/]/g, "_");
        const trainingSignal = {
          runId,
          pageId,
          decision: decision.decision,
          notes: decision.notes,
          submittedAt,
          appliedAt,
          adjustments: adjustments ?? undefined,
          overrides: overrides ?? undefined,
          sidecarPath: `sidecars/${pageId}.json`,
          auto: autoPayload,
          final: finalPayload,
          delta: deltaPayload,
          confirmed,
          provenance,
        };
        trainingSignals.push(trainingSignal);
        await writeJsonAtomic(path.join(trainingDir, `${safePageId}.json`), trainingSignal);
      }

      await writeJsonAtomic(path.join(trainingDir, "manifest.json"), {
        runId,
        submittedAt,
        count: trainingSignals.length,
        signals: trainingSignals,
      });
    }
  );
}

const resolveProjectRoot = (pages: PageData[]): string => {
  const directories = pages.map((page) => path.dirname(path.resolve(page.originalPath)));
  if (directories.length === 0) return process.cwd();
  const splitPaths = directories.map((dir) => dir.split(path.sep));
  const minSegments = Math.min(...splitPaths.map((segments) => segments.length));
  const commonSegments: string[] = [];

  for (let index = 0; index < minSegments; index++) {
    const segment = splitPaths[0][index];
    if (splitPaths.every((parts) => parts[index] === segment)) {
      commonSegments.push(segment);
    } else {
      break;
    }
  }

  if (commonSegments.length === 0) return directories[0];
  return commonSegments.join(path.sep);
};
