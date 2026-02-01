import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels } from "../ipc/contracts";
import {
  validateExportFormat,
  validateOverrides,
  validatePageId,
  validatePipelineRunConfig,
  validateRunId,
} from "../ipc/validation";

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
  "asteria:scan-corpus": async (rootPath: Parameters<IpcChannels["asteria:scan-corpus"]>[0]) => {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw new Error("Invalid root path for corpus scan");
    }
    return safeInvoke("asteria:scan-corpus", rootPath);
  },
  "asteria:cancel-run": async (runId: Parameters<IpcChannels["asteria:cancel-run"]>[0]) => {
    validateRunId(runId);
    return safeInvoke("asteria:cancel-run", runId);
  },
  "asteria:fetch-page": async (pageId: Parameters<IpcChannels["asteria:fetch-page"]>[0]) => {
    validatePageId(pageId);
    return safeInvoke("asteria:fetch-page", pageId);
  },
  "asteria:apply-override": async (
    pageId: Parameters<IpcChannels["asteria:apply-override"]>[0],
    overrides: Parameters<IpcChannels["asteria:apply-override"]>[1]
  ) => {
    validatePageId(pageId);
    validateOverrides(overrides);
    return safeInvoke("asteria:apply-override", pageId, overrides);
  },
  "asteria:export-run": async (
    runId: Parameters<IpcChannels["asteria:export-run"]>[0],
    format: Parameters<IpcChannels["asteria:export-run"]>[1]
  ) => {
    validateRunId(runId);
    validateExportFormat(format);
    return safeInvoke("asteria:export-run", runId, format);
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
    validateOverrides({ decisions });
    return safeInvoke("asteria:submit-review", runId, decisions);
  },
};

contextBridge.exposeInMainWorld("asteria", {
  ipc: api,
  ping: () => "pong",
});

declare global {
  interface Window {
    asteria: {
      ipc: IpcChannels;
      ping: () => string;
    };
  }
}
