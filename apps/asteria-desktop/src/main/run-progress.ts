import { BrowserWindow } from "electron";
import type { RunProgressEvent } from "../ipc/contracts";

const lastEmitByRun = new Map<string, number>();
const MIN_INTERVAL_MS = 120;

export const emitRunProgress = (event: RunProgressEvent, force = false): void => {
  const now = Date.now();
  const last = lastEmitByRun.get(event.runId) ?? 0;
  if (!force && now - last < MIN_INTERVAL_MS) return;
  lastEmitByRun.set(event.runId, now);

  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send("asteria:run-progress", event);
  });
};

export const clearRunProgress = (runId: string): void => {
  lastEmitByRun.delete(runId);
};
