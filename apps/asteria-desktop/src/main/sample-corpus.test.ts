import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const stat = vi.hoisted(() => vi.fn());
const cp = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { stat, cp, mkdir },
  stat,
  cp,
  mkdir,
}));

const getPath = vi.hoisted(() => vi.fn(() => "/tmp/userdata"));
vi.mock("electron", () => ({ app: { getPath } }));

const listProjects = vi.hoisted(() => vi.fn());
const importCorpus = vi.hoisted(() => vi.fn());
vi.mock("./projects", () => ({ listProjects, importCorpus }));

const loadPreferences = vi.hoisted(() => vi.fn());
const savePreferences = vi.hoisted(() => vi.fn());
vi.mock("./preferences", () => ({
  loadPreferences,
  savePreferences,
  getAsteriaRoot: (p: string) => path.join(p, "asteria"),
}));

import { provisionSampleCorpus } from "./sample-corpus.js";

describe("sample-corpus", () => {
  beforeEach(() => {
    stat.mockReset();
    cp.mockReset();
    mkdir.mockReset();
    listProjects.mockReset();
    importCorpus.mockReset();
    loadPreferences.mockReset();
    savePreferences.mockReset();
  });

  it("throws when bundled corpus missing", async () => {
    stat.mockImplementation(async (target: string) => {
      if (target.includes("sample-corpus")) throw new Error("missing");
      return {};
    });

    await expect(provisionSampleCorpus()).rejects.toThrow(/missing/i);
  });

  it("returns existing project when already provisioned", async () => {
    const targetInput = path.join("/tmp/userdata", "asteria", "sample-corpus");

    stat.mockResolvedValue({});
    listProjects.mockResolvedValue([{ id: "sample", inputPath: targetInput }]);

    const result = await provisionSampleCorpus();

    expect(importCorpus).not.toHaveBeenCalled();
    expect(savePreferences).toHaveBeenCalledWith(
      { sampleCorpusInstalled: true },
      { userDataPath: "/tmp/userdata" }
    );
    expect(result.projectId).toBe("sample");
  });

  it("copies corpus and imports when missing", async () => {
    const targetInput = path.join("/tmp/userdata", "asteria", "sample-corpus");
    stat.mockImplementation(async (target: string) => {
      if (target === targetInput) throw new Error("missing");
      return {};
    });
    listProjects.mockResolvedValue([]);
    importCorpus.mockResolvedValue({ id: "sample", inputPath: targetInput });

    const result = await provisionSampleCorpus();

    expect(cp).toHaveBeenCalled();
    expect(importCorpus).toHaveBeenCalled();
    expect(result.projectId).toBe("sample");
  });
});
