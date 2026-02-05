#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRunReporter } from "../observability/nodeReporter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIST_MAIN = path.join(ROOT, "apps", "asteria-desktop", "dist", "main");
const PIPELINE_PATH = path.join(DIST_MAIN, "pipeline-runner.js");
const RUN_PATHS = path.join(DIST_MAIN, "run-paths.js");

const [corpusPathArg, sampleCountArg] = process.argv.slice(2);
if (!corpusPathArg) {
  const reporter = createRunReporter({ tool: "pipeline" });
  reporter.error("PIPELINE_USAGE", "Usage: run-pipeline.mjs <corpusPath> [sampleCount]", {
    file: path.join(process.cwd(), "tools", "preflight", "run-pipeline.mjs"),
    line: 1,
    col: 0,
  });
  reporter.finalize({ status: "fail" });
  await reporter.flush();
  process.exit(1);
}

const corpusPath = path.resolve(corpusPathArg);
const sampleCount = sampleCountArg ? Number.parseInt(sampleCountArg, 10) : undefined;
const outputDir = process.env.ASTERIA_OUTPUT_DIR ?? path.join(ROOT, "pipeline-results");
const runId =
  process.env.ASTERIA_RUN_ID ?? `run-${Date.now()}-${crypto.randomUUID().split("-")[0]}`;
const reporter = createRunReporter({
  tool: "pipeline",
  runId,
  outputDir: process.env.ASTERIA_OBS_DIR ?? undefined,
});

if (process.env.PIPELINE_SMOKE === "1") {
  const smokePhase = reporter.phase("smoke", 1);
  smokePhase.start();
  smokePhase.set(1, 1);
  smokePhase.end("ok");
  reporter.finalize({ status: "ok" });
  await reporter.flush();
  console.log("Pipeline smoke complete.");
  process.exit(0);
}

const exists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(PIPELINE_PATH))) {
  reporter.error("PIPELINE_BUILD_MISSING", `Missing build output: ${PIPELINE_PATH}`, {
    file: PIPELINE_PATH,
    line: 1,
    col: 0,
  });
  reporter.finalize({ status: "fail" });
  await reporter.flush();
  console.error("Run `pnpm nx run asteria-desktop:build:main` first.");
  process.exit(1);
}

const pipelineModule = await import(pathToFileURL(PIPELINE_PATH).href);
const runPathsModule = await import(pathToFileURL(RUN_PATHS).href);
const { runPipeline, evaluateResults } = pipelineModule;
const { getRunDir } = runPathsModule;

if (typeof runPipeline !== "function") {
  reporter.error("PIPELINE_RUNNER_MISSING", "Pipeline runner not available in build output.", {
    file: PIPELINE_PATH,
    line: 1,
    col: 0,
  });
  reporter.finalize({ status: "fail" });
  await reporter.flush();
  process.exit(1);
}

const startTime = Date.now();
let activeStage = null;
const stagePhases = new Map();
const getStagePhase = (stage, total) => {
  if (!stagePhases.has(stage)) {
    const p = reporter.phase(stage, total ?? 0);
    p.start();
    stagePhases.set(stage, p);
  }
  return stagePhases.get(stage);
};

const result = await runPipeline({
  projectRoot: corpusPath,
  projectId: "preflight",
  runId,
  targetDpi: 300,
  targetDimensionsMm: { width: 184.15, height: 260.35 },
  sampleCount,
  outputDir,
  onProgress: (event) => {
    if (event.stage && event.stage !== activeStage) {
      if (activeStage && stagePhases.has(activeStage)) {
        stagePhases.get(activeStage).end("ok");
      }
      activeStage = event.stage;
    }
    const phase = getStagePhase(event.stage ?? "progress", event.total ?? 0);
    phase.set(event.processed ?? 0, event.total ?? 0, {
      throughput: event.throughput,
      stage: event.stage,
    });
  },
});
const totalTime = Date.now() - startTime;

console.log(`Project Root: ${corpusPath}`);
console.log(`Sample Count: ${sampleCount || "all pages"}`);
console.log(`Output Dir: ${outputDir}`);
console.log(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);
console.log(`Run ID: ${result.runId}`);
console.log(`Pages Processed: ${result.pageCount}`);
console.log(`Duration: ${(totalTime / 1000).toFixed(2)}s`);
console.log(`Throughput: ${((result.pageCount / totalTime) * 1000).toFixed(2)} pages/sec`);

if (!result.success) {
  console.error("Errors:");
  result.errors.forEach((err) => {
    console.error(`[${err.phase}] ${err.message}`);
    reporter.error("PIPELINE_FAILED", `[${err.phase}] ${err.message}`, {
      phase: err.phase,
      file: path.join(getRunDir(outputDir, result.runId), "report.json"),
      line: 1,
      col: 0,
    });
  });
  reporter.finalize({ status: "fail" });
  await reporter.flush();
  process.exit(1);
}

if (typeof evaluateResults === "function") {
  const evaluation = evaluateResults(result);
  const runDir = getRunDir(outputDir, result.runId);
  const reportPath = path.join(runDir, "evaluation.json");
  await fs.writeFile(
    reportPath,
    JSON.stringify({ executedAt: new Date().toISOString(), result, evaluation }, null, 2)
  );
}

if (activeStage && stagePhases.has(activeStage)) {
  stagePhases.get(activeStage).end("ok");
}

reporter.finalize({
  status: result.success ? "ok" : "fail",
  outputPaths: [path.join(getRunDir(outputDir, result.runId), "report.json")],
});
await reporter.flush();
