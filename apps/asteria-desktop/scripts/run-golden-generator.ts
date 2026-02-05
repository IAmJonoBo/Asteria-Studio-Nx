import path from "node:path";
import { spawnSync } from "node:child_process";
import { info, section, startStep } from "./cli.ts";
import { createRunReporter } from "../../tools/observability/nodeReporter.mjs";

const repoRoot = path.resolve(process.cwd(), "..", "..");
const fixturesRoot = path.join(repoRoot, "tests", "fixtures", "golden_corpus", "v1");
const generatorPath = path.join(repoRoot, "tools", "golden_corpus", "generate.py");

const resolvePython = (): string => {
  const candidates = [process.env.GOLDEN_PYTHON, "python3.11", "python3"].filter(
    Boolean
  ) as string[];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  throw new Error("No compatible Python found. Set GOLDEN_PYTHON=python3.11");
};

const reporter = createRunReporter({
  tool: "golden_corpus",
  outputDir: process.env.ASTERIA_OBS_DIR ?? undefined,
});

const main = async () => {
  section("GOLDEN CORPUS GENERATION");
  const resolveStep = startStep("Resolve Python");
  const resolvePhase = reporter.phase("resolve-python", 1);
  resolvePhase.start();
  const python = resolvePython();
  resolveStep.end("ok", python);
  resolvePhase.end("ok");

  info(`Output: ${fixturesRoot}`);
  const runStep = startStep("Run generator");
  const runPhase = reporter.phase("generate", 1);
  runPhase.start();
  const result = spawnSync(
    python,
    [generatorPath, "--seed", "1337", "--out", fixturesRoot, "--run-id", reporter.runId],
    {
      stdio: "inherit",
    }
  );
  if (result.status !== 0) {
    runStep.end("fail");
    runPhase.end("fail");
    reporter.error("GOLDEN_GENERATE_FAILED", "Golden generator exited non-zero", {
      phase: "generate",
      file: generatorPath,
      line: 1,
      col: 0,
      attrs: { status: result.status },
    });
    reporter.finalize({ status: "fail" });
    await reporter.flush();
    process.exit(result.status ?? 1);
  }
  runStep.end("ok");
  runPhase.end("ok");
  reporter.finalize({ status: "ok", outputPaths: [fixturesRoot] });
  await reporter.flush();
};

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  reporter.error("GOLDEN_GENERATE_FAILED", message, {
    phase: "generate",
    file: generatorPath,
    line: 1,
    col: 0,
  });
  reporter.finalize({ status: "fail" });
  await reporter.flush();
  process.exit(1);
});
