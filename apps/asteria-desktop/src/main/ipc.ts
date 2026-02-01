import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type {
  PipelineRunConfig,
  PipelineRunResult,
  ReviewDecision,
  ReviewQueue,
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

/**
 * Register IPC handlers for orchestrator commands.
 * Stubs: replace with actual orchestrator calls as pipeline core is built.
 */

export function registerIpcHandlers(): void {
  ipcMain.handle(
    "asteria:start-run",
    async (_event: IpcMainInvokeEvent, config: PipelineRunConfig): Promise<PipelineRunResult> => {
      validatePipelineRunConfig(config);
      console.warn("IPC: start-run", {
        projectId: config.projectId,
        pageCount: config.pages.length,
      });
      return {
        runId: `run-${Date.now()}`,
        status: "success",
        pagesProcessed: config.pages.length,
        errors: [],
        metrics: { durationMs: 1000 },
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

  ipcMain.handle("asteria:scan-corpus", async (_event: IpcMainInvokeEvent, rootPath: string) => {
    return scanCorpus(rootPath);
  });

  ipcMain.handle(
    "asteria:cancel-run",
    async (_event: IpcMainInvokeEvent, runId: string): Promise<void> => {
      validateRunId(runId);
      console.warn("IPC: cancel-run", { runId });
    }
  );

  ipcMain.handle("asteria:fetch-page", async (_event: IpcMainInvokeEvent, pageId: string) => {
    validatePageId(pageId);
    console.warn("IPC: fetch-page", { pageId });
    return { id: pageId, filename: `page-${pageId}.png`, originalPath: "", confidenceScores: {} };
  });

  ipcMain.handle(
    "asteria:apply-override",
    async (_event: IpcMainInvokeEvent, pageId: string, overrides: Record<string, unknown>) => {
      validatePageId(pageId);
      validateOverrides(overrides);
      console.warn("IPC: apply-override", { pageId, overrides });
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
      console.warn("IPC: export-run", { runId, format });
      return `/output/${runId}`;
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
      console.warn("IPC: submit-review", { runId, count: decisions.length });
    }
  );
}
