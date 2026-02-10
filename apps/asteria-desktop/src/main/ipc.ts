import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
  TemplateTrainingSignal,
  AppPreferences,
  IpcErrorPayload,
  IpcResult,
} from "../ipc/contracts.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  validateAppPreferencesUpdate,
  validateExportFormats,
  validateImportCorpusRequest,
  validateOverrides,
  validatePageLayoutOverrides,
  validatePageId,
  validatePipelineConfigOverrides,
  validatePipelineRunConfig,
  validateProjectId,
  validateReviewDecisions,
  validateRevealPath,
  validateRunHistoryCleanupOptions,
  validateRunId,
  validateTemplateTrainingSignal,
} from "../ipc/validation.js";
import { analyzeCorpus } from "../ipc/corpusAnalysis.js";
import { scanCorpus } from "../ipc/corpusScanner.js";
import {
  startRun,
  cancelRun,
  cancelRunAndDelete,
  clearRunHistory,
  deleteRunArtifacts,
  pauseRun,
  resumeRun,
} from "./run-manager.js";
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
  getRunNormalizedDir,
  getSidecarDir,
  getTrainingDir,
  getTrainingGuidesDir,
} from "./run-paths.js";
import { resolveConcurrency, runWithConcurrency, writeJsonAtomic } from "./file-utils.js";
import { getAppInfo } from "./app-info.js";
import { createDiagnosticsBundle } from "./diagnostics.js";
import {
  loadPreferences,
  resolveOutputDir,
  resolveProjectsRoot,
  savePreferences,
  getAsteriaRoot,
} from "./preferences.js";
import { importCorpus, listProjects, normalizeCorpusPath } from "./projects.js";
import { provisionSampleCorpus } from "./sample-corpus.js";

type ExportFormat = "png" | "tiff" | "pdf";

const isDev = !app.isPackaged || process.env.NODE_ENV === "development";
const DEFAULT_IO_CONCURRENCY = 6;
const getIoConcurrency = (): number =>
  resolveConcurrency(process.env.ASTERIA_IO_CONCURRENCY, DEFAULT_IO_CONCURRENCY, 32);

const buildIpcError = (error: unknown, context: string): IpcErrorPayload => {
  const message = error instanceof Error && error.message ? error.message : "Request failed";
  const detail = isDev && error instanceof Error && error.stack ? error.stack : undefined;
  const code = error instanceof Error && error.name ? error.name : undefined;
  console.error(`[ipc] ${context} failed`, error);
  return { message, detail, code };
};

const resolveRealOrNormalizedPath = async (candidate: string): Promise<string> => {
  const normalized = path.resolve(candidate);
  try {
    return await fs.realpath(normalized);
  } catch {
    return normalized;
  }
};

const resolveTargetPathForContainment = async (targetPath: string): Promise<string | null> => {
  const normalized = path.resolve(targetPath);
  try {
    return await fs.realpath(normalized);
  } catch {
    const parent = path.dirname(normalized);
    try {
      const parentReal = await fs.realpath(parent);
      return path.join(parentReal, path.basename(normalized));
    } catch {
      return null;
    }
  }
};

const resolveAllowedRoots = async (): Promise<string[]> => {
  const prefs = await loadPreferences();
  const legacyOutputDir = isDev ? path.join(process.cwd(), "pipeline-results") : undefined;
  const roots = [
    app.getPath("logs"),
    getAsteriaRoot(app.getPath("userData")),
    prefs.outputDir,
    prefs.projectsDir,
    legacyOutputDir,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);

  const realRoots = new Set<string>();
  for (const root of roots) {
    realRoots.add(await resolveRealOrNormalizedPath(root));
  }
  return [...realRoots];
};

const isPathWithinRoots = (targetRealPath: string, roots: string[]): boolean => {
  const entries = roots.map((root) => ({
    root,
    rootWithSep: root.endsWith(path.sep) ? root : `${root}${path.sep}`,
  }));
  return entries.some(
    ({ root, rootWithSep }) => targetRealPath === root || targetRealPath.startsWith(rootWithSep)
  );
};

const wrapIpcHandler =
  <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
  ) =>
  async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<IpcResult<TResult>> => {
    try {
      const value = await handler(event, ...args);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: buildIpcError(error, channel) };
    }
  };

export const buildBundleFileUrl = (filePath: string, pathModule: typeof path = path): string =>
  pathToFileURL(pathModule.resolve(filePath)).toString();

const readTemplateSignals = async (
  templateDir: string
): Promise<Array<Record<string, unknown>>> => {
  const templateSignals: Array<Record<string, unknown>> = [];
  try {
    const templateFiles = await fs.readdir(templateDir);
    for (const file of templateFiles) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(templateDir, file), "utf-8");
        templateSignals.push(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        console.warn(`Failed to parse template signal ${file}`, error);
      }
    }
  } catch (error) {
    console.warn(`Failed to read template signals at ${templateDir}`, error);
  }
  return templateSignals;
};

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

  await runWithConcurrency(sourceFiles, getIoConcurrency(), async (file) => {
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
  });
};

const sanitizeTrainingId = (value: string): string => value.replaceAll(/[\\/]/g, "_");

const loadRunDeterminism = async (
  runDir: string
): Promise<{ appVersion: string; configHash: string }> => {
  const reportPath = getRunReportPath(runDir);
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    const report = JSON.parse(raw) as {
      determinism?: { appVersion?: string; configHash?: string };
    };
    return {
      appVersion: report.determinism?.appVersion ?? "unknown",
      configHash: report.determinism?.configHash ?? "unknown",
    };
  } catch (error) {
    console.warn(`Failed to load determinism report at ${reportPath}`, error);
    return { appVersion: "unknown", configHash: "unknown" };
  }
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

type GuideTrainingHint = {
  runId: string;
  pageId: string;
  templateId?: string | null;
  pageType?: string | null;
  appliedAt: string;
  effective: {
    baselineGrid?: BaselineGridGuide | null;
    margins?: { topPx?: number; rightPx?: number; bottomPx?: number; leftPx?: number } | null;
    columns?: { count?: number; leftPx?: number; rightPx?: number; gutterPx?: number } | null;
    headerBand?: { startPx?: number; endPx?: number } | null;
    footerBand?: { startPx?: number; endPx?: number } | null;
    gutterBand?: { startPx?: number; endPx?: number } | null;
  };
  changedByUser: {
    baselineGrid: boolean;
    margins: boolean;
    columns: boolean;
    bands: boolean;
  };
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isGuideLine = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const readLayerGuides = (
  sidecar: Record<string, unknown> | null,
  layerId: string
): Array<Record<string, unknown>> => {
  if (!sidecar || typeof sidecar !== "object") return [];
  const guides =
    "guides" in sidecar && sidecar.guides && typeof sidecar.guides === "object"
      ? (sidecar.guides as Record<string, unknown>)
      : null;
  const layers = guides && Array.isArray(guides.layers) ? guides.layers : [];
  const layer = layers.find(
    (entry) => entry && typeof entry === "object" && "id" in entry && entry.id === layerId
  ) as Record<string, unknown> | undefined;
  const layerGuides = layer && Array.isArray(layer.guides) ? layer.guides : [];
  return layerGuides.filter(isGuideLine);
};

const getGuidePositions = (
  guides: Array<Record<string, unknown>>,
  axis: "x" | "y",
  role?: string
): number[] => {
  const filtered = guides.filter((guide) => {
    if (guide.axis !== axis) return false;
    if (role && guide.role !== role) return false;
    return isFiniteNumber(guide.position);
  });
  return filtered.map((guide) => guide.position as number).sort((a, b) => a - b);
};

const buildGuideTrainingHint = (params: {
  runId: string;
  pageId: string;
  appliedAt: string;
  sidecar: Record<string, unknown> | null;
  finalBaselineGrid: BaselineGridGuide | null;
  overrides: Record<string, unknown> | null;
}): GuideTrainingHint | null => {
  const { runId, pageId, appliedAt, sidecar, finalBaselineGrid, overrides } = params;
  if (!sidecar) return null;
  const guideOverrides =
    overrides && typeof overrides === "object" && "guides" in overrides
      ? (overrides.guides as Record<string, unknown> | null)
      : null;

  const marginGuides = readLayerGuides(sidecar, "margin-guides");
  const columnGuides = readLayerGuides(sidecar, "column-guides");
  const headerFooterGuides = readLayerGuides(sidecar, "header-footer-bands");
  const gutterGuides = readLayerGuides(sidecar, "gutter-bands");

  const marginsX = getGuidePositions(marginGuides, "x");
  const marginsY = getGuidePositions(marginGuides, "y");
  const margins =
    marginsX.length >= 2 || marginsY.length >= 2
      ? {
          leftPx: marginsX[0],
          rightPx: marginsX[marginsX.length - 1],
          topPx: marginsY[0],
          bottomPx: marginsY[marginsY.length - 1],
        }
      : null;

  const columnsX = getGuidePositions(columnGuides, "x");
  const columns =
    columnsX.length >= 2
      ? {
          count: 2,
          leftPx: columnsX[0],
          rightPx: columnsX[columnsX.length - 1],
          gutterPx: columnsX[columnsX.length - 1] - columnsX[0],
        }
      : null;

  const headerPositions = getGuidePositions(headerFooterGuides, "y", "header-band");
  const footerPositions = getGuidePositions(headerFooterGuides, "y", "footer-band");
  const headerBand =
    headerPositions.length >= 2
      ? { startPx: headerPositions[0], endPx: headerPositions[headerPositions.length - 1] }
      : null;
  const footerBand =
    footerPositions.length >= 2
      ? { startPx: footerPositions[0], endPx: footerPositions[footerPositions.length - 1] }
      : null;

  const gutterPositions = getGuidePositions(gutterGuides, "x");
  const gutterBand =
    gutterPositions.length >= 2
      ? { startPx: gutterPositions[0], endPx: gutterPositions[gutterPositions.length - 1] }
      : null;

  const changedByUser = {
    baselineGrid: Boolean(
      guideOverrides && typeof guideOverrides === "object" && "baselineGrid" in guideOverrides
    ),
    margins: Boolean(
      guideOverrides && typeof guideOverrides === "object" && "margins" in guideOverrides
    ),
    columns: Boolean(
      guideOverrides && typeof guideOverrides === "object" && "columns" in guideOverrides
    ),
    bands: Boolean(
      guideOverrides &&
      typeof guideOverrides === "object" &&
      ("headerBand" in guideOverrides ||
        "footerBand" in guideOverrides ||
        "gutterBand" in guideOverrides)
    ),
  };

  return {
    runId,
    pageId,
    templateId:
      typeof sidecar.templateId === "string" ? sidecar.templateId : (sidecar.templateId as null),
    pageType: typeof sidecar.pageType === "string" ? sidecar.pageType : null,
    appliedAt,
    effective: {
      baselineGrid: finalBaselineGrid,
      margins,
      columns,
      headerBand,
      footerBand,
      gutterBand,
    },
    changedByUser,
  };
};

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
    if (
      element &&
      typeof element === "object" &&
      "id" in element &&
      typeof element.id === "string"
    ) {
      baseMap.set(element.id, element as Record<string, unknown>);
    }
  }
  const overrideMap = new Map<string, Record<string, unknown>>();
  for (const element of overrideElements) {
    if (
      element &&
      typeof element === "object" &&
      "id" in element &&
      typeof element.id === "string"
    ) {
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
  if (isFiniteNumber(spacingRaw) || spacingRaw === null)
    result.spacingPx = spacingRaw as number | null;
  if (isFiniteNumber(offsetRaw) || offsetRaw === null) result.offsetPx = offsetRaw as number | null;
  if (isFiniteNumber(angleRaw) || angleRaw === null) result.angleDeg = angleRaw as number | null;
  if (typeof snapRaw === "boolean") result.snapToPeaks = snapRaw;
  if (typeof markRaw === "boolean") result.markCorrect = markRaw;

  return Object.keys(result).length > 0 ? result : null;
};

const readAutoBaselineGrid = (
  sidecar: Record<string, unknown> | null
): BaselineGridGuide | null => {
  if (!sidecar || typeof sidecar !== "object") return null;
  const bookModel =
    "bookModel" in sidecar && sidecar.bookModel && typeof sidecar.bookModel === "object"
      ? (sidecar.bookModel as Record<string, unknown>)
      : null;
  const baselineModel =
    bookModel &&
    "baselineGrid" in bookModel &&
    bookModel.baselineGrid &&
    typeof bookModel.baselineGrid === "object"
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
  const angle =
    normalization && isFiniteNumber(normalization.skewAngle) ? normalization.skewAngle : null;

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
    snapToPeaks: override?.snapToPeaks ?? auto?.snapToPeaks,
    markCorrect: override?.markCorrect ?? auto?.markCorrect,
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
  if (typeof final.snapToPeaks === "boolean" && final.snapToPeaks !== auto.snapToPeaks) {
    result.snapToPeaks = final.snapToPeaks;
  }
  if (typeof final.markCorrect === "boolean" && final.markCorrect !== auto.markCorrect) {
    result.markCorrect = final.markCorrect;
  }

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
  const resolveTrustedRunDir = async (runId: string): Promise<string> => {
    validateRunId(runId);
    const outputDir = await resolveOutputDir();
    return getRunDir(outputDir, runId);
  };

  ipcMain.handle(
    "asteria:get-app-preferences",
    wrapIpcHandler("asteria:get-app-preferences", async (): Promise<unknown> => {
      return loadPreferences();
    })
  );

  ipcMain.handle(
    "asteria:set-app-preferences",
    wrapIpcHandler(
      "asteria:set-app-preferences",
      async (_event: IpcMainInvokeEvent, prefs: Record<string, unknown>) => {
        validateAppPreferencesUpdate(prefs as Record<string, unknown>);
        return savePreferences(prefs as Partial<AppPreferences>);
      }
    )
  );

  ipcMain.handle(
    "asteria:get-app-info",
    wrapIpcHandler("asteria:get-app-info", async (): Promise<unknown> => getAppInfo())
  );

  ipcMain.handle(
    "asteria:provision-sample-corpus",
    wrapIpcHandler(
      "asteria:provision-sample-corpus",
      async (): Promise<{ projectId: string; inputPath: string }> => provisionSampleCorpus()
    )
  );

  ipcMain.handle(
    "asteria:create-diagnostics-bundle",
    wrapIpcHandler(
      "asteria:create-diagnostics-bundle",
      async (): Promise<{ bundlePath: string }> => createDiagnosticsBundle()
    )
  );

  ipcMain.handle(
    "asteria:reveal-path",
    wrapIpcHandler(
      "asteria:reveal-path",
      async (_event: IpcMainInvokeEvent, targetPath: string): Promise<void> => {
        validateRevealPath(targetPath);
        const resolvedPath = targetPath === "logs" ? app.getPath("logs") : targetPath;

        const allowedRoots = await resolveAllowedRoots();
        const resolvedRealPath = await resolveTargetPathForContainment(resolvedPath);

        if (!resolvedRealPath || !isPathWithinRoots(resolvedRealPath, allowedRoots)) {
          throw new Error("Reveal path is outside allowed roots");
        }
        try {
          const stats = await fs.stat(resolvedRealPath);
          if (stats.isDirectory()) {
            await shell.openPath(resolvedRealPath);
            return;
          }
        } catch (error) {
          console.warn("[ipc] reveal-path stat failed", error);
        }
        shell.showItemInFolder(resolvedRealPath);
      }
    )
  );

  ipcMain.handle(
    "asteria:start-run",
    wrapIpcHandler(
      "asteria:start-run",
      async (_event: IpcMainInvokeEvent, config: PipelineRunConfig): Promise<PipelineRunResult> => {
        validatePipelineRunConfig(config);
        if (config.pages.length === 0) {
          throw new Error("Cannot start run: no pages provided");
        }

        const projectRoot = resolveProjectRoot(config.pages);
        const outputDir = await resolveOutputDir();
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
    )
  );

  ipcMain.handle(
    "asteria:analyze-corpus",
    wrapIpcHandler(
      "asteria:analyze-corpus",
      async (_event: IpcMainInvokeEvent, config: PipelineRunConfig) => {
        validatePipelineRunConfig(config);
        return analyzeCorpus(config);
      }
    )
  );

  ipcMain.handle(
    "asteria:scan-corpus",
    wrapIpcHandler(
      "asteria:scan-corpus",
      async (
        _event: IpcMainInvokeEvent,
        rootPath: string,
        options?: Parameters<typeof scanCorpus>[1]
      ) => {
        return scanCorpus(rootPath, options);
      }
    )
  );

  ipcMain.handle(
    "asteria:pick-corpus-dir",
    wrapIpcHandler("asteria:pick-corpus-dir", async (): Promise<string | null> => {
      const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(parentWindow ?? undefined, {
        properties: ["openDirectory", "openFile"],
        filters: [
          { name: "Corpus files", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "pdf"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return normalizeCorpusPath(result.filePaths[0]);
    })
  );

  ipcMain.handle(
    "asteria:list-projects",
    wrapIpcHandler("asteria:list-projects", async (): Promise<ProjectSummary[]> => {
      return listProjects();
    })
  );

  ipcMain.handle(
    "asteria:import-corpus",
    wrapIpcHandler(
      "asteria:import-corpus",
      async (_event: IpcMainInvokeEvent, request: ImportCorpusRequest) => {
        validateImportCorpusRequest(request);
        return importCorpus(request);
      }
    )
  );

  ipcMain.handle(
    "asteria:cancel-run",
    wrapIpcHandler(
      "asteria:cancel-run",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
        validateRunId(runId);
        await cancelRun(runId);
      }
    )
  );

  ipcMain.handle(
    "asteria:cancel-run-and-delete",
    wrapIpcHandler(
      "asteria:cancel-run-and-delete",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
        validateRunId(runId);
        await cancelRunAndDelete(runId);
      }
    )
  );

  ipcMain.handle(
    "asteria:pause-run",
    wrapIpcHandler(
      "asteria:pause-run",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
        validateRunId(runId);
        await pauseRun(runId);
      }
    )
  );

  ipcMain.handle(
    "asteria:resume-run",
    wrapIpcHandler(
      "asteria:resume-run",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
        validateRunId(runId);
        await resumeRun(runId);
      }
    )
  );

  ipcMain.handle(
    "asteria:fetch-page",
    wrapIpcHandler(
      "asteria:fetch-page",
      async (_event: IpcMainInvokeEvent, runId: string, pageId: string) => {
        const runDir = await resolveTrustedRunDir(runId);
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
        } catch (error) {
          console.warn("[ipc] fetch-page missing sidecar", { runId, pageId, error });
          return {
            id: pageId,
            filename: `page-${pageId}.png`,
            originalPath: "",
            confidenceScores: {},
          };
        }
      }
    )
  );

  ipcMain.handle(
    "asteria:fetch-sidecar",
    wrapIpcHandler(
      "asteria:fetch-sidecar",
      async (_event: IpcMainInvokeEvent, runId: string, pageId: string) => {
        const runDir = await resolveTrustedRunDir(runId);
        validatePageId(pageId);
        const runSidecarPath = getRunSidecarPath(runDir, pageId);
        try {
          const raw = await fs.readFile(runSidecarPath, "utf-8");
          return JSON.parse(raw);
        } catch (error) {
          console.warn("[ipc] fetch-sidecar missing", { runId, pageId, error });
          return null;
        }
      }
    )
  );

  ipcMain.handle(
    "asteria:apply-override",
    wrapIpcHandler(
      "asteria:apply-override",
      async (
        _event: IpcMainInvokeEvent,
        runId: string,
        pageId: string,
        overrides: Record<string, unknown>
      ) => {
        const runDir = await resolveTrustedRunDir(runId);
        validatePageId(pageId);
        validatePageLayoutOverrides(overrides);
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
        } catch (error) {
          console.warn("[ipc] apply-override sidecar update failed", { runId, pageId, error });
        }
        const manifestPath = getRunManifestPath(runDir);
        try {
          const raw = await fs.readFile(manifestPath, "utf-8");
          const manifest = JSON.parse(raw) as { pages?: Array<Record<string, unknown>> };
          if (Array.isArray(manifest.pages)) {
            manifest.pages = manifest.pages.map((page) =>
              page.pageId === pageId ? { ...page, overrides, overrideAppliedAt: appliedAt } : page
            );
            await writeJsonAtomic(manifestPath, manifest);
          }
        } catch (error) {
          console.warn("[ipc] apply-override manifest update failed", { runId, pageId, error });
        }
      }
    )
  );

  ipcMain.handle(
    "asteria:export-run",
    wrapIpcHandler(
      "asteria:export-run",
      async (
        _event: IpcMainInvokeEvent,
        runId: string,
        formats: ExportFormat[]
      ): Promise<string> => {
        const runDir = await resolveTrustedRunDir(runId);
        validateExportFormats(formats);
        const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
        const exportDir = path.join(runDir, "exports", timestamp);
        await fs.mkdir(exportDir, { recursive: true });

        const warnings: string[] = [];

        const manifestPath = getRunManifestPath(runDir);
        const reportPath = getRunReportPath(runDir);
        const reviewQueuePath = getRunReviewQueuePath(runDir);
        try {
          await fs.copyFile(manifestPath, path.join(exportDir, "manifest.json"));
        } catch (err) {
          warnings.push(`Failed to copy manifest: ${err}`);
        }
        try {
          await fs.copyFile(reportPath, path.join(exportDir, "report.json"));
        } catch (err) {
          warnings.push(`Failed to copy report: ${err}`);
        }
        try {
          await fs.copyFile(reviewQueuePath, path.join(exportDir, "review-queue.json"));
        } catch (err) {
          warnings.push(`Failed to copy review queue: ${err}`);
        }

        const sidecarDir = getSidecarDir(runDir);
        const sidecarExportDir = path.join(exportDir, "sidecars");
        try {
          const sidecarFiles = await fs.readdir(sidecarDir);
          await fs.mkdir(sidecarExportDir, { recursive: true });
          await runWithConcurrency(sidecarFiles, getIoConcurrency(), async (file) => {
            await fs
              .copyFile(
                path.join(sidecarDir, path.basename(file)),
                path.join(sidecarExportDir, path.basename(file))
              )
              .catch((err) => {
                warnings.push(`Failed to copy sidecar ${file}: ${err}`);
              });
          });
        } catch (err) {
          warnings.push(`Failed to read sidecar directory: ${err}`);
        }

        const trainingDir = getTrainingDir(runDir);
        const trainingExportDir = path.join(exportDir, "training");
        try {
          await fs.cp(trainingDir, trainingExportDir, { recursive: true });
        } catch (err) {
          warnings.push(`Failed to copy training directory: ${err}`);
        }

        const normalizedDir = getRunNormalizedDir(runDir);
        let normalizedFiles: string[] = [];
        try {
          normalizedFiles = await fs.readdir(normalizedDir);
        } catch (err) {
          warnings.push(`Failed to read normalized directory: ${err}`);
          normalizedFiles = [];
        }

        try {
          await runWithConcurrency(formats, getIoConcurrency(), async (format) => {
            await exportNormalizedByFormat({
              format,
              exportDir,
              normalizedDir,
              normalizedFiles,
            }).catch((err) => {
              warnings.push(`Failed to export format ${format}: ${err}`);
            });
          });
        } catch (err) {
          warnings.push(`Format export failed: ${err}`);
        }

        if (warnings.length > 0) {
          console.warn(`Export completed with warnings for runId ${runId}:`, warnings);
        }

        return exportDir;
      }
    )
  );

  ipcMain.handle(
    "asteria:get-pipeline-config",
    wrapIpcHandler(
      "asteria:get-pipeline-config",
      async (_event: IpcMainInvokeEvent, projectId?: string): Promise<PipelineConfigSnapshot> => {
        if (projectId !== undefined) {
          validateProjectId(projectId);
        }
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
    )
  );

  ipcMain.handle(
    "asteria:save-project-config",
    wrapIpcHandler(
      "asteria:save-project-config",
      async (
        _event: IpcMainInvokeEvent,
        projectId: string,
        overrides: PipelineConfigOverrides
      ): Promise<void> => {
        validateProjectId(projectId);
        validatePipelineConfigOverrides(overrides as Record<string, unknown>);
        const projectsRoot = await resolveProjectsRoot();
        const projectRoot = path.join(projectsRoot, projectId);
        const relativeProjectRoot = path.relative(projectsRoot, projectRoot);
        if (
          relativeProjectRoot.startsWith("..") ||
          path.isAbsolute(relativeProjectRoot) ||
          relativeProjectRoot === ""
        ) {
          throw new Error("Invalid project id: outside projects directory");
        }
        await fs.mkdir(projectRoot, { recursive: true });
        const overridePath = path.join(projectRoot, "pipeline.config.json");
        if (Object.keys(overrides).length === 0) {
          await fs.rm(overridePath, { force: true });
          return;
        }
        await fs.writeFile(overridePath, JSON.stringify(overrides, null, 2));
      }
    )
  );

  ipcMain.handle(
    "asteria:get-run-config",
    wrapIpcHandler(
      "asteria:get-run-config",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<RunConfigSnapshot | null> => {
        const runDir = await resolveTrustedRunDir(runId);
        const reportPath = getRunReportPath(runDir);

        try {
          const raw = await fs.readFile(reportPath, "utf-8");
          const report = JSON.parse(raw) as { configSnapshot?: RunConfigSnapshot };
          return report.configSnapshot ?? null;
        } catch (error) {
          console.warn("[ipc] get-run-config failed", { runId, error });
          return null;
        }
      }
    )
  );

  ipcMain.handle(
    "asteria:get-run-manifest",
    wrapIpcHandler(
      "asteria:get-run-manifest",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<RunManifestSummary | null> => {
        const runDir = await resolveTrustedRunDir(runId);
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
        } catch (error) {
          console.warn("[ipc] get-run-manifest failed", { runId, error });
          return null;
        }
      }
    )
  );

  ipcMain.handle(
    "asteria:list-runs",
    wrapIpcHandler("asteria:list-runs", async (): Promise<RunSummary[]> => {
      const outputDir = await resolveOutputDir();
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
      } catch (error) {
        console.warn("[ipc] list-runs failed", error);
        return [];
      }
      return [];
    })
  );

  ipcMain.handle(
    "asteria:delete-run",
    wrapIpcHandler("asteria:delete-run", async (_event: IpcMainInvokeEvent, runId: string) => {
      validateRunId(runId);
      const outputDir = await resolveOutputDir();
      await deleteRunArtifacts(outputDir, runId);
    })
  );

  ipcMain.handle(
    "asteria:clear-run-history",
    wrapIpcHandler(
      "asteria:clear-run-history",
      async (
        _event: IpcMainInvokeEvent,
        options?: { removeArtifacts?: boolean }
      ): Promise<{ removedRuns: number; removedArtifacts: boolean }> => {
        validateRunHistoryCleanupOptions(options);
        const outputDir = await resolveOutputDir();
        return clearRunHistory(outputDir, options);
      }
    )
  );

  ipcMain.handle(
    "asteria:fetch-review-queue",
    wrapIpcHandler(
      "asteria:fetch-review-queue",
      async (_event: IpcMainInvokeEvent, runId: string): Promise<ReviewQueue> => {
        const runDir = await resolveTrustedRunDir(runId);
        const reviewPath = getRunReviewQueuePath(runDir);
        try {
          const data = await fs.readFile(reviewPath, "utf-8");
          const queue = JSON.parse(data) as ReviewQueue;
          return {
            ...queue,
            items: queue.items.map((item) => ({
              ...item,
              previews: item.previews?.map((preview) => {
                if (!preview.path || path.isAbsolute(preview.path)) return preview;
                return {
                  ...preview,
                  path: path.join(runDir, preview.path),
                };
              }),
            })),
          };
        } catch (error) {
          console.warn("[ipc] fetch-review-queue failed", { runId, error });
          return {
            runId,
            projectId: "unknown",
            generatedAt: new Date().toISOString(),
            items: [],
          };
        }
      }
    )
  );

  ipcMain.handle(
    "asteria:record-template-training",
    wrapIpcHandler(
      "asteria:record-template-training",
      async (_event: IpcMainInvokeEvent, runId: string, signal: Record<string, unknown>) => {
        const runDir = await resolveTrustedRunDir(runId);
        validateTemplateTrainingSignal(signal as unknown as TemplateTrainingSignal);
        const trainingDir = getTrainingDir(runDir);
        const templateDir = path.join(trainingDir, "template");
        await fs.mkdir(templateDir, { recursive: true });
        const templateId = typeof signal.templateId === "string" ? signal.templateId : "unknown";
        const safeTemplateId = templateId.replaceAll(/[\\/:*?"<>|]/g, "_");
        const payload = {
          runId,
          ...signal,
          appliedAt: signal.appliedAt as string,
        };
        const filename = `${safeTemplateId}-${Date.now()}-${randomUUID()}.json`;
        await writeJsonAtomic(path.join(templateDir, filename), payload);
      }
    )
  );

  ipcMain.handle(
    "asteria:submit-review",
    wrapIpcHandler(
      "asteria:submit-review",
      async (
        _event: IpcMainInvokeEvent,
        runId: string,
        decisions: ReviewDecision[]
      ): Promise<void> => {
        const runDir = await resolveTrustedRunDir(runId);
        validateReviewDecisions(decisions);
        validateOverrides({ decisions });
        const reviewDir = path.join(runDir, "reviews");
        await fs.mkdir(reviewDir, { recursive: true });
        const submittedAt = new Date().toISOString();

        const trainingDir = getTrainingDir(runDir);
        const trainingPageDir = path.join(trainingDir, "page");
        const trainingTemplateDir = path.join(trainingDir, "template");
        const trainingGuidesDir = getTrainingGuidesDir(runDir);
        await fs.mkdir(trainingPageDir, { recursive: true });
        await fs.mkdir(trainingTemplateDir, { recursive: true });
        await fs.mkdir(trainingGuidesDir, { recursive: true });
        const determinism = await loadRunDeterminism(runDir);

        const trainingSignals: Array<Record<string, unknown>> = [];
        const templateLinkage = new Map<
          string,
          { template: Record<string, unknown>; pages: Set<string>; confirmedPages: Set<string> }
        >();

        for (const decision of decisions) {
          const pageId = decision.pageId;
          const sidecarPath = getRunSidecarPath(runDir, pageId);
          const overridePath = path.join(runDir, "overrides", `${pageId}.json`);

          let sidecar: Record<string, unknown> | null = null;
          try {
            const raw = await fs.readFile(sidecarPath, "utf-8");
            sidecar = JSON.parse(raw) as Record<string, unknown>;
          } catch (err) {
            console.warn(`Failed to read sidecar for page ${pageId}:`, err);
            sidecar = null;
          }

          let overrideRecord: { overrides?: Record<string, unknown>; appliedAt?: string } | null =
            null;
          try {
            const raw = await fs.readFile(overridePath, "utf-8");
            overrideRecord = JSON.parse(raw) as {
              overrides?: Record<string, unknown>;
              appliedAt?: string;
            };
          } catch (error) {
            console.warn("[ipc] submit-review override missing", { pageId, error });
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
          const guideOverrides =
            overrides && typeof overrides === "object" && "guides" in overrides
              ? (overrides.guides as Record<string, unknown> | null)
              : null;
          const provenance = {
            source: "review",
            runId,
            pageId,
            submittedAt,
            appliedAt,
            decision: decision.decision,
          };

          if (sidecar && adjustments) {
            await writeJsonAtomic(sidecarPath, {
              ...sidecar,
              adjustments,
            });
          }

          const safePageId = sanitizeTrainingId(pageId);
          const isConfirmed = decision.decision !== "reject";
          const bookModel =
            sidecar?.bookModel && typeof sidecar.bookModel === "object"
              ? (sidecar.bookModel as Record<string, unknown>)
              : null;
          const runningHeadTemplates = Array.isArray(bookModel?.runningHeadTemplates)
            ? (bookModel.runningHeadTemplates as Array<Record<string, unknown>>)
            : [];
          for (const template of runningHeadTemplates) {
            if (!template || typeof template !== "object") continue;
            const templateId =
              "id" in template && typeof template.id === "string" ? template.id : null;
            if (!templateId) continue;
            const entry = templateLinkage.get(templateId) ?? {
              template,
              pages: new Set<string>(),
              confirmedPages: new Set<string>(),
            };
            entry.pages.add(pageId);
            if (isConfirmed) {
              entry.confirmedPages.add(pageId);
            }
            templateLinkage.set(templateId, entry);
          }

          const autoNormalization =
            sidecar?.normalization && typeof sidecar.normalization === "object"
              ? sidecar.normalization
              : undefined;
          const autoElements = Array.isArray(sidecar?.elements) ? sidecar?.elements : undefined;
          const autoBookModel =
            sidecar?.bookModel && typeof sidecar.bookModel === "object"
              ? sidecar.bookModel
              : undefined;

          const overrideNormalization =
            overrides?.normalization && typeof overrides.normalization === "object"
              ? overrides.normalization
              : undefined;
          const overrideElements =
            overrides?.elements && Array.isArray(overrides.elements)
              ? overrides.elements
              : undefined;

          const autoPayload: Record<string, unknown> = {};
          if (autoNormalization) autoPayload.normalization = autoNormalization;
          if (autoElements) autoPayload.elements = autoElements;
          if (autoBookModel) autoPayload.bookModel = autoBookModel;
          if (autoBaselineGrid) autoPayload.guides = { baselineGrid: autoBaselineGrid };

          const finalPayload: Record<string, unknown> = {};
          const finalNormalization = overrideNormalization ?? autoNormalization;
          const finalElements = overrideElements ?? autoElements;
          if (finalNormalization) finalPayload.normalization = finalNormalization;
          if (finalElements) finalPayload.elements = finalElements;
          if (autoBookModel) finalPayload.bookModel = autoBookModel;
          if (finalBaselineGrid) finalPayload.guides = { baselineGrid: finalBaselineGrid };

          const deltaPayload: Record<string, unknown> = adjustments ? { ...adjustments } : {};
          if (deltaBaselineGrid) deltaPayload.guides = { baselineGrid: deltaBaselineGrid };

          const auto =
            Object.keys(autoPayload).length > 0
              ? (autoPayload as Record<string, unknown>)
              : undefined;
          const final =
            Object.keys(finalPayload).length > 0
              ? (finalPayload as Record<string, unknown>)
              : undefined;
          const delta =
            Object.keys(deltaPayload).length > 0
              ? (deltaPayload as Record<string, unknown>)
              : undefined;

          const trainingSignal = {
            runId,
            pageId,
            decision: decision.decision,
            notes: decision.notes,
            confirmed: isConfirmed,
            timestamps: {
              submittedAt,
              appliedAt,
            },
            appVersion: determinism.appVersion,
            configHash: determinism.configHash,
            templateIds: runningHeadTemplates
              .map((template) =>
                "id" in template && typeof template.id === "string" ? template.id : null
              )
              .filter((templateId): templateId is string => Boolean(templateId)),
            auto,
            final,
            delta,
            sidecarPath: buildBundleFileUrl(sidecarPath),
            provenance,
          };
          trainingSignals.push(trainingSignal);
          await writeJsonAtomic(path.join(trainingPageDir, `${safePageId}.json`), trainingSignal);

          if (guideOverrides) {
            const guideHint = buildGuideTrainingHint({
              runId,
              pageId,
              appliedAt,
              sidecar,
              finalBaselineGrid,
              overrides,
            });
            if (guideHint) {
              await writeJsonAtomic(path.join(trainingGuidesDir, `${safePageId}.json`), guideHint);
            }
          }
        }

        const templateSignals: Array<Record<string, unknown>> = [];
        for (const [templateId, entry] of templateLinkage.entries()) {
          const safeTemplateId = sanitizeTrainingId(templateId);
          const templateSignal = {
            runId,
            templateId,
            confirmed: entry.confirmedPages.size > 0,
            timestamps: {
              submittedAt,
            },
            appVersion: determinism.appVersion,
            configHash: determinism.configHash,
            pages: Array.from(entry.pages),
            confirmedPages: Array.from(entry.confirmedPages),
            auto: entry.template,
            final: entry.template,
            delta: undefined,
          };
          templateSignals.push(templateSignal);
          await writeJsonAtomic(
            path.join(trainingTemplateDir, `${safeTemplateId}.json`),
            templateSignal
          );
        }

        const templateTrainingSignals = (await readTemplateSignals(trainingTemplateDir)).filter(
          (signal) => signal && typeof signal === "object" && "scope" in signal
        );

        const manifest: Record<string, unknown> = {
          runId,
          submittedAt,
          appVersion: determinism.appVersion,
          configHash: determinism.configHash,
          counts: {
            pages: trainingSignals.length,
            templates: templateSignals.length,
          },
          pages: trainingSignals,
          templates: templateSignals,
        };

        if (templateTrainingSignals.length > 0) {
          manifest.templateTrainingSignalCount = templateTrainingSignals.length;
          manifest.templateTrainingSignals = templateTrainingSignals;
        }

        await writeJsonAtomic(path.join(trainingDir, "manifest.json"), manifest);

        // Write review submission record after all processing is complete
        const reviewPath = path.join(reviewDir, `${runId}.json`);
        await writeJsonAtomic(reviewPath, {
          runId,
          submittedAt,
          decisions,
        });
      }
    )
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
