// @vitest-environment node
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd(), "../..");

const resolvePython = (): string => {
  const candidates = [process.env.GOLDEN_PYTHON, "python3.11", "python3", "python"].filter(
    Boolean
  ) as string[];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("No compatible Python found for golden smoke test.");
};

describe("golden corpus smoke", () => {
  it("writes outputs and observability JSONL", async () => {
    const python = resolvePython();
    const depsCheck = spawnSync(
      python,
      ["-c", "import cv2, imagehash, numpy, PIL, pydantic; print('ok')"],
      { stdio: "ignore" }
    );
    if (depsCheck.status !== 0) {
      return;
    }
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asteria-golden-"));
    const obsDir = path.join(tmpDir, "observability");
    const outDir = path.join(tmpDir, "golden");
    const runId = "golden-smoke";

    const result = spawnSync(
      python,
      ["tools/golden_corpus/generate.py", "--seed", "1337", "--out", outDir, "--run-id", runId],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ASTERIA_OBS_DIR: obsDir,
        },
        encoding: "utf-8",
      }
    );

    expect(result.status).toBe(0);
    const manifestPath = path.join(outDir, "manifest.json");
    const manifestRaw = await fsp.readFile(manifestPath, "utf-8");
    expect(manifestRaw.length).toBeGreaterThan(0);

    const jsonlPath = path.join(obsDir, "golden_corpus", `${runId}.jsonl`);
    const jsonlRaw = await fsp.readFile(jsonlPath, "utf-8");
    expect(jsonlRaw.trim().length).toBeGreaterThan(0);
  });
});
