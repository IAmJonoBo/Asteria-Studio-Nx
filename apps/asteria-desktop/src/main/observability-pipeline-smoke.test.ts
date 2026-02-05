// @vitest-environment node
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd(), "../..");

describe("pipeline runner smoke", () => {
  it("emits observability JSONL in smoke mode", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asteria-pipeline-"));
    const obsDir = path.join(tmpDir, "observability");
    const runId = "pipeline-smoke";

    const result = spawnSync("node", ["tools/preflight/run-pipeline.mjs", repoRoot, "1"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PIPELINE_SMOKE: "1",
        ASTERIA_RUN_ID: runId,
        ASTERIA_OBS_DIR: obsDir,
      },
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const jsonlPath = path.join(obsDir, "pipeline", `${runId}.jsonl`);
    const jsonlRaw = await fsp.readFile(jsonlPath, "utf-8");
    expect(jsonlRaw.trim().length).toBeGreaterThan(0);
  });
});
