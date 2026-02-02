import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProgressEvent } from "../ipc/contracts";

const send = vi.hoisted(() => vi.fn());
const getAllWindows = vi.hoisted(() => vi.fn(() => [{ webContents: { send } }]));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows },
}));

import { clearRunProgress, emitRunProgress } from "./run-progress";

describe("run-progress", () => {
  beforeEach(() => {
    send.mockClear();
    getAllWindows.mockClear();
  });

  it("throttles emits by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const event: RunProgressEvent = {
      runId: "run-1",
      projectId: "proj",
      stage: "running",
      processed: 0,
      total: 10,
      timestamp: new Date().toISOString(),
    };

    emitRunProgress(event);
    emitRunProgress(event);

    expect(send).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("emits immediately when forced or after clear", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const event: RunProgressEvent = {
      runId: "run-2",
      projectId: "proj",
      stage: "running",
      processed: 1,
      total: 10,
      timestamp: new Date().toISOString(),
    };

    emitRunProgress(event);
    emitRunProgress(event, true);
    clearRunProgress(event.runId);
    emitRunProgress(event);

    expect(send).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
