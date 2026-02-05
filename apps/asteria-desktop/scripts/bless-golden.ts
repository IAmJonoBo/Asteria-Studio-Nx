import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { getRunDir, getRunManifestPath, getRunReviewQueuePath } from "../src/main/run-paths.ts";
import { info, note, section, startStep } from "./cli.ts";
import { createRunReporter } from "../../tools/observability/nodeReporter.mjs";

type RunPipeline = typeof import("../src/main/pipeline-runner.ts").runPipeline;

const repoRoot = path.resolve(process.cwd(), "..", "..");
const fixturesRoot = path.join(repoRoot, "tests", "fixtures", "golden_corpus", "v1");
const inputsDir = path.join(fixturesRoot, "inputs");
const truthDir = path.join(fixturesRoot, "truth");
const expectedDir = path.join(fixturesRoot, "expected");
const generatorPath = path.join(repoRoot, "tools", "golden_corpus", "generate.py");

const hashDirectory = async (dir: string): Promise<string> => {
  const files: string[] = [];
  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  await walk(dir);
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const rel = path.relative(dir, file);
    const data = await fs.readFile(file);
    hash.update(rel);
    hash.update(data);
  }
  return hash.digest("hex");
};

const resolvePython = (): string => {
  const candidates = [process.env.GOLDEN_PYTHON, "python3.11", "python3"].filter(
    Boolean
  ) as string[];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("No compatible Python found. Set GOLDEN_PYTHON=python3.11");
};

const runGenerator = (reporter) => {
  const resolveStep = startStep("Resolve Python");
  const python = resolvePython();
  resolveStep.end("ok", python);
  const runStep = startStep("Run generator");
  const phase = reporter.phase("generate", 1);
  phase.start();
  const result = spawnSync(
    python,
    [generatorPath, "--seed", "1337", "--out", fixturesRoot, "--run-id", reporter.runId],
    {
      stdio: "inherit",
    }
  );
  if (result.status !== 0) {
    runStep.end("fail");
    phase.end("fail");
    reporter.error("GOLDEN_GENERATE_FAILED", "Golden generator failed", {
      phase: "generate",
      file: generatorPath,
      line: 1,
      col: 0,
    });
    throw new Error("Golden generator failed");
  }
  runStep.end("ok");
  phase.end("ok");
};

const resolveRunPipeline = async (): Promise<RunPipeline> => {
  if (process.env.GOLDEN_USE_DIST === "1") {
    const { runPipeline } = await import("../dist/main/pipeline-runner.js");
    return runPipeline as RunPipeline;
  }
  const { runPipeline } = await import("../src/main/pipeline-runner.ts");
  return runPipeline as RunPipeline;
};

const copyDir = async (src: string, dest: string) => {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(src, dest, { recursive: true });
};

const main = async () => {
  const reporter = createRunReporter({
    tool: "golden_corpus",
    outputDir: process.env.ASTERIA_OBS_DIR ?? undefined,
  });
  try {
    section("GOLDEN BLESS");
    info(`Fixtures: ${fixturesRoot}`);

    const generatorStep = startStep("Generate fixtures (twice)");
    const generatorPhase = reporter.phase("generate-fixtures", 2);
    generatorPhase.start();
    runGenerator(reporter);
    const inputsHash = await hashDirectory(inputsDir);
    const truthHash = await hashDirectory(truthDir);
    generatorPhase.tick(1);
    runGenerator(reporter);
    generatorPhase.tick(1);
    const inputsHash2 = await hashDirectory(inputsDir);
    const truthHash2 = await hashDirectory(truthDir);
    if (inputsHash !== inputsHash2 || truthHash !== truthHash2) {
      generatorStep.end("fail", "non-deterministic output");
      generatorPhase.end("fail");
      reporter.error(
        "GOLDEN_NON_DETERMINISTIC",
        "Golden generator is not deterministic across runs",
        {
          phase: "generate-fixtures",
          file: generatorPath,
          line: 1,
          col: 0,
        }
      );
      throw new Error("Golden generator is not deterministic across runs");
    }
    generatorStep.end("ok", "deterministic");
    generatorPhase.end("ok");

    delete process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT;
    delete process.env.ASTERIA_REMOTE_LAYOUT_TOKEN;
    delete process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS;

    const runId = "golden-v1";
    const runRoot = path.join(process.cwd(), ".cache", "golden", "bless");
    await fs.mkdir(runRoot, { recursive: true });

    const runPipeline = await resolveRunPipeline();

    const pipelineStep = startStep("Run pipeline");
    const pipelinePhase = reporter.phase("pipeline", 1);
    pipelinePhase.start();
    const result = await runPipeline({
      projectRoot: inputsDir,
      projectId: runId,
      runId,
      targetDpi: 300,
      targetDimensionsMm: { width: 184.15, height: 260.35 },
      outputDir: runRoot,
      enableSpreadSplit: true,
      enableBookPriors: false,
      bookPriorsSampleCount: 0,
      pipelineConfigPath: path.join(repoRoot, "spec", "pipeline_config.yaml"),
    });

    if (!result.success) {
      pipelineStep.end("fail");
      pipelinePhase.end("fail");
      reporter.error("GOLDEN_PIPELINE_FAILED", "Pipeline failed during bless run", {
        phase: "pipeline",
        file: path.join(runRoot, "runs", runId, "report.json"),
        line: 1,
        col: 0,
      });
      throw new Error("Pipeline failed during bless run");
    }
    pipelineStep.end("ok");
    pipelinePhase.end("ok");

    const runDir = getRunDir(runRoot, runId);
    const copyStep = startStep("Copy expected outputs");
    const copyPhase = reporter.phase("copy-expected", 1);
    copyPhase.start();
    await copyDir(path.join(runDir, "normalized"), path.join(expectedDir, "normalized"));
    await copyDir(path.join(runDir, "sidecars"), path.join(expectedDir, "sidecars"));

    await fs.copyFile(getRunReviewQueuePath(runDir), path.join(expectedDir, "review-queue.json"));
    await fs.copyFile(getRunManifestPath(runDir), path.join(expectedDir, "manifest.json"));
    copyStep.end("ok");
    copyPhase.end("ok");

    section("GOLDEN OUTPUTS UPDATED");
    note(`Expected: ${expectedDir}`);
    reporter.finalize({ status: "ok", outputPaths: [expectedDir] });
    await reporter.flush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error("GOLDEN_BLESS_FAILED", message, {
      phase: "bless",
      file: path.join(process.cwd(), "apps", "asteria-desktop", "scripts", "bless-golden.ts"),
      line: 1,
      col: 0,
    });
    reporter.finalize({ status: "fail" });
    await reporter.flush();
    throw error;
  }
};

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
