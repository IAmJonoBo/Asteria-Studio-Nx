import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

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

import { importCorpus, listProjects } from "./projects";

describe("projects", () => {
  beforeEach(() => {
    readdir.mockReset();
    stat.mockReset();
    readFile.mockReset();
    mkdir.mockReset();
    writeFile.mockReset();
    readRunIndex.mockReset();
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

    stat.mockImplementation(async (target: string) => {
      if (target === projectDir) {
        return { isDirectory: () => true };
      }
      if (target === configPath) {
        return { isFile: () => true };
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

  it("listProjects uses defaults when config missing", async () => {
    const entry = "beta-project";
    const projectsRoot = path.join(process.cwd(), "projects");
    const projectDir = path.join(projectsRoot, entry);
    const configPath = path.join(projectDir, "pipeline.config.json");

    readdir.mockResolvedValueOnce([entry]);
    readRunIndex.mockResolvedValueOnce([]);
    readFile.mockRejectedValueOnce(new Error("missing"));

    stat.mockImplementation(async (target: string) => {
      if (target === projectDir) {
        return { isDirectory: () => true };
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

    stat.mockImplementation(async (target: string) => {
      if (target === inputPath) {
        return { isDirectory: () => true };
      }
      if (existingDirs.has(target)) {
        return { isDirectory: () => true };
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

    stat.mockImplementation(async (target: string) => {
      if (target === alphaDir || target === betaDir) {
        return { isDirectory: () => true };
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
});
