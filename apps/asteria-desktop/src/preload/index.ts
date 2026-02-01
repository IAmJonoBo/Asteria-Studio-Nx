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

const safeInvoke = async <TChannel extends keyof IpcChannels, TResponse>(
  channel: TChannel,
  ...args: Parameters<IpcChannels[TChannel]>
): Promise<TResponse> => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    throw sanitizeError(error);
  }
};

const api: IpcChannels = {
  "asteria:start-run": async (config) => {
    validatePipelineRunConfig(config);
    return safeInvoke("asteria:start-run", config);
  },
  "asteria:analyze-corpus": async (config) => {
    validatePipelineRunConfig(config);
    return safeInvoke("asteria:analyze-corpus", config);
  },
  "asteria:scan-corpus": async (rootPath) => {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw new Error("Invalid root path for corpus scan");
    }
    return safeInvoke("asteria:scan-corpus", rootPath);
  },
  "asteria:cancel-run": async (runId) => {
    validateRunId(runId);
    return safeInvoke("asteria:cancel-run", runId);
  },
  "asteria:fetch-page": async (pageId) => {
    validatePageId(pageId);
    return safeInvoke("asteria:fetch-page", pageId);
  },
  "asteria:apply-override": async (pageId, overrides) => {
    validatePageId(pageId);
    validateOverrides(overrides);
    return safeInvoke("asteria:apply-override", pageId, overrides);
  },
  "asteria:export-run": async (runId, format) => {
    validateRunId(runId);
    validateExportFormat(format);
    return safeInvoke("asteria:export-run", runId, format);
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
