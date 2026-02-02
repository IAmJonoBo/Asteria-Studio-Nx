import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { readFile, writeFile },
  readFile,
  writeFile,
}));

import { readRunIndex, updateRunIndex } from "./run-index";

describe("run-index", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
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
  });

  it("updateRunIndex writes new entries first", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"));

    await updateRunIndex("/tmp/output", {
      runId: "run-2",
      projectId: "proj",
      status: "queued",
    });

    const indexPath = path.join("/tmp/output", "run-index.json");
    expect(writeFile).toHaveBeenCalledWith(
      indexPath,
      JSON.stringify({ runs: [{ runId: "run-2", projectId: "proj", status: "queued" }] }, null, 2)
    );
  });
});
