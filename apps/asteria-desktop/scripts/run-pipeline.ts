#!/usr/bin/env ts-node
/**
 * CLI runner for executing the pipeline on the Mind, Myth and Magick corpus
 * and generating evaluation reports.
 */

import { runPipeline, evaluateResults } from "../src/main/pipeline-runner.ts";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getRunDir } from "../src/main/run-paths.ts";
import { loadEnv } from "../src/main/config.ts";
import { createProgressReporter, devLog, info, note, section, startStep } from "./cli.ts";
import { createRunReporter } from "../../tools/observability/nodeReporter.mjs";

loadEnv();

async function main(): Promise<void> {
  const projectRoot =
    process.argv[2] || path.join(process.cwd(), "projects/mind-myth-and-magick/input/raw");
  const sampleCount = process.argv[3] ? Number.parseInt(process.argv[3], 10) : undefined;
  const outputDir = path.join(process.cwd(), "pipeline-results");
  const runId =
    process.env.ASTERIA_RUN_ID ?? `run-${Date.now()}-${crypto.randomUUID().split("-")[0]}`;
  const reporter = createRunReporter({
    tool: "pipeline",
    runId,
    outputDir: process.env.ASTERIA_OBS_DIR ?? undefined,
  });

  section("ASTERIA PIPELINE EXECUTION");
  info(`Project Root: ${projectRoot}`);
  info(`Sample Count: ${sampleCount || "all pages"}`);
  info(`Output Dir: ${outputDir}`);

  try {
    // Verify project exists
    const verifyStep = startStep("Verify project root");
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Project root is not a directory: ${projectRoot}`);
    }
    verifyStep.end("ok");

    // Run pipeline
    const runStep = startStep("Run pipeline");
    const startTime = Date.now();
    const progress = createProgressReporter("Pipeline progress");
    let activeStage: string | null = null;
    const stagePhases = new Map<string, ReturnType<typeof reporter.phase>>();
    const getStagePhase = (stage: string, total?: number) => {
      if (!stagePhases.has(stage)) {
        const phase = reporter.phase(stage, total ?? 0);
        phase.start();
        stagePhases.set(stage, phase);
      }
      return stagePhases.get(stage)!;
    };
    const result = await runPipeline({
      projectRoot,
      projectId: "mind-myth-magick",
      runId,
      targetDpi: 300,
      targetDimensionsMm: { width: 184.15, height: 260.35 },
      sampleCount,
      outputDir,
      onProgress: (event) => {
        if (event.stage && event.stage !== activeStage) {
          if (activeStage && stagePhases.has(activeStage)) {
            stagePhases.get(activeStage)!.end("ok");
          }
          devLog(`Stage: ${event.stage}`);
          activeStage = event.stage;
        }
        progress.update({
          processed: event.processed ?? 0,
          total: event.total ?? 0,
          stage: event.stage,
          throughput: event.throughput,
        });
        const phase = getStagePhase(event.stage ?? "progress", event.total ?? 0);
        phase.set(event.processed ?? 0, event.total ?? 0, {
          stage: event.stage,
          throughput: event.throughput,
        });
      },
    });
    const totalTime = Date.now() - startTime;
    progress.end(result.success ? "ok" : "fail");
    runStep.end(result.success ? "ok" : "fail");

    section("PIPELINE RESULTS");
    info(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);
    info(`Run ID: ${result.runId}`);
    info(`Pages Processed: ${result.pageCount}`);
    info(`Duration: ${(totalTime / 1000).toFixed(2)}s`);
    info(`Throughput: ${((result.pageCount / totalTime) * 1000).toFixed(2)} pages/sec`);

    if (!result.success) {
      note("Errors:");
      result.errors.forEach((e) => {
        info(`[${e.phase}] ${e.message}`);
        reporter.error("PIPELINE_FAILED", `[${e.phase}] ${e.message}`, {
          phase: e.phase,
          file: path.join(getRunDir(outputDir, result.runId), "report.json"),
          line: 1,
          col: 0,
        });
      });
      reporter.finalize({ status: "fail" });
      await reporter.flush();
      process.exit(1);
    }

    // Evaluate results
    section("EVALUATION");
    const evalStep = startStep("Compute evaluation");
    const evaluation = evaluateResults(result);
    evalStep.end("ok");

    note("Observations:");
    evaluation.observations.forEach((obs) => {
      info(`- ${obs}`);
    });

    note("Metrics:");
    Object.entries(evaluation.metrics).forEach(([key, value]) => {
      let displayValue: string | number = value as string | number;
      if (typeof value === "number") {
        displayValue = Number.isInteger(value) ? value : value.toFixed(2);
      }
      info(`${key}: ${displayValue}`);
    });

    note("Recommendations:");
    evaluation.recommendations.forEach((rec) => {
      info(`- ${rec}`);
    });

    // Save full evaluation report
    const runDir = getRunDir(outputDir, result.runId);
    const reportPath = path.join(runDir, "evaluation.json");
    const writeStep = startStep("Write evaluation report");
    await fs.writeFile(
      reportPath,
      JSON.stringify({ executedAt: new Date().toISOString(), result, evaluation }, null, 2)
    );
    writeStep.end("ok", reportPath);

    if (activeStage && stagePhases.has(activeStage)) {
      stagePhases.get(activeStage)!.end("ok");
    }
    reporter.finalize({
      status: "ok",
      outputPaths: [path.join(getRunDir(outputDir, result.runId), "report.json"), reportPath],
    });
    await reporter.flush();
  } catch (error) {
    console.error("Pipeline execution failed:");
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    reporter.error("PIPELINE_EXECUTION_FAILED", message, {
      phase: "pipeline",
      file: path.join(process.cwd(), "apps", "asteria-desktop", "scripts", "run-pipeline.ts"),
      line: 1,
      col: 0,
      attrs: { projectRoot },
    });
    reporter.finalize({ status: "fail" });
    await reporter.flush();
    process.exit(1);
  }
}

await main();
