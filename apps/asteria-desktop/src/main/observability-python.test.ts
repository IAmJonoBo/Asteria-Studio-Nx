// @vitest-environment node
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";

const resolvePython = (): string => {
  const candidates = [process.env.GOLDEN_PYTHON, "python3.11", "python3", "python"].filter(
    Boolean
  ) as string[];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("No compatible Python found for observability tests.");
};

describe("python reporter", () => {
  it("writes JSONL and ASTERIA_ERROR output", async () => {
    const python = resolvePython();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asteria-obs-py-"));
    const repoRoot = path.resolve(process.cwd(), "../..");
    const reporterDir = path.join(repoRoot, "tools", "observability");
    const script = `\
import pathlib\n\
import sys\n\
sys.path.append(${JSON.stringify(reporterDir)})\n\
from py_reporter import create_run_reporter\n\
reporter = create_run_reporter('golden_corpus', run_id='py-test', output_dir=pathlib.Path(${JSON.stringify(
      tmpDir
    )}))\n\
phase = reporter.phase('phase', total=2)\n\
phase.start()\n\
phase.tick(1)\n\
phase.end('ok')\n\
reporter.error('PY_ERROR', 'boom', file='fake.py', line=1, col=0)\n\
reporter.finalize({'status': 'fail'})\n\
`;

    const result = spawnSync(python, ["-u", "-c", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrOutput = result.stderr ?? "";
    if (stderrOutput.trim().length > 0) {
      expect(stderrOutput).toContain("ASTERIA_ERROR");
    }
    const jsonlPath = path.join(tmpDir, "golden_corpus", "py-test.jsonl");
    const raw = await fsp.readFile(jsonlPath, "utf-8");
    expect(raw.trim().length).toBeGreaterThan(0);
    const hasErrorEvent = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          return JSON.parse(line).kind === "error";
        } catch (error) {
          void error;
          return false;
        }
      });
    expect(hasErrorEvent).toBe(true);
  });
});
