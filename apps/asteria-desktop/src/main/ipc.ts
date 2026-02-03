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
      const overridePath = path.join(overridesDir, `${pageId}.json`);
      await writeJsonAtomic(overridePath, {
        pageId,
        overrides,
        appliedAt: new Date().toISOString(),
      });
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
      validateOverrides({ decisions });
      const reviewDir = path.join(resolveOutputDir(), "reviews");
      await fs.mkdir(reviewDir, { recursive: true });
      const reviewPath = path.join(reviewDir, `${runId}.json`);
      await writeJsonAtomic(reviewPath, {
        runId,
        submittedAt: new Date().toISOString(),
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
