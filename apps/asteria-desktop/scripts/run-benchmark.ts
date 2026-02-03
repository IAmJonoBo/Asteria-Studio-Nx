#!/usr/bin/env ts-node
/* eslint-disable no-console */
/**
 * Benchmark runner for fixed-size corpus runs.
 * Captures per-stage latency and throughput and writes results to disk.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { runPipeline } from "../src/main/pipeline-runner.ts";
import { loadEnv } from "../src/main/config.ts";
import { info, note, section, startStep } from "./cli.ts";

type StageTiming = {
  stage: string;
  startMs: number;
  endMs: number;
  processed: number;
  total: number;
  maxEventThroughput: number;
  eventCount: number;
};

type StageMetric = {
  stage: string;
  processed: number;
  total: number;
  latencyMs: number;
  throughputPagesPerSecond: number;
  maxEventThroughput: number;
  startedAt: string;
  finishedAt: string;
};

const DEFAULT_SAMPLE_COUNT = 8;
const DEFAULT_LATENCY_THRESHOLD_MS = 180_000;
const DEFAULT_OUTPUT_DIR = "benchmark-results";
const IGNORED_STAGES = new Set(["starting", "complete", "cancelled", "error"]);

loadEnv();

const parseNumberEnv = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function main(): Promise<void> {
  const projectRoot =
    process.env.ASTERIA_BENCHMARK_CORPUS ??
    path.join(process.cwd(), "projects/mind-myth-and-magick/input/raw");
  const sampleCount = parseNumberEnv(
    process.env.ASTERIA_BENCHMARK_SAMPLE_COUNT,
    DEFAULT_SAMPLE_COUNT
  );
  const maxStageLatencyMs = parseNumberEnv(
    process.env.ASTERIA_BENCHMARK_MAX_STAGE_LATENCY_MS,
    DEFAULT_LATENCY_THRESHOLD_MS
  );
  const outputDir = path.resolve(
    process.cwd(),
    process.env.ASTERIA_BENCHMARK_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR
  );

  section("ASTERIA BENCHMARK");
  info(`Corpus Root: ${projectRoot}`);
  info(`Sample Count: ${sampleCount}`);
  info(`Latency Threshold: ${maxStageLatencyMs}ms`);
  info(`Output Dir: ${outputDir}`);

  const stageTimings = new Map<string, StageTiming>();

  try {
    const verifyStep = startStep("Verify corpus root");
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Corpus root is not a directory: ${projectRoot}`);
    }
    verifyStep.end("ok");

    const runStep = startStep("Run benchmark pipeline");
    const runStart = Date.now();
    const result = await runPipeline({
      projectRoot,
      projectId: "mind-myth-magick",
      targetDpi: 300,
      targetDimensionsMm: { width: 184.15, height: 260.35 },
      sampleCount,
      outputDir,
      onProgress: (event) => {
        const now = Date.now();
        const existing = stageTimings.get(event.stage);
        if (existing) {
          existing.endMs = now;
          existing.processed = Math.max(existing.processed, event.processed);
          existing.total = Math.max(existing.total, event.total);
          existing.eventCount += 1;
          if (event.throughput !== undefined) {
            existing.maxEventThroughput = Math.max(existing.maxEventThroughput, event.throughput);
          }
        } else {
          stageTimings.set(event.stage, {
            stage: event.stage,
            startMs: now,
            endMs: now,
            processed: event.processed,
            total: event.total,
            maxEventThroughput: event.throughput ?? 0,
            eventCount: 1,
          });
        }
      },
    });
    const runDurationMs = Date.now() - runStart;
    runStep.end(result.success ? "ok" : "fail");

    if (!result.success) {
      note("Benchmark failed with errors:");
      result.errors.forEach((err) => info(`[${err.phase}] ${err.message}`));
      process.exit(1);
    }

    const stageMetrics: StageMetric[] = Array.from(stageTimings.values())
      .sort((a, b) => a.startMs - b.startMs)
      .map((timing) => {
        const latencyMs = Math.max(0, timing.endMs - timing.startMs);
        const throughput =
          latencyMs > 0 ? timing.processed / Math.max(0.001, latencyMs / 1000) : 0;
        return {
          stage: timing.stage,
          processed: timing.processed,
          total: timing.total,
          latencyMs,
          throughputPagesPerSecond: throughput,
          maxEventThroughput: timing.maxEventThroughput,
          startedAt: new Date(timing.startMs).toISOString(),
          finishedAt: new Date(timing.endMs).toISOString(),
        };
      });

    const violations = stageMetrics.filter(
      (metric) =>
        !IGNORED_STAGES.has(metric.stage) &&
        metric.processed > 0 &&
        metric.latencyMs > maxStageLatencyMs
    );

    const summary = {
      runId: result.runId,
      corpusRoot: projectRoot,
      sampleCount,
      totalDurationMs: result.durationMs,
      pagesProcessed: result.pageCount,
      overallThroughputPagesPerSecond: (result.pageCount / result.durationMs) * 1000,
      stageMetrics,
      thresholds: {
        maxStageLatencyMs,
      },
      violations: violations.map((metric) => ({
        stage: metric.stage,
        latencyMs: metric.latencyMs,
        thresholdMs: maxStageLatencyMs,
      })),
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, "benchmark.json");
    await fs.writeFile(outputPath, JSON.stringify(summary, null, 2));

    section("BENCHMARK SUMMARY");
    info(`Run ID: ${summary.runId}`);
    info(`Pages Processed: ${summary.pagesProcessed}`);
    info(`Total Duration: ${(summary.totalDurationMs / 1000).toFixed(2)}s`);
    info(
      `Overall Throughput: ${summary.overallThroughputPagesPerSecond.toFixed(2)} pages/sec`
    );
    note("Stage Metrics:");
    stageMetrics.forEach((metric) => {
      info(
        `- ${metric.stage}: ${metric.latencyMs}ms, ${metric.throughputPagesPerSecond.toFixed(
          2
        )} pages/sec`
      );
    });
    info(`Results: ${outputPath}`);

    if (violations.length > 0) {
      note("Latency threshold violations:");
      violations.forEach((metric) => {
        info(`- ${metric.stage}: ${metric.latencyMs}ms (max ${maxStageLatencyMs}ms)`);
      });
      process.exit(1);
    }
  } catch (error) {
    console.error("Benchmark execution failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
