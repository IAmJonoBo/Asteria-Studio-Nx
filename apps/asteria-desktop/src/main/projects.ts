import fs from "node:fs/promises";
import path from "node:path";
import type { ImportCorpusRequest, ProjectSummary } from "../ipc/contracts";
import { readRunIndex, type RunIndexStatus } from "./run-index";

const projectsRoot = path.join(process.cwd(), "projects");

type ProjectConfig = {
  id?: string;
  name?: string;
  inputPath?: string;
  createdAt?: string;
};

const slugify = (value: string): string => {
  const normalized = value.toLowerCase().trim();
  let slug = "";
  let pendingDash = false;
  for (const char of normalized) {
    const isAlnum = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
    if (isAlnum) {
      if (pendingDash && slug.length > 0) {
        slug += "-";
      }
      slug += char;
      pendingDash = false;
    } else {
      pendingDash = true;
    }
  }
  return slug || "project";
};

const resolveInputPath = (projectDir: string, inputPath?: string): string => {
  if (!inputPath) {
    return path.join(projectDir, "input", "raw");
  }
  return path.isAbsolute(inputPath) ? inputPath : path.join(projectDir, inputPath);
};

const readProjectConfig = async (projectDir: string): Promise<ProjectConfig | null> => {
  const configPath = path.join(projectDir, "project.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
};

const formatProjectName = (id: string): string =>
  id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const resolveProjectStatus = (status?: RunIndexStatus): ProjectSummary["status"] => {
  if (!status) return "idle";
  if (status === "running" || status === "paused" || status === "queued" || status === "cancelling")
    return "processing";
  if (status === "success") return "completed";
  return "error";
};

export const listProjects = async (): Promise<ProjectSummary[]> => {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }

  const outputDir = process.env.ASTERIA_OUTPUT_DIR ?? path.join(process.cwd(), "pipeline-results");
  const runs = await readRunIndex(outputDir);
  const latestRunByProject = new Map<string, { updatedAt?: string; status?: RunIndexStatus }>();
  runs.forEach((run) => {
    if (!run.projectId) return;
    const previous = latestRunByProject.get(run.projectId);
    const candidateTime = run.updatedAt ?? run.generatedAt ?? run.startedAt ?? "";
    const previousTime = previous?.updatedAt ?? "";
    if (!previous || candidateTime > previousTime) {
      latestRunByProject.set(run.projectId, { updatedAt: candidateTime, status: run.status });
    }
  });

  const projects = await Promise.all(
    entries.map(async (entry) => {
      const projectDir = path.join(projectsRoot, entry);
      try {
        const stats = await fs.stat(projectDir);
        if (!stats.isDirectory()) return null;
      } catch {
        return null;
      }
      const config = await readProjectConfig(projectDir);
      const id = config?.id ?? entry;
      const name = config?.name ?? formatProjectName(entry);
      const inputPath = resolveInputPath(projectDir, config?.inputPath);
      const configPath = path.join(projectDir, "pipeline.config.json");
      let configExists = false;
      try {
        const configStats = await fs.stat(configPath);
        configExists = configStats.isFile();
      } catch {
        configExists = false;
      }
      const latestRun = latestRunByProject.get(id);
      return {
        id,
        name,
        path: projectDir,
        inputPath,
        configPath: configExists ? configPath : undefined,
        lastRun: latestRun?.updatedAt,
        status: resolveProjectStatus(latestRun?.status),
      } satisfies ProjectSummary;
    })
  );

  return projects.filter(Boolean) as ProjectSummary[];
};

export const importCorpus = async (request: ImportCorpusRequest): Promise<ProjectSummary> => {
  const resolvedInput = path.resolve(request.inputPath);
  const stats = await fs.stat(resolvedInput);
  if (!stats.isDirectory()) {
    throw new Error("Corpus path must be a directory");
  }

  const name = request.name?.trim() || path.basename(resolvedInput);
  let slug = slugify(name);
  let projectDir = path.join(projectsRoot, slug);
  let suffix = 1;

  while (true) {
    try {
      const existing = await fs.stat(projectDir);
      if (existing.isDirectory()) {
        suffix += 1;
        slug = `${slugify(name)}-${suffix}`;
        projectDir = path.join(projectsRoot, slug);
        continue;
      }
    } catch {
      break;
    }
  }

  await fs.mkdir(projectDir, { recursive: true });
  const config: ProjectConfig = {
    id: slug,
    name,
    inputPath: resolvedInput,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(config, null, 2));

  return {
    id: slug,
    name,
    path: projectDir,
    inputPath: resolvedInput,
    status: "idle",
  };
};
