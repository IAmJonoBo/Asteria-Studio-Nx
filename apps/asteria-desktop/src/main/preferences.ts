import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { AppPreferences } from "../ipc/contracts.js";

const ASTERIA_DIR_NAME = "asteria";
const PREFERENCES_FILE = "preferences.json";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isTruthyEnv = (value: string | undefined): boolean => {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const require = createRequire(import.meta.url);

const getElectronApp = (): { getPath: (name: "userData") => string } | null => {
  try {
    const electron = require("electron") as { app?: { getPath: (name: "userData") => string } };
    return electron.app ?? null;
  } catch (error) {
    console.warn("Failed to resolve Electron app", error);
    return null;
  }
};

const resolveUserDataPath = (): string =>
  getElectronApp()?.getPath("userData") ?? path.join(process.cwd(), ".asteria");

export const getAsteriaRoot = (userDataPath?: string): string =>
  path.join(userDataPath ?? resolveUserDataPath(), ASTERIA_DIR_NAME);

export const getPreferencesPath = (userDataPath?: string): string =>
  path.join(getAsteriaRoot(userDataPath), PREFERENCES_FILE);

export const getDefaultPreferences = (userDataPath?: string): AppPreferences => {
  const root = getAsteriaRoot(userDataPath);
  return {
    outputDir: path.join(root, "pipeline-results"),
    projectsDir: path.join(root, "projects"),
    firstRunComplete: false,
    sampleCorpusInstalled: false,
    lastVersion: undefined,
  };
};

const applyRuntimeOverrides = (prefs: AppPreferences): AppPreferences => {
  const outputOverride = process.env.ASTERIA_OUTPUT_DIR;
  const projectsOverride = process.env.ASTERIA_PROJECTS_DIR;
  const disableOnboarding = isTruthyEnv(process.env.ASTERIA_DISABLE_ONBOARDING);
  return {
    ...prefs,
    outputDir:
      outputOverride && isNonEmptyString(outputOverride) ? outputOverride : prefs.outputDir,
    projectsDir:
      projectsOverride && isNonEmptyString(projectsOverride) ? projectsOverride : prefs.projectsDir,
    firstRunComplete: disableOnboarding ? true : prefs.firstRunComplete,
  };
};

const normalizePreferences = (
  raw: Partial<AppPreferences> | null,
  defaults: AppPreferences
): AppPreferences => ({
  outputDir: isNonEmptyString(raw?.outputDir) ? raw.outputDir : defaults.outputDir,
  projectsDir: isNonEmptyString(raw?.projectsDir) ? raw.projectsDir : defaults.projectsDir,
  firstRunComplete: typeof raw?.firstRunComplete === "boolean" ? raw.firstRunComplete : false,
  sampleCorpusInstalled:
    typeof raw?.sampleCorpusInstalled === "boolean" ? raw.sampleCorpusInstalled : false,
  lastVersion: isNonEmptyString(raw?.lastVersion) ? raw.lastVersion : undefined,
});

const readPreferencesFile = async (
  userDataPath?: string
): Promise<Partial<AppPreferences> | null> => {
  const prefsPath = getPreferencesPath(userDataPath);
  try {
    const raw = await fs.readFile(prefsPath, "utf-8");
    return JSON.parse(raw) as Partial<AppPreferences>;
  } catch (error) {
    console.warn(`Failed to read preferences at ${prefsPath}`, error);
    return null;
  }
};

const writePreferencesFile = async (
  prefs: AppPreferences,
  userDataPath?: string
): Promise<void> => {
  const prefsPath = getPreferencesPath(userDataPath);
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify(prefs, null, 2));
};

const safeMoveDirectory = async (source: string, destination: string): Promise<boolean> => {
  try {
    await fs.stat(source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "ENOENT") {
      console.warn(`Failed to stat source directory ${source}`, error);
    }
    return false;
  }

  try {
    await fs.stat(destination);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "ENOENT") {
      console.warn(`Failed to stat destination directory ${destination}`, error);
    }
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.rename(source, destination);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EXDEV") {
      throw error;
    }
    await fs.cp(source, destination, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
    return true;
  }
};

export const migrateLegacyData = async (
  userDataPath?: string
): Promise<{ migratedOutput: boolean; migratedProjects: boolean }> => {
  const outputOverride = process.env.ASTERIA_OUTPUT_DIR;
  const projectsOverride = process.env.ASTERIA_PROJECTS_DIR;
  const defaults = getDefaultPreferences(userDataPath);

  const legacyOutput = path.join(process.cwd(), "pipeline-results");
  const legacyProjects = path.join(process.cwd(), "projects");

  const migratedOutput =
    outputOverride && isNonEmptyString(outputOverride)
      ? false
      : await safeMoveDirectory(legacyOutput, defaults.outputDir);
  const migratedProjects =
    projectsOverride && isNonEmptyString(projectsOverride)
      ? false
      : await safeMoveDirectory(legacyProjects, defaults.projectsDir);

  return { migratedOutput, migratedProjects };
};

let cachedPreferences: AppPreferences | null = null;
let cachedUserDataPath: string | null = null;

export const loadPreferences = async (
  options: {
    userDataPath?: string;
    skipMigration?: boolean;
  } = {}
): Promise<AppPreferences> => {
  const userDataPath = options.userDataPath ?? resolveUserDataPath();
  if (!options.skipMigration) {
    await migrateLegacyData(userDataPath);
  }
  const defaults = getDefaultPreferences(userDataPath);
  const raw = await readPreferencesFile(userDataPath);
  const normalized = normalizePreferences(raw, defaults);
  cachedPreferences = normalized;
  cachedUserDataPath = userDataPath;
  return applyRuntimeOverrides(normalized);
};

export const savePreferences = async (
  partial: Partial<AppPreferences>,
  options: { userDataPath?: string } = {}
): Promise<AppPreferences> => {
  const userDataPath = options.userDataPath ?? resolveUserDataPath();
  const defaults = getDefaultPreferences(userDataPath);
  const current =
    cachedPreferences && cachedUserDataPath === userDataPath
      ? cachedPreferences
      : normalizePreferences(await readPreferencesFile(userDataPath), defaults);

  const updated: AppPreferences = { ...current };
  (Object.keys(partial) as Array<keyof AppPreferences>).forEach((key) => {
    const value = partial[key];
    if (value !== undefined) {
      updated[key] = value as never;
    }
  });

  await writePreferencesFile(updated, userDataPath);
  cachedPreferences = updated;
  cachedUserDataPath = userDataPath;
  return applyRuntimeOverrides(updated);
};

export const resolveOutputDir = async (): Promise<string> => {
  const prefs = await loadPreferences();
  return prefs.outputDir;
};

export const resolveProjectsRoot = async (): Promise<string> => {
  const prefs = await loadPreferences();
  return prefs.projectsDir;
};
