import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importCorpus, listProjects } from "./projects.js";
import { getAsteriaRoot, loadPreferences, savePreferences } from "./preferences.js";

const getDevSampleCorpusPath = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "../../resources/sample-corpus");
};

const getBundledSampleCorpusPath = (): string =>
  app.isPackaged ? path.join(process.resourcesPath, "sample-corpus") : getDevSampleCorpusPath();

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "ENOENT") {
      console.warn(`Failed to stat sample corpus path ${target}`, error);
    }
    return false;
  }
};

export const provisionSampleCorpus = async (): Promise<{
  projectId: string;
  inputPath: string;
}> => {
  const userDataPath = app.getPath("userData");
  await loadPreferences({ userDataPath });
  const root = getAsteriaRoot(userDataPath);
  const targetInput = path.join(root, "sample-corpus");
  const sourceInput = getBundledSampleCorpusPath();

  if (!(await exists(sourceInput))) {
    throw new Error("Sample corpus missing from app resources");
  }

  if (!(await exists(targetInput))) {
    await ensureDir(path.dirname(targetInput));
    await fs.cp(sourceInput, targetInput, { recursive: true });
  }

  const projects = await listProjects();
  const existing = projects.find(
    (project) => path.resolve(project.inputPath) === path.resolve(targetInput)
  );
  if (existing) {
    await savePreferences({ sampleCorpusInstalled: true }, { userDataPath });
    return { projectId: existing.id, inputPath: existing.inputPath };
  }

  const summary = await importCorpus({ inputPath: targetInput, name: "Sample Corpus" });

  await savePreferences({ sampleCorpusInstalled: true }, { userDataPath });

  return { projectId: summary.id, inputPath: summary.inputPath };
};
