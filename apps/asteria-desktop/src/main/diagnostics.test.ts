import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { EventEmitter } from "node:events";

const writeFile = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());
const copyFile = vi.hoisted(() => vi.fn());
const cp = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { writeFile, mkdir, stat, copyFile, cp },
  writeFile,
  mkdir,
  stat,
  copyFile,
  cp,
}));

const createWriteStream = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({
  default: { createWriteStream },
  createWriteStream,
}));

let lastOutput: EventEmitter | null = null;
const archiveOn = vi.hoisted(() => vi.fn());
const archiveDirectory = vi.hoisted(() => vi.fn());
const archivePipe = vi.hoisted(() =>
  vi.fn((output: EventEmitter) => {
    lastOutput = output;
  })
);
const scheduleMicrotask = (callback: () => void): void => {
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
  } else {
    Promise.resolve().then(callback);
  }
};

const archiveFinalize = vi.hoisted(() =>
  vi.fn(() => {
    scheduleMicrotask(() => lastOutput?.emit("close"));
  })
);

vi.mock("archiver", () => ({
  default: vi.fn(() => ({
    on: archiveOn,
    directory: archiveDirectory,
    pipe: archivePipe,
    finalize: archiveFinalize,
  })),
}));

const getPath = vi.hoisted(() =>
  vi.fn((key: string) => (key === "logs" ? "/tmp/logs" : "/tmp/userdata"))
);
vi.mock("electron", () => ({ app: { getPath } }));

vi.mock("./app-info", () => ({ getAppInfo: () => ({ version: "1.0.0", platform: "darwin" }) }));
const loadPreferences = vi.hoisted(() => vi.fn());
vi.mock("./preferences", () => ({
  getAsteriaRoot: (p: string) => path.join(p, "asteria"),
  loadPreferences,
}));
const readRunIndex = vi.hoisted(() => vi.fn());
vi.mock("./run-index", () => ({ readRunIndex }));

import { createDiagnosticsBundle } from "./diagnostics.js";

describe("diagnostics", () => {
  beforeEach(() => {
    writeFile.mockReset();
    mkdir.mockReset();
    stat.mockReset();
    copyFile.mockReset();
    cp.mockReset();
    archiveOn.mockReset();
    archiveDirectory.mockReset();
    archivePipe.mockReset();
    archiveFinalize.mockReset();
    createWriteStream.mockReset();
    lastOutput = null;
    loadPreferences.mockReset();
    readRunIndex.mockReset();

    createWriteStream.mockImplementation(() => {
      lastOutput = new EventEmitter();
      return lastOutput as unknown as NodeJS.WritableStream;
    });
  });

  it("creates a diagnostics bundle without runs", async () => {
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([]);
    stat.mockRejectedValue(new Error("missing"));

    const result = await createDiagnosticsBundle();

    expect(result.bundlePath).toContain("asteria-diagnostics-");
    expect(writeFile).toHaveBeenCalled();
    expect(archiveFinalize).toHaveBeenCalled();
  });

  it("includes latest run artifacts when present", async () => {
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([{ runId: "run-1", updatedAt: "2024-01-01" }]);
    stat.mockResolvedValue({});

    await createDiagnosticsBundle();

    expect(copyFile).toHaveBeenCalled();
    expect(cp).toHaveBeenCalled();
  });

  it("skips missing run artifacts and logs", async () => {
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([{ runId: "run-1", updatedAt: "2024-01-01" }]);
    stat.mockImplementation((target: string) => {
      const err = new Error(`missing ${target}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    await createDiagnosticsBundle();

    expect(copyFile).not.toHaveBeenCalled();
    expect(cp).not.toHaveBeenCalled();
  });

  it("warns when stat fails with unexpected errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([]);
    stat.mockImplementation((target: string) => {
      const err = new Error(`denied ${target}`) as NodeJS.ErrnoException;
      err.code = target === "/tmp/logs" ? "EACCES" : "ENOENT";
      return Promise.reject(err);
    });

    await createDiagnosticsBundle();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses generatedAt when updatedAt is missing", async () => {
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([
      { runId: "run-a", generatedAt: "2024-02-01" },
      { runId: "run-b", generatedAt: "2024-01-01" },
    ]);
    stat.mockResolvedValue({});

    await createDiagnosticsBundle();

    expect(copyFile).toHaveBeenCalled();
  });

  it("skips latest run when runId is missing", async () => {
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([
      { runId: undefined as unknown as string, generatedAt: "2024-03-01" },
    ]);
    stat.mockResolvedValue({});

    await createDiagnosticsBundle();

    expect(copyFile).not.toHaveBeenCalled();
  });

  it("skips app log copy when log folder disappears", async () => {
    loadPreferences.mockResolvedValue({ outputDir: "/tmp/out" });
    readRunIndex.mockResolvedValue([]);
    let call = 0;
    stat.mockImplementation((target: string) => {
      call += 1;
      if (target === "/tmp/logs" && call === 1) {
        return Promise.resolve({});
      }
      const err = new Error(`missing ${target}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    await createDiagnosticsBundle();

    expect(cp).not.toHaveBeenCalled();
  });
});
