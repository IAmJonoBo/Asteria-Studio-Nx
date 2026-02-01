import { ipcMain } from "electron";
import type { IpcChannels, PipelineRunConfig, PipelineRunResult } from "./contracts";

/**
 * Register IPC handlers for orchestrator commands.
 * Stubs: replace with actual orchestrator calls as pipeline core is built.
 */

export function registerIpcHandlers(): void {
  (ipcMain as any).handle("asteria:start-run", async (event, config: PipelineRunConfig): Promise<PipelineRunResult> => {
    console.log("IPC: start-run", { projectId: config.projectId, pageCount: config.pages.length });
    return {
      runId: `run-${Date.now()}`,
      status: "success",
      pagesProcessed: config.pages.length,
      errors: [],
      metrics: { durationMs: 1000 },
    };
  });

  (ipcMain as any).handle("asteria:cancel-run", async (event, runId: string): Promise<void> => {
    console.log("IPC: cancel-run", { runId });
  });

  (ipcMain as any).handle("asteria:fetch-page", async (event, pageId: string) => {
    console.log("IPC: fetch-page", { pageId });
    return { id: pageId, filename: `page-${pageId}.png`, originalPath: "", confidenceScores: {} };
  });

  (ipcMain as any).handle("asteria:apply-override", async (event, pageId: string, overrides: Record<string, unknown>) => {
    console.log("IPC: apply-override", { pageId, overrides });
  });

  (ipcMain as any).handle("asteria:export-run", async (event, runId: string, format: string): Promise<string> => {
    console.log("IPC: export-run", { runId, format });
    return `/output/${runId}`;
  });
}
