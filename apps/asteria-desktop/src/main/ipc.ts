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
  validateReviewDecisions,
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

const sanitizeTrainingId = (value: string): string => value.replace(/[\\/]/g, "_");

const loadRunDeterminism = async (
  runDir: string
): Promise<{ appVersion: string; configHash: string }> => {
  const reportPath = getRunReportPath(runDir);
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    const report = JSON.parse(raw) as { determinism?: { appVersion?: string; configHash?: string } };
    return {
      appVersion: report.determinism?.appVersion ?? "unknown",
      configHash: report.determinism?.configHash ?? "unknown",
    };
  } catch {
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
  const resolveRunDir = async (outputDir: string, runId: string): Promise<string> => {
    return getRunDir(outputDir, runId);
  };

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
      return {
        runId,
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
    async (_event: IpcMainInvokeEvent, runId: string, pageId: string) => {
      validateRunId(runId);
      validatePageId(pageId);
      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
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
    async (_event: IpcMainInvokeEvent, runId: string, pageId: string) => {
      validateRunId(runId);
      validatePageId(pageId);
      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
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
      pageId: string,
      overrides: Record<string, unknown>
    ) => {
      validateRunId(runId);
      validatePageId(pageId);
      validateOverrides(overrides);
      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
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
    async (_event: IpcMainInvokeEvent, runId: string, formats: ExportFormat[]): Promise<string> => {
      validateRunId(runId);
      validateExportFormats(formats);
      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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
        await Promise.all(
          sidecarFiles.map((file) =>
            fs.copyFile(
              path.join(sidecarDir, path.basename(file)),
              path.join(sidecarExportDir, path.basename(file))
            ).catch((err) => {
              warnings.push(`Failed to copy sidecar ${file}: ${err}`);
            })
          )
        );
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

      const normalizedDir = getNormalizedDir(runDir);
      let normalizedFiles: string[] = [];
      try {
        normalizedFiles = await fs.readdir(normalizedDir);
      } catch (err) {
        warnings.push(`Failed to read normalized directory: ${err}`);
        normalizedFiles = [];
      }

      try {
        await Promise.all(
          formats.map((format) =>
            exportNormalizedByFormat({ format, exportDir, normalizedDir, normalizedFiles }).catch(
              (err) => {
                warnings.push(`Failed to export format ${format}: ${err}`);
              }
            )
          )
        );
      } catch (err) {
        warnings.push(`Format export failed: ${err}`);
      }

      if (warnings.length > 0) {
        console.warn(`Export completed with warnings for runId ${runId}:`, warnings);
      }

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
    async (_event: IpcMainInvokeEvent, runId: string): Promise<RunConfigSnapshot | null> => {
      validateRunId(runId);
      const outputDir = resolveOutputDir();
      const runDir = getRunDir(outputDir, runId);
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
    async (_event: IpcMainInvokeEvent, runId: string): Promise<RunManifestSummary | null> => {
      validateRunId(runId);
      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
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
      const parsed = JSON.parse(raw) as { runs?: Array<RunSummary & { reviewQueuePath?: string }> };
      if (Array.isArray(parsed.runs)) {
        return parsed.runs.map((run) => ({
          runId: run.runId,
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
    async (_event: IpcMainInvokeEvent, runId: string): Promise<ReviewQueue> => {
      validateRunId(runId);
      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
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
      decisions: ReviewDecision[]
    ): Promise<void> => {
      validateRunId(runId);
      validateReviewDecisions(decisions);
      const reviewDir = path.join(resolveOutputDir(), "reviews");
      await fs.mkdir(reviewDir, { recursive: true });
      const submittedAt = new Date().toISOString();

      const outputDir = resolveOutputDir();
      const runDir = await resolveRunDir(outputDir, runId);
      const trainingDir = getTrainingDir(runDir);
      const trainingPageDir = path.join(trainingDir, "page");
      const trainingTemplateDir = path.join(trainingDir, "template");
      await fs.mkdir(trainingPageDir, { recursive: true });
      await fs.mkdir(trainingTemplateDir, { recursive: true });
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

        let overrideRecord: { overrides?: Record<string, unknown>; appliedAt?: string } | null = null;
        try {
          const raw = await fs.readFile(overridePath, "utf-8");
          overrideRecord = JSON.parse(raw) as { overrides?: Record<string, unknown>; appliedAt?: string };
        } catch {
          // Override is optional, no warning needed
          overrideRecord = null;
        }

        const overrides =
          (decision.overrides as Record<string, unknown> | undefined) ??
          overrideRecord?.overrides ??
          (sidecar?.overrides as Record<string, unknown> | undefined) ??
          null;
        const appliedAt = overrideRecord?.appliedAt ?? submittedAt;
        const adjustments = buildAdjustmentSummary({ sidecar, overrides, appliedAt });

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
          overrides?.elements && Array.isArray(overrides.elements) ? overrides.elements : undefined;

        const trainingSignal = {
          runId,
          pageId,
          decision: decision.decision,
          notes: decision.notes,
          confirmed: decision.decision !== "reject",
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
          auto: {
            normalization: autoNormalization,
            elements: autoElements,
            bookModel: autoBookModel,
          },
          final: {
            normalization: overrideNormalization ?? autoNormalization,
            elements: overrideElements ?? autoElements,
            bookModel: autoBookModel,
          },
          delta: adjustments ?? undefined,
          sidecarPath: `sidecars/${pageId}.json`,
        };
        trainingSignals.push(trainingSignal);
        await writeJsonAtomic(path.join(trainingPageDir, `${safePageId}.json`), trainingSignal);
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

      await writeJsonAtomic(path.join(trainingDir, "manifest.json"), {
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
      });

      // Write review submission record after all processing is complete
      const reviewPath = path.join(reviewDir, `${runId}.json`);
      await writeJsonAtomic(reviewPath, {
        runId,
        submittedAt,
        decisions,
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
