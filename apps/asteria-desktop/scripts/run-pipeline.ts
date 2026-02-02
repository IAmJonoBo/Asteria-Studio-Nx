#!/usr/bin/env ts-node
/* eslint-disable no-console */
/**
 * CLI runner for executing the pipeline on the Mind, Myth and Magick corpus
 * and generating evaluation reports.
 */

import { runPipeline, evaluateResults } from "../src/main/pipeline-runner.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { getRunDir } from "../src/main/run-paths.ts";

async function main(): Promise<void> {
  const projectRoot =
    process.argv[2] || path.join(process.cwd(), "projects/mind-myth-and-magick/input/raw");
  const sampleCount = process.argv[3] ? Number.parseInt(process.argv[3], 10) : undefined;
  const outputDir = path.join(process.cwd(), "pipeline-results");

  console.log("=".repeat(80));
  console.log("ASTERIA PIPELINE EXECUTION");
  console.log("=".repeat(80));
  console.log(`Project Root: ${projectRoot}`);
  console.log(`Sample Count: ${sampleCount || "all pages"}`);
  console.log(`Output Dir: ${outputDir}`);
  console.log("");

  try {
    // Verify project exists
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Project root is not a directory: ${projectRoot}`);
    }

    // Run pipeline
    console.log("Starting pipeline execution...");
    const startTime = Date.now();
    const result = await runPipeline({
      projectRoot,
      projectId: "mind-myth-magick",
      targetDpi: 300,
      targetDimensionsMm: { width: 184.15, height: 260.35 },
      sampleCount,
      outputDir,
    });
    const totalTime = Date.now() - startTime;

    console.log("");
    console.log("=".repeat(80));
    console.log("PIPELINE RESULTS");
    console.log("=".repeat(80));
    console.log(`Status: ${result.success ? "✓ SUCCESS" : "✗ FAILED"}`);
    console.log(`Run ID: ${result.runId}`);
    console.log(`Pages Processed: ${result.pageCount}`);
    console.log(`Duration: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`Throughput: ${((result.pageCount / totalTime) * 1000).toFixed(2)} pages/sec`);
    console.log("");

    if (!result.success) {
      console.log("ERRORS:");
      result.errors.forEach((e) => {
        console.log(`  [${e.phase}] ${e.message}`);
      });
      console.log("");
      process.exit(1);
    }

    // Evaluate results
    console.log("=".repeat(80));
    console.log("EVALUATION");
    console.log("=".repeat(80));
    const evaluation = evaluateResults(result);

    console.log("\nOBSERVATIONS:");
    evaluation.observations.forEach((obs) => {
      console.log(`  • ${obs}`);
    });

    console.log("\nMETRICS:");
    Object.entries(evaluation.metrics).forEach(([key, value]) => {
      let displayValue: string | number = value as string | number;
      if (typeof value === "number") {
        displayValue = Number.isInteger(value) ? value : value.toFixed(2);
      }
      console.log(`  ${key}: ${displayValue}`);
    });

    console.log("\nRECOMMENDATIONS:");
    evaluation.recommendations.forEach((rec) => {
      console.log(`  → ${rec}`);
    });

    console.log("");
    console.log("=".repeat(80));

    // Save full evaluation report
    const runDir = getRunDir(outputDir, result.runId);
    const reportPath = path.join(runDir, "evaluation.json");
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          result,
          evaluation,
        },
        null,
        2
      )
    );
    console.log(`Full evaluation report saved to: ${reportPath}`);
    console.log("");
  } catch (error) {
    console.error("Pipeline execution failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
