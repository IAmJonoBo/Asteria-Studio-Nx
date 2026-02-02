import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const readFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { readFile },
  readFile,
}));

import { loadPipelineConfig, loadProjectOverrides, resolvePipelineConfig } from "./pipeline-config";

describe("pipeline-config", () => {
  beforeEach(() => {
    readFile.mockReset();
  });

  it("loadPipelineConfig returns defaults when missing", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"));

    const result = await loadPipelineConfig("/tmp/missing.yaml");

    expect(result.loadedFromFile).toBe(false);
    expect(result.configPath).toBe("/tmp/missing.yaml");
    expect(result.config.version).toBe("0.1.0");
    expect(result.config.project.dpi).toBe(400);
  });

  it("loadPipelineConfig merges parsed config", async () => {
    readFile.mockResolvedValueOnce(
      [
        "project:",
        "  dpi: 600",
        "export:",
        "  formats:",
        "    - png",
        "models:",
        "  ocr:",
        "    languages:",
        "      - eng",
        "      - fra",
      ].join("\n")
    );

    const result = await loadPipelineConfig("/tmp/config.yaml");

    expect(result.loadedFromFile).toBe(true);
    expect(result.config.project.dpi).toBe(600);
    expect(result.config.export.formats).toEqual(["png"]);
    expect(result.config.models.ocr.languages).toEqual(["eng", "fra"]);
  });

  it("loadProjectOverrides reads JSON overrides", async () => {
    readFile
      .mockRejectedValueOnce(new Error("missing"))
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(JSON.stringify({ project: { dpi: 500 } }));

    const result = await loadProjectOverrides("demo-project");

    expect(result.overrides).toEqual({ project: { dpi: 500 } });
    expect(result.configPath).toBe(
      path.join(process.cwd(), "projects", "demo-project", "pipeline.config.json")
    );
  });

  it("resolvePipelineConfig applies overrides and env", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"));
    const { config: baseConfig } = await loadPipelineConfig();

    const { resolvedConfig, sources } = resolvePipelineConfig(baseConfig, {
      overrides: { project: { dpi: 500 } },
      env: {
        ASTERIA_TARGET_DPI: "650",
        ASTERIA_TARGET_WIDTH_MM: "210",
        ASTERIA_TARGET_HEIGHT_MM: "297",
      },
      configPath: "/tmp/pipeline_config.yaml",
      loadedFromFile: true,
      projectConfigPath: "/tmp/project-config.json",
      projectOverrides: { project: { dpi: 500 } },
    });

    expect(resolvedConfig.project.dpi).toBe(650);
    expect(resolvedConfig.project.target_dimensions).toEqual({
      width: 210,
      height: 297,
      unit: "mm",
    });
    expect(sources).toMatchObject({
      configPath: "/tmp/pipeline_config.yaml",
      loadedFromFile: true,
      projectConfigPath: "/tmp/project-config.json",
    });
  });
});
