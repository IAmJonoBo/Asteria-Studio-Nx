// @vitest-environment node
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd(), "../..");

const runPreflight = async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asteria-preflight-"));
  const artifactsDir = path.join(tmpDir, "artifacts");
  const obsDir = path.join(tmpDir, "observability");

  const result = spawnSync("node", ["tools/preflight/run-preflight.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PREFLIGHT_SMOKE: "1",
      PREFLIGHT_SKIP_PIPELINE: "1",
      PREFLIGHT_ARTIFACTS_DIR: path.join(artifactsDir, "preflight"),
      ASTERIA_OBS_DIR: obsDir,
    },
    encoding: "utf-8",
  });

  return { result, artifactsDir, obsDir };
};

describe("preflight smoke", () => {
  it("writes reports and observability JSONL", async () => {
    const { result, artifactsDir, obsDir } = await runPreflight();
    expect(result.status).toBe(0);

    const reportJson = path.join(artifactsDir, "preflight", "preflight-report.json");
    const raw = await fsp.readFile(reportJson, "utf-8");
    const report = JSON.parse(raw) as { metadata: { runId: string } };
    expect(report.metadata.runId).toBeTruthy();

    const jsonlPath = path.join(obsDir, "preflight", `${report.metadata.runId}.jsonl`);
    const jsonlRaw = await fsp.readFile(jsonlPath, "utf-8");
    expect(jsonlRaw.trim().length).toBeGreaterThan(0);
  });
});
