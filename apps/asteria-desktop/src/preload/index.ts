import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels } from "../ipc/contracts";

/**
 * Secure preload: expose typed IPC API to renderer via context bridge.
 */

const api: IpcChannels = {
  "asteria:start-run": (config) => ipcRenderer.invoke("asteria:start-run", config),
  "asteria:cancel-run": (runId) => ipcRenderer.invoke("asteria:cancel-run", runId),
  "asteria:fetch-page": (pageId) => ipcRenderer.invoke("asteria:fetch-page", pageId),
  "asteria:apply-override": (pageId, overrides) =>
    ipcRenderer.invoke("asteria:apply-override", pageId, overrides),
  "asteria:export-run": (runId, format) => ipcRenderer.invoke("asteria:export-run", runId, format),
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
