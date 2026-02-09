import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

type MockStat = {
  isDirectory?: () => boolean;
  isFile?: () => boolean;
};

const readdir = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { readdir, stat, readFile, mkdir, writeFile },
  readdir,
  stat,
  readFile,
  mkdir,
  writeFile,
}));

const readRunIndex = vi.hoisted(() => vi.fn());
vi.mock("./run-index", () => ({ readRunIndex }));

const resolveProjectsRoot = vi.hoisted(() => vi.fn());
const resolveOutputDir = vi.hoisted(() => vi.fn());
vi.mock("./preferences", () => ({ resolveProjectsRoot, resolveOutputDir }));

import { importCorpus, listProjects, normalizeCorpusPath } from "./projects.js";

describe("projects", () => {
  beforeEach(() => {
    readdir.mockReset();
    stat.mockReset();
    readFile.mockReset();
    mkdir.mockReset();
    writeFile.mockReset();
    readRunIndex.mockReset();
    resolveProjectsRoot.mockReset();
    resolveOutputDir.mockReset();
    resolveProjectsRoot.mockResolvedValue(path.join(process.cwd(), "projects"));
    resolveOutputDir.mockResolvedValue(path.join(process.cwd(), "pipeline-results"));
  });

  it("listProjects resolves config and status", async () => {
    const entry = "alpha-project";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, entry);
    const configPath = path.join(projectDir, "pipeline.config.json");

    readdir.mockResolvedValueOnce([entry]);
    readRunIndex.mockResolvedValueOnce([
      { runId: "run-1", projectId: "alpha", status: "running", updatedAt: "2024-01-02" },
    ]);
    readFile.mockResolvedValueOnce(
      JSON.stringify({ id: "alpha", name: "Alpha Project", inputPath: "input/raw" })
    );

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === projectDir) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (target === configPath) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw new Error("missing");
    });

    const result = await listProjects();

    expect(result).toEqual([
      {
        id: "alpha",
        name: "Alpha Project",
        path: projectDir,
        inputPath: path.join(projectDir, "input/raw"),
        configPath,
        lastRun: "2024-01-02",
        status: "processing",
      },
    ]);
  });

  it("listProjects ignores non-directory entries and picks latest run timestamp", async () => {
    const entry = "delta-project";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, entry);

    readdir.mockResolvedValueOnce([entry, "not-a-dir"]);
    readRunIndex.mockResolvedValueOnce([
      { runId: "r1", projectId: entry, generatedAt: "2024-01-01", status: "queued" },
      { runId: "r2", projectId: entry, updatedAt: "2024-03-01", status: "success" },
      { runId: "r3", status: "failed" },
    ]);
    readFile.mockResolvedValueOnce(JSON.stringify({ id: entry, inputPath: "input/raw" }));

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === projectDir) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (target.endsWith("not-a-dir")) {
        return { isDirectory: () => false, isFile: () => false };
      }
      throw new Error("missing");
    });

    const result = await listProjects();
    expect(result).toHaveLength(1);
    expect(result[0]?.lastRun).toBe("2024-03-01");
    expect(result[0]?.status).toBe("completed");
  });

  it("listProjects uses defaults when config missing", async () => {
    const entry = "beta-project";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, entry);
    const configPath = path.join(projectDir, "pipeline.config.json");

    readdir.mockResolvedValueOnce([entry]);
    readRunIndex.mockResolvedValueOnce([]);
    readFile.mockRejectedValueOnce(new Error("missing"));

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === projectDir) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (target === configPath) {
        throw new Error("missing");
      }
      throw new Error("missing");
    });

    const result = await listProjects();

    expect(result).toEqual([
      {
        id: entry,
        name: "Beta Project",
        path: projectDir,
        inputPath: path.join(projectDir, "input", "raw"),
        configPath: undefined,
        lastRun: undefined,
        status: "idle",
      },
    ]);
  });

  it("importCorpus creates unique project ids", async () => {
    const inputPath = "/tmp/corpus";
    const projectsRoot = path.join(process.cwd(), "projects");
    const existingDir = path.join(projectsRoot, "sample");
    const nextDir = path.join(projectsRoot, "sample-2");

    const existingDirs = new Set([existingDir]);

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === inputPath) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (existingDirs.has(target)) {
        return { isDirectory: () => true, isFile: () => false };
      }
      throw new Error("missing");
    });

    const result = await importCorpus({ inputPath, name: "Sample" });

    expect(mkdir).toHaveBeenCalledWith(nextDir, { recursive: true });
    expect(writeFile).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      id: "sample-2",
      name: "Sample",
      path: nextDir,
      inputPath,
      status: "idle",
    });
  });

  it("importCorpus falls back to default slug for non-alphanumeric names", async () => {
    const inputPath = "/tmp/corpus";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, "project");

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === inputPath) {
        return { isDirectory: () => true, isFile: () => false };
      }
      throw new Error("missing");
    });

    const result = await importCorpus({ inputPath, name: "!!!" });

    expect(mkdir).toHaveBeenCalledWith(projectDir, { recursive: true });
    expect(result.id).toBe("project");
  });

  it("listProjects resolves absolute input paths and success/error statuses", async () => {
    const entries = ["alpha-project", "beta-project"];
    const projectsRoot = path.join(process.cwd(), "projects");
    const alphaDir = path.join(projectsRoot, entries[0]);
    const betaDir = path.join(projectsRoot, entries[1]);
    const alphaConfigPath = path.join(alphaDir, "pipeline.config.json");
    const betaConfigPath = path.join(betaDir, "pipeline.config.json");

    readdir.mockResolvedValueOnce(entries);
    readRunIndex.mockResolvedValueOnce([
      { runId: "run-1", projectId: "alpha", status: "success", updatedAt: "2024-02-01" },
      { runId: "run-2", projectId: "beta-project", status: "failed", updatedAt: "2024-02-02" },
    ]);
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({ id: "alpha", name: "Alpha", inputPath: "/abs/input" })
      )
      .mockRejectedValueOnce(new Error("missing"));

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === alphaDir || target === betaDir) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (target === alphaConfigPath || target === betaConfigPath) {
        throw new Error("missing");
      }
      throw new Error("missing");
    });

    const result = await listProjects();

    expect(result).toEqual([
      {
        id: "alpha",
        name: "Alpha",
        path: alphaDir,
        inputPath: "/abs/input",
        configPath: undefined,
        lastRun: "2024-02-01",
        status: "completed",
      },
      {
        id: "beta-project",
        name: "Beta Project",
        path: betaDir,
        inputPath: path.join(betaDir, "input", "raw"),
        configPath: undefined,
        lastRun: "2024-02-02",
        status: "error",
      },
    ]);
  });

  it("listProjects detects yaml config paths", async () => {
    const entry = "gamma-project";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, entry);
    const yamlPath = path.join(projectDir, "pipeline.config.yaml");

    readdir.mockResolvedValueOnce([entry]);
    readRunIndex.mockResolvedValueOnce([]);
    readFile.mockResolvedValueOnce(JSON.stringify({ id: "gamma", inputPath: "input/raw" }));

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === projectDir) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (target === yamlPath) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw new Error("missing");
    });

    const result = await listProjects();
    expect(result[0]?.configPath).toBe(yamlPath);
  });

  it("importCorpus rejects non-directory input", async () => {
    stat.mockResolvedValueOnce({ isDirectory: () => false, isFile: () => false });

    await expect(importCorpus({ inputPath: "/tmp/file.txt" })).rejects.toThrow(
      /must be a directory/i
    );
  });

  it("importCorpus accepts supported file input", async () => {
    const inputPath = "/tmp/corpus.pdf";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, "corpus");

    stat.mockImplementation(async (target: string): Promise<MockStat> => {
      if (target === inputPath) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw new Error("missing");
    });

    const result = await importCorpus({ inputPath });

    expect(mkdir).toHaveBeenCalledWith(projectDir, { recursive: true });
    expect(result.id).toBe("corpus");
  });

  it("listProjects returns empty array on readdir failure", async () => {
    readdir.mockRejectedValueOnce(new Error("missing"));

    const result = await listProjects();

    expect(result).toEqual([]);
  });

  it("normalizeCorpusPath expands home shortcuts", () => {
    const normalized = normalizeCorpusPath("~/corpus");
    expect(normalized).toContain(path.join(os.homedir(), "corpus"));
  });
});
