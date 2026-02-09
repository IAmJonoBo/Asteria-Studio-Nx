import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { IpcChannels, RunProgressEvent } from "../ipc/contracts.js";
import {
  validateAppPreferencesUpdate,
  validateExportFormats,
  validateImportCorpusRequest,
  validatePageLayoutOverrides,
  validatePageId,
  validatePipelineConfigOverrides,
  validatePipelineRunConfig,
  validateProjectId,
  validateRevealPath,
  validateRunHistoryCleanupOptions,
  validateRunId,
  validateReviewDecisions,
  validateTemplateTrainingSignal,
} from "../ipc/validation.js";

/**
 * Secure preload: expose typed IPC API to renderer via context bridge.
 */

const sanitizeError = (error: unknown): Error => {
  const message = error instanceof Error && error.message ? error.message : "Request failed";
  return new Error(message);
};

type ChannelName = Extract<keyof IpcChannels, string>;

const safeInvoke = async <TChannel extends ChannelName>(
  channel: TChannel,
  ...args: Parameters<IpcChannels[TChannel]>
): Promise<Awaited<ReturnType<IpcChannels[TChannel]>>> => {
  try {
    return await ipcRenderer.invoke(channel as string, ...args);
  } catch (error) {
    throw sanitizeError(error);
  }
};

const api: IpcChannels = {
  "asteria:get-app-preferences": async () => safeInvoke("asteria:get-app-preferences"),
  "asteria:set-app-preferences": async (
    prefs: Parameters<IpcChannels["asteria:set-app-preferences"]>[0]
  ) => {
    validateAppPreferencesUpdate(prefs as Record<string, unknown>);
    return safeInvoke("asteria:set-app-preferences", prefs);
  },
  "asteria:get-app-info": async () => safeInvoke("asteria:get-app-info"),
  "asteria:provision-sample-corpus": async () => safeInvoke("asteria:provision-sample-corpus"),
  "asteria:create-diagnostics-bundle": async () => safeInvoke("asteria:create-diagnostics-bundle"),
  "asteria:reveal-path": async (targetPath: Parameters<IpcChannels["asteria:reveal-path"]>[0]) => {
    validateRevealPath(targetPath);
    return safeInvoke("asteria:reveal-path", targetPath);
  },
  "asteria:start-run": async (config: Parameters<IpcChannels["asteria:start-run"]>[0]) => {
    validatePipelineRunConfig(config);
    return safeInvoke("asteria:start-run", config);
  },
  "asteria:analyze-corpus": async (
    config: Parameters<IpcChannels["asteria:analyze-corpus"]>[0]
  ) => {
    validatePipelineRunConfig(config);
    return safeInvoke("asteria:analyze-corpus", config);
  },
  "asteria:scan-corpus": async (
    rootPath: Parameters<IpcChannels["asteria:scan-corpus"]>[0],
    options?: Parameters<IpcChannels["asteria:scan-corpus"]>[1]
  ) => {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw new Error("Invalid root path for corpus scan");
    }
    return safeInvoke("asteria:scan-corpus", rootPath, options);
  },
  "asteria:pick-corpus-dir": async () => safeInvoke("asteria:pick-corpus-dir"),
  "asteria:list-projects": async () => safeInvoke("asteria:list-projects"),
  "asteria:import-corpus": async (request: Parameters<IpcChannels["asteria:import-corpus"]>[0]) => {
    validateImportCorpusRequest(request);
    return safeInvoke("asteria:import-corpus", request);
  },
  "asteria:list-runs": async () => safeInvoke("asteria:list-runs"),
  "asteria:delete-run": async (runId: Parameters<IpcChannels["asteria:delete-run"]>[0]) => {
    validateRunId(runId);
    return safeInvoke("asteria:delete-run", runId);
  },
  "asteria:clear-run-history": async (
    options?: Parameters<IpcChannels["asteria:clear-run-history"]>[0]
  ) => {
    validateRunHistoryCleanupOptions(options);
    return safeInvoke("asteria:clear-run-history", options);
  },
  "asteria:get-run-manifest": async (
    runId: Parameters<IpcChannels["asteria:get-run-manifest"]>[0]
  ) => {
    validateRunId(runId);
    return safeInvoke("asteria:get-run-manifest", runId);
  },
  "asteria:get-pipeline-config": async (
    projectId?: Parameters<IpcChannels["asteria:get-pipeline-config"]>[0]
  ) => safeInvoke("asteria:get-pipeline-config", projectId),
  "asteria:save-project-config": async (
    projectId: Parameters<IpcChannels["asteria:save-project-config"]>[0],
    overrides: Parameters<IpcChannels["asteria:save-project-config"]>[1]
  ) => {
    validateProjectId(projectId);
    validatePipelineConfigOverrides(overrides as Record<string, unknown>);
    return safeInvoke("asteria:save-project-config", projectId, overrides);
  },
  "asteria:get-run-config": async (
    runId: Parameters<IpcChannels["asteria:get-run-config"]>[0]
  ) => {
    validateRunId(runId);
    return safeInvoke("asteria:get-run-config", runId);
  },
  "asteria:cancel-run": async (runId: Parameters<IpcChannels["asteria:cancel-run"]>[0]) => {
    validateRunId(runId);
    return safeInvoke("asteria:cancel-run", runId);
  },
  "asteria:cancel-run-and-delete": async (
    runId: Parameters<IpcChannels["asteria:cancel-run-and-delete"]>[0]
  ) => {
    validateRunId(runId);
    return safeInvoke("asteria:cancel-run-and-delete", runId);
  },
  "asteria:pause-run": async (runId: Parameters<IpcChannels["asteria:pause-run"]>[0]) => {
    validateRunId(runId);
    return safeInvoke("asteria:pause-run", runId);
  },
  "asteria:resume-run": async (runId: Parameters<IpcChannels["asteria:resume-run"]>[0]) => {
    validateRunId(runId);
    return safeInvoke("asteria:resume-run", runId);
  },
  "asteria:fetch-page": async (
    runId: Parameters<IpcChannels["asteria:fetch-page"]>[0],
    pageId: Parameters<IpcChannels["asteria:fetch-page"]>[1]
  ) => {
    validateRunId(runId);
    validatePageId(pageId);
    return safeInvoke("asteria:fetch-page", runId, pageId);
  },
  "asteria:fetch-sidecar": async (
    runId: Parameters<IpcChannels["asteria:fetch-sidecar"]>[0],
    pageId: Parameters<IpcChannels["asteria:fetch-sidecar"]>[1]
  ) => {
    validateRunId(runId);
    validatePageId(pageId);
    return safeInvoke("asteria:fetch-sidecar", runId, pageId);
  },
  "asteria:apply-override": async (
    runId: Parameters<IpcChannels["asteria:apply-override"]>[0],
    pageId: Parameters<IpcChannels["asteria:apply-override"]>[1],
    overrides: Parameters<IpcChannels["asteria:apply-override"]>[2]
  ) => {
    validateRunId(runId);
    validatePageId(pageId);
    validatePageLayoutOverrides(overrides);
    return safeInvoke("asteria:apply-override", runId, pageId, overrides);
  },
  "asteria:export-run": async (
    runId: Parameters<IpcChannels["asteria:export-run"]>[0],
    formats: Parameters<IpcChannels["asteria:export-run"]>[1]
  ) => {
    validateRunId(runId);
    validateExportFormats(formats);
    return safeInvoke("asteria:export-run", runId, formats);
  },
  "asteria:fetch-review-queue": async (
    runId: Parameters<IpcChannels["asteria:fetch-review-queue"]>[0]
  ) => {
    validateRunId(runId);
    return safeInvoke("asteria:fetch-review-queue", runId);
  },
  "asteria:submit-review": async (
    runId: Parameters<IpcChannels["asteria:submit-review"]>[0],
    decisions: Parameters<IpcChannels["asteria:submit-review"]>[1]
  ) => {
    validateRunId(runId);
    validateReviewDecisions(decisions);
    return safeInvoke("asteria:submit-review", runId, decisions);
  },
  "asteria:record-template-training": async (
    runId: Parameters<IpcChannels["asteria:record-template-training"]>[0],
    signal: Parameters<IpcChannels["asteria:record-template-training"]>[1]
  ) => {
    validateRunId(runId);
    validateTemplateTrainingSignal(signal);
    return safeInvoke("asteria:record-template-training", runId, signal);
  },
};

contextBridge.exposeInMainWorld("asteria", {
  ipc: api,
  onRunProgress: (handler: (event: RunProgressEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      handler(payload as RunProgressEvent);
    };
    ipcRenderer.on("asteria:run-progress", listener);
    return () => ipcRenderer.removeListener("asteria:run-progress", listener);
  },
  ping: () => "pong",
});

declare global {
  interface Window {
    asteria: {
      ipc: IpcChannels;
      onRunProgress: (handler: (event: RunProgressEvent) => void) => () => void;
      ping: () => string;
    };
  }
}
