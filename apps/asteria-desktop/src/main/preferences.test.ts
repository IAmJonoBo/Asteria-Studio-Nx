import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());
const cp = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { readFile, writeFile, mkdir, stat, rename, cp, rm },
  readFile,
  writeFile,
  mkdir,
  stat,
  rename,
  cp,
  rm,
}));

import {
  getAsteriaRoot,
  getDefaultPreferences,
  loadPreferences,
  migrateLegacyData,
  savePreferences,
} from "./preferences.js";

describe("preferences", () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
    readFile.mockReset();
    writeFile.mockReset();
    mkdir.mockReset();
    stat.mockReset();
    rename.mockReset();
    cp.mockReset();
    rm.mockReset();
    delete process.env.ASTERIA_OUTPUT_DIR;
    delete process.env.ASTERIA_PROJECTS_DIR;
    delete process.env.ASTERIA_DISABLE_ONBOARDING;
  });

  it("uses defaults and applies env overrides", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"));
    process.env.ASTERIA_OUTPUT_DIR = "/tmp/out";
    process.env.ASTERIA_PROJECTS_DIR = "/tmp/projects";
    process.env.ASTERIA_DISABLE_ONBOARDING = "true";

    const prefs = await loadPreferences({ userDataPath: "/tmp/userdata", skipMigration: true });

    expect(prefs.outputDir).toBe("/tmp/out");
    expect(prefs.projectsDir).toBe("/tmp/projects");
    expect(prefs.firstRunComplete).toBe(true);
  });

  it("saves preference updates", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        outputDir: "/tmp/out",
        projectsDir: "/tmp/projects",
        firstRunComplete: false,
        sampleCorpusInstalled: false,
      })
    );

    const updated = await savePreferences(
      { sampleCorpusInstalled: true },
      { userDataPath: "/tmp/u" }
    );

    expect(writeFile).toHaveBeenCalledOnce();
    expect(updated.sampleCorpusInstalled).toBe(true);
  });

  it("migrates legacy directories when present", async () => {
    const userDataPath = "/tmp/userdata";
    const defaults = getDefaultPreferences(userDataPath);

    stat.mockImplementation(async (target: string) => {
      if (target === path.join(process.cwd(), "pipeline-results")) return {};
      if (target === path.join(process.cwd(), "projects")) return {};
      if (target === defaults.outputDir) throw new Error("missing");
      if (target === defaults.projectsDir) throw new Error("missing");
      return {};
    });

    await migrateLegacyData(userDataPath);

    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("resolves default root under user data", () => {
    const root = getAsteriaRoot("/tmp/userdata");
    expect(root).toBe(path.join("/tmp/userdata", "asteria"));
  });
});
