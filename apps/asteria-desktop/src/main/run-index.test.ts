import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { readFile, writeFile, rename, mkdir },
  readFile,
  writeFile,
  rename,
  mkdir,
}));

import { clearRunIndex, readRunIndex, updateRunIndex } from "./run-index.js";

describe("run-index", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    rename.mockReset();
    mkdir.mockReset();
  });

  it("readRunIndex returns empty when missing", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"));

    const result = await readRunIndex("/tmp/output");

    expect(result).toEqual([]);
  });

  it("readRunIndex returns parsed runs", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({ runs: [{ runId: "run-1", projectId: "proj" }] })
    );

    const result = await readRunIndex("/tmp/output");

    expect(result).toEqual([{ runId: "run-1", projectId: "proj" }]);
  });

  it("readRunIndex returns empty when runs is not an array", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ runs: "nope" }));

    const result = await readRunIndex("/tmp/output");

    expect(result).toEqual([]);
  });

  it("updateRunIndex merges existing entries", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        runs: [
          {
            runId: "run-1",
            projectId: "proj",
            status: "running",
            generatedAt: "2024-01-01",
          },
        ],
      })
    );

    await updateRunIndex("/tmp/output", {
      runId: "run-1",
      projectId: "proj",
      status: "success",
      reviewCount: 5,
    });

    expect(writeFile).toHaveBeenCalledOnce();
    const [, raw] = writeFile.mock.calls[0];
    const parsed = JSON.parse(String(raw)) as { runs: Array<Record<string, unknown>> };
    expect(parsed.runs[0]).toMatchObject({
      runId: "run-1",
      projectId: "proj",
      status: "success",
      reviewCount: 5,
      generatedAt: "2024-01-01",
    });
    const indexPath = path.join("/tmp/output", "run-index.json");
    expect(rename).toHaveBeenCalledWith(expect.any(String), indexPath);
  });

  it("updateRunIndex writes new entries first", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"));

    await updateRunIndex("/tmp/output", {
      runId: "run-2",
      projectId: "proj",
      status: "queued",
    });

    const indexPath = path.join("/tmp/output", "run-index.json");
    expect(writeFile).toHaveBeenCalledOnce();
    const [, raw] = writeFile.mock.calls[0];
    expect(String(raw)).toContain('"run-2"');
    expect(rename).toHaveBeenCalledWith(expect.any(String), indexPath);
  });

  it("clearRunIndex writes an empty runs array", async () => {
    await clearRunIndex("/tmp/output");

    expect(writeFile).toHaveBeenCalledOnce();
    const [, raw] = writeFile.mock.calls[0];
    const parsed = JSON.parse(String(raw)) as { runs?: unknown[] };
    expect(parsed.runs).toEqual([]);
  });

  it("serializes concurrent updateRunIndex calls to prevent data loss", async () => {
    // Simulate two concurrent updates to the same file.
    // The first read returns one entry, both updates should be present in the final result.
    let readCount = 0;
    readFile.mockImplementation(async () => {
      readCount += 1;
      if (readCount === 1) {
        return JSON.stringify({ runs: [] });
      }
      // On subsequent reads, return whatever was last written
      const lastWrite = writeFile.mock.calls[writeFile.mock.calls.length - 1];
      return String(lastWrite?.[1] ?? JSON.stringify({ runs: [] }));
    });

    const update1 = updateRunIndex("/tmp/output", {
      runId: "run-a",
      projectId: "proj",
      status: "queued",
    });
    const update2 = updateRunIndex("/tmp/output", {
      runId: "run-b",
      projectId: "proj",
      status: "running",
    });

    await Promise.all([update1, update2]);

    // With serialization, the second write should include both entries
    expect(writeFile.mock.calls.length).toBe(2);
    const lastWrite = writeFile.mock.calls[1];
    const parsed = JSON.parse(String(lastWrite[1])) as { runs: Array<{ runId: string }> };
    const runIds = parsed.runs.map((r) => r.runId);
    expect(runIds).toContain("run-a");
    expect(runIds).toContain("run-b");
  });

  it("readRunIndex suppresses ENOENT without warning", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFile.mockRejectedValueOnce(enoent);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await readRunIndex("/tmp/output");

    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
