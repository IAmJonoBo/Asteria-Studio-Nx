import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type {
  PipelineRunConfig,
  PipelineRunResult,
  ReviewDecision,
  ReviewQueue,
  PageData,
} from "../ipc/contracts";
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateExportFormat,
  validateOverrides,
  validatePageId,
  validatePipelineRunConfig,
  validateRunId,
} from "../ipc/validation";
import { analyzeCorpus } from "../ipc/corpusAnalysis";
import { scanCorpus } from "../ipc/corpusScanner";
import { runPipeline } from "./pipeline-runner";

/**
 * Register IPC handlers for orchestrator commands.
 * Stubs: replace with actual orchestrator calls as pipeline core is built.
 */

export function registerIpcHandlers(): void {
  ipcMain.handle(
    "asteria:start-run",
    async (_event: IpcMainInvokeEvent, config: PipelineRunConfig): Promise<PipelineRunResult> => {
      validatePipelineRunConfig(config);
      if (config.pages.length === 0) {
        throw new Error("Cannot start run: no pages provided");
      }

      const projectRoot = resolveProjectRoot(config.pages);
      const outputDir = path.join(process.cwd(), "pipeline-results");
      const result = await runPipeline({
        projectRoot,
        projectId: config.projectId,
        targetDpi: config.targetDpi,
        targetDimensionsMm: config.targetDimensionsMm,
        outputDir,
        enableSpreadSplit: true,
        enableBookPriors: true,
      });

      return result.pipelineResult;
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

  ipcMain.handle(
    "asteria:cancel-run",
    async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
      validateRunId(runId);
      console.warn("IPC: cancel-run", { runId });
    }
  );

  ipcMain.handle("asteria:fetch-page", async (_event: IpcMainInvokeEvent, pageId: string) => {
    validatePageId(pageId);
    const sidecarPath = path.join(process.cwd(), "pipeline-results", "sidecars", `${pageId}.json`);
    try {
      const raw = await fs.readFile(sidecarPath, "utf-8");
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
  });

  ipcMain.handle(
    "asteria:apply-override",
    async (_event: IpcMainInvokeEvent, pageId: string, overrides: Record<string, unknown>) => {
      validatePageId(pageId);
      validateOverrides(overrides);
      const overridesDir = path.join(process.cwd(), "pipeline-results", "overrides");
      await fs.mkdir(overridesDir, { recursive: true });
      const overridePath = path.join(overridesDir, `${pageId}.json`);
      await fs.writeFile(
        overridePath,
        JSON.stringify({ pageId, overrides, appliedAt: new Date().toISOString() }, null, 2)
      );
    }
  );

  ipcMain.handle(
    "asteria:export-run",
    async (
      _event: IpcMainInvokeEvent,
      runId: string,
      format: "png" | "tiff" | "pdf"
    ): Promise<string> => {
      validateRunId(runId);
      validateExportFormat(format);
      const exportDir = path.join(process.cwd(), "pipeline-results", "normalized");
      await fs.mkdir(exportDir, { recursive: true });
      return exportDir;
    }
  );

  ipcMain.handle(
    "asteria:fetch-review-queue",
    async (_event: IpcMainInvokeEvent, runId: string): Promise<ReviewQueue> => {
      validateRunId(runId);
      const reviewPath = path.join(process.cwd(), "pipeline-results", `${runId}-review-queue.json`);
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
      const reviewDir = path.join(process.cwd(), "pipeline-results", "reviews");
      await fs.mkdir(reviewDir, { recursive: true });
      const reviewPath = path.join(reviewDir, `${runId}.json`);
      await fs.writeFile(
        reviewPath,
        JSON.stringify(
          {
            runId,
            submittedAt: new Date().toISOString(),
            decisions,
          },
          null,
          2
        )
      );
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
