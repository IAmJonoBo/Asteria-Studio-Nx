#!/usr/bin/env ts-node
import fs from "node:fs/promises";
import path from "node:path";
import { getRunDir } from "../src/main/run-paths.ts";
import { loadEnv } from "../src/main/config.ts";
import { createProgressReporter, info, note, section, startStep } from "./cli.ts";

loadEnv();

const SUPPORTED_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff"]);

const listFilesRecursive = async (root: string): Promise<string[]> => {
  const results: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
};

async function main(): Promise<void> {
  const projectRoot = process.argv[2];
  const sampleCount = process.argv[3] ? Number.parseInt(process.argv[3], 10) : undefined;

  if (!projectRoot) {
    console.error("Usage: pnpm pipeline:export <projectRoot> [count]");
    process.exit(1);
  }

  const resolved = path.resolve(projectRoot);
  section("ASTERIA EXPORT (PASS-THROUGH)");
  info(`Source: ${resolved}`);
  info(`Sample Count: ${sampleCount || "all pages"}`);

  const verifyStep = startStep("Verify project root");
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    verifyStep.end("fail");
    throw new Error(`Project root must be a directory: ${resolved}`);
  }
  verifyStep.end("ok");

  const scanStep = startStep("Scan input files");
  const allFiles = await listFilesRecursive(resolved);
  const images = allFiles.filter((f) => SUPPORTED_EXT.has(path.extname(f).toLowerCase())).sort();
  if (images.length === 0) {
    scanStep.end("fail");
    throw new Error("No supported images found");
  }
  scanStep.end("ok", `${images.length} images`);

  const selected = sampleCount && sampleCount > 0 ? images.slice(0, sampleCount) : images;
  const outputDir = path.join(process.cwd(), "pipeline-results");
  const runId = `run-${Date.now()}`;
  const runDir = getRunDir(outputDir, runId);
  const outDir = path.join(runDir, "normalized");
  await fs.mkdir(outDir, { recursive: true });

  note(`Exporting ${selected.length} pages to ${outDir}`);

  const copyStep = startStep("Copy images");
  const copyProgress = createProgressReporter("Copy progress");
  let copied = 0;
  await Promise.all(
    selected.map(async (src) => {
      const dest = path.join(outDir, path.basename(src));
      await fs.copyFile(src, dest);
      copied += 1;
      copyProgress.update({ processed: copied, total: selected.length });
      return dest;
    })
  );
  copyProgress.end("ok");
  copyStep.end("ok");

  const manifest = {
    runId,
    exportedAt: new Date().toISOString(),
    sourceRoot: resolved,
    count: selected.length,
    files: selected.map((src) => path.basename(src)),
    note: "Pass-through export (no CV normalization applied yet)",
  };

  const manifestStep = startStep("Write manifest");
  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  manifestStep.end("ok", path.join(runDir, "manifest.json"));
  section("EXPORT COMPLETE");
  info(`Run ID: ${runId}`);
  info(`Output: ${runDir}`);
}

await main();
