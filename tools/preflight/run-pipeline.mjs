#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIST_MAIN = path.join(ROOT, "apps", "asteria-desktop", "dist", "main");
const PIPELINE_PATH = path.join(DIST_MAIN, "pipeline-runner.js");
const RUN_PATHS = path.join(DIST_MAIN, "run-paths.js");

const [corpusPathArg, sampleCountArg] = process.argv.slice(2);
if (!corpusPathArg) {
  console.error("Usage: run-pipeline.mjs <corpusPath> [sampleCount]");
  process.exit(1);
}

const corpusPath = path.resolve(corpusPathArg);
const sampleCount = sampleCountArg ? Number.parseInt(sampleCountArg, 10) : undefined;
const outputDir = process.env.ASTERIA_OUTPUT_DIR ?? path.join(ROOT, "pipeline-results");

const exists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(PIPELINE_PATH))) {
  console.error(`Missing build output: ${PIPELINE_PATH}`);
  console.error("Run `pnpm nx run asteria-desktop:build:main` first.");
  process.exit(1);
}

const pipelineModule = await import(pathToFileURL(PIPELINE_PATH).href);
const runPathsModule = await import(pathToFileURL(RUN_PATHS).href);
const { runPipeline, evaluateResults } = pipelineModule;
const { getRunDir } = runPathsModule;

if (typeof runPipeline !== "function") {
  console.error("Pipeline runner not available in build output.");
  process.exit(1);
}

const startTime = Date.now();
const result = await runPipeline({
  projectRoot: corpusPath,
  projectId: "preflight",
  targetDpi: 300,
  targetDimensionsMm: { width: 184.15, height: 260.35 },
  sampleCount,
  outputDir,
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
  });
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
