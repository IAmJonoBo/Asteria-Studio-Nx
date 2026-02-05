// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { createRunReporter } from "../../../../tools/observability/nodeReporter.mjs";

describe("node reporter", () => {
  it("writes JSONL events and ASTERIA_ERROR line", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asteria-obs-"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const reporter = createRunReporter({
      tool: "unit",
      runId: "test-run",
      outputDir: tmpDir,
      enableConsole: false,
      minIntervalMs: 0,
    });

    const phase = reporter.phase("setup", 2);
    phase.start();
    phase.tick(1);
    phase.end("ok");

    reporter.error("TEST_ERROR", "boom", {
      file: path.join(tmpDir, "trace.log"),
      line: 1,
      col: 0,
      phase: "setup",
    });

    reporter.finalize({ status: "fail" });
    await reporter.flush();

    const jsonlPath = path.join(tmpDir, "unit", "test-run.jsonl");
    const raw = await fsp.readFile(jsonlPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.eventVersion).toBe("1");
    expect(parsed.runId).toBe("test-run");

    expect(stderrSpy).toHaveBeenCalled();
    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1]?.[0] ?? "";
    expect(String(lastCall)).toContain("ASTERIA_ERROR");

    stderrSpy.mockRestore();
  });

  it("throttles progress emissions", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asteria-obs-"));
    const reporter = createRunReporter({
      tool: "unit",
      runId: "test-throttle",
      outputDir: tmpDir,
      enableConsole: false,
      minIntervalMs: 1000,
    });

    const phase = reporter.phase("work", 10);
    phase.start();
    for (let i = 0; i < 5; i += 1) {
      phase.set(i + 1, 10);
    }
    phase.end("ok");

    reporter.finalize({ status: "ok" });
    await reporter.flush();

    const stats = reporter.getStats();
    expect(stats.progressEmits).toBe(1);
  });
});
