// @vitest-environment node
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import pixelmatch from "pixelmatch";
import { z } from "zod";
import { ssim } from "ssim.js";
import { runPipeline } from "../../src/main/pipeline-runner.ts";
import {
  getRunDir,
  getRunNormalizedPath,
  getRunReviewQueuePath,
  getRunSidecarPath,
} from "../../src/main/run-paths.ts";

type TruthPage = {
  pageId: string;
  pageBoundsPx: [number, number, number, number];
  contentBoxPx: [number, number, number, number];
  gutter: { side: string; widthPx: number };
  baselineGrid: { medianSpacingPx?: number | null };
  ornaments: Array<{ box: [number, number, number, number]; hash: string }>;
  shouldSplit: boolean;
  expectedReviewReasons: string[];
};

type Manifest = {
  version: string;
  seed: number;
  dpi: number;
  imageSizePx: { width: number; height: number };
  pages: Array<{
    id: string;
    description: string;
    tags: string[];
    truthFile: string;
    ssimThreshold: number;
    ornamentHash?: string;
  }>;
};

const sidecarSchema = z
  .object({
    pageId: z.string(),
    source: z.object({ checksum: z.string() }),
    dpi: z.number(),
    normalization: z
      .object({
        cropBox: z.array(z.number()).length(4),
        pageMask: z.array(z.number()).length(4),
        shadow: z
          .object({
            side: z.string().optional(),
            widthPx: z.number().optional(),
          })
          .optional(),
      })
      .passthrough(),
    metrics: z
      .object({
        backgroundStd: z.number(),
        maskCoverage: z.number(),
        shadowScore: z.number(),
        baseline: z
          .object({
            medianSpacingPx: z.number().optional(),
          })
          .optional(),
      })
      .passthrough(),
    elements: z.array(z.any()),
  })
  .passthrough();

const repoRoot = path.resolve(process.cwd(), "..", "..");
const fixturesRoot = path.join(repoRoot, "tests", "fixtures", "golden_corpus", "v1");
const inputsDir = path.join(fixturesRoot, "inputs");
const truthDir = path.join(fixturesRoot, "truth");
const expectedDir = path.join(fixturesRoot, "expected");
const artifactsRoot = path.join(repoRoot, ".golden-artifacts");

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};


const toImageData = async (filePath: string) => {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const computeSsim = async (expectedPath: string, actualPath: string) => {
  const expected = await toImageData(expectedPath);
  const actual = await toImageData(actualPath);
  const result = ssim(expected, actual);
  return { score: result.mssim, expected, actual };
};

const writeDiffImage = async (
  expected: { data: Uint8Array; width: number; height: number },
  actual: { data: Uint8Array; width: number; height: number },
  diffPath: string
) => {
  const diff = Buffer.alloc(expected.width * expected.height * 4);
  pixelmatch(
    expected.data,
    actual.data,
    diff,
    expected.width,
    expected.height,
    { threshold: 0.1 }
  );
  await sharp(diff, { raw: { width: expected.width, height: expected.height, channels: 4 } })
    .png()
    .toFile(diffPath);
};

const computePHash = (data: Uint8Array, width: number, height: number): string => {
  const size = 32;
  const small = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const srcY = Math.floor((y / size) * height);
    for (let x = 0; x < size; x++) {
      const srcX = Math.floor((x / size) * width);
      const idx = (srcY * width + srcX) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      small[y * size + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  const dct = new Float64Array(size * size);
  const c = (n: number) => (n === 0 ? 1 / Math.sqrt(2) : 1);
  for (let u = 0; u < size; u++) {
    for (let v = 0; v < size; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          sum +=
            small[y * size + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      dct[v * size + u] = 0.25 * c(u) * c(v) * sum;
    }
  }
  const vals: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      vals.push(dct[y * size + x]);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = "";
  for (const v of vals) {
    bits += v > median ? "1" : "0";
  }
  let hash = "";
  for (let i = 0; i < bits.length; i += 4) {
    hash += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hash;
};

const matchesExpectedReasons = (expected: string[], actual: string[]): { ok: boolean; missing: string[] } => {
  const missing: string[] = [];
  for (const reason of expected) {
    if (reason.includes("*")) {
      const prefix = reason.replace("*", "");
      if (!actual.some((item) => item.startsWith(prefix))) {
        missing.push(reason);
      }
    } else if (!actual.includes(reason)) {
      missing.push(reason);
    }
  }
  return { ok: missing.length === 0, missing };
};

const expectClose = (value: number, expected: number, tolerance: number) => {
  const diff = Math.abs(value - expected);
  expect(diff).toBeLessThanOrEqual(tolerance);
};

describe.sequential("golden corpus regression", () => {
  it("matches golden outputs", async () => {
    const manifestPath = path.join(fixturesRoot, "manifest.json");
    const manifest = await readJson<Manifest>(manifestPath);

    if (!(await fileExists(expectedDir))) {
      throw new Error("Expected outputs missing. Run `pnpm golden:bless`.");
    }

    const runId = "golden-v1";
    const runRoot = path.join(process.cwd(), ".cache", "golden", `${Date.now()}`);
    await fs.mkdir(runRoot, { recursive: true });

    delete process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT;
    delete process.env.ASTERIA_REMOTE_LAYOUT_TOKEN;
    delete process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS;

    const result = await runPipeline({
      projectRoot: inputsDir,
      projectId: "golden-v1",
      runId,
      targetDpi: 300,
      targetDimensionsMm: { width: 184.15, height: 260.35 },
      outputDir: runRoot,
      enableSpreadSplit: true,
      enableBookPriors: false,
      bookPriorsSampleCount: 0,
      pipelineConfigPath: path.join(repoRoot, "spec", "pipeline_config.yaml"),
    });

    expect(result.success).toBe(true);

    const runDir = getRunDir(runRoot, runId);
    const reviewQueuePath = getRunReviewQueuePath(runDir);
    const reviewQueue = await readJson<{ items: Array<{ pageId: string; qualityGate: { reasons: string[] } }> }>(
      reviewQueuePath
    );
    const reasonsByPage = new Map(
      reviewQueue.items.map((item) => [item.pageId, item.qualityGate.reasons])
    );

    const artifactDir = path.join(artifactsRoot, runId);
    await fs.mkdir(artifactDir, { recursive: true });
    const ssimReport: Record<string, number> = {};

    let failure: Error | null = null;

    outer: for (const entry of manifest.pages) {
      const truthPath = path.join(truthDir, entry.truthFile);
      const truth = await readJson<TruthPage>(truthPath);

      const expectSplit =
        truth.shouldSplit && !truth.expectedReviewReasons.includes("spread-split-low-confidence");
      const resolvedPageIds = expectSplit
        ? [`${entry.id}_L`, `${entry.id}_R`]
        : [entry.id];

      for (const pageId of resolvedPageIds) {
        const expectedImage = path.join(expectedDir, "normalized", `${pageId}.png`);
        const expectedSidecar = path.join(expectedDir, "sidecars", `${pageId}.json`);
        if (!(await fileExists(expectedImage)) || !(await fileExists(expectedSidecar))) {
          failure = new Error(`Missing expected outputs for ${pageId}. Run \"pnpm golden:bless\".`);
          break outer;
        }

        const actualImage = getRunNormalizedPath(runDir, pageId);
        const actualSidecar = getRunSidecarPath(runDir, pageId);

        const { score, expected, actual } = await computeSsim(expectedImage, actualImage);
        ssimReport[pageId] = score;
        if (score < entry.ssimThreshold) {
          const diffPath = path.join(artifactDir, `${pageId}-diff.png`);
          await writeDiffImage(expected, actual, diffPath);
          failure = new Error(`SSIM ${score.toFixed(4)} below threshold for ${pageId}`);
          break outer;
        }

        const expectedSidecarJson = sidecarSchema.parse(await readJson(expectedSidecar));
        const actualSidecarJson = sidecarSchema.parse(await readJson(actualSidecar));

        expect(actualSidecarJson.pageId).toBe(pageId);
        expect(actualSidecarJson.source.checksum).toBe(expectedSidecarJson.source.checksum);
        expectClose(actualSidecarJson.metrics.backgroundStd, expectedSidecarJson.metrics.backgroundStd, 0.5);
        expectClose(actualSidecarJson.metrics.maskCoverage, expectedSidecarJson.metrics.maskCoverage, 0.02);
        expectClose(actualSidecarJson.metrics.shadowScore, expectedSidecarJson.metrics.shadowScore, 0.5);

        for (let i = 0; i < 4; i++) {
          expectClose(
            actualSidecarJson.normalization.cropBox[i],
            expectedSidecarJson.normalization.cropBox[i],
            1
          );
          expectClose(
            actualSidecarJson.normalization.pageMask[i],
            expectedSidecarJson.normalization.pageMask[i],
            1
          );
        }

        if (truth.baselineGrid?.medianSpacingPx) {
          const actualSpacing = actualSidecarJson.metrics.baseline?.medianSpacingPx ?? 0;
          expectClose(actualSpacing, truth.baselineGrid.medianSpacingPx, 1.5);
        }

        if (truth.gutter?.side && truth.gutter.side !== "none" && !expectSplit) {
          const actualShadow = actualSidecarJson.normalization.shadow;
          if (actualShadow?.side && actualShadow.side !== "none") {
            expect(actualShadow.side).toBe(truth.gutter.side);
            if (actualShadow.widthPx !== undefined) {
              expectClose(actualShadow.widthPx, truth.gutter.widthPx, 12);
            }
          }
        }

        if (truth.ornaments.length > 0 && process.env.GOLDEN_CHECK_ORNAMENT_HASHES === "1") {
          const ornament = truth.ornaments[0];
          const [x0, y0, x1, y1] = ornament.box;
          const width = x1 - x0 + 1;
          const height = y1 - y0 + 1;
          const crop = await sharp(actualImage)
            .extract({ left: x0, top: y0, width, height })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const hash = computePHash(new Uint8Array(crop.data), crop.info.width, crop.info.height);
          expect(hash).toBe(ornament.hash);
        }
      }

      const actualReasons = reasonsByPage.get(entry.id) ?? [];
      const { ok, missing } = matchesExpectedReasons(truth.expectedReviewReasons, actualReasons);
      if (!ok) {
        failure = new Error(`Missing review reasons for ${entry.id}: ${missing.join(", ")}`);
        break;
      }
    }

    const reportPath = path.join(artifactDir, "ssim-report.json");
    await fs.writeFile(reportPath, JSON.stringify(ssimReport, null, 2));

    if (failure) {
      throw failure;
    }
  }, 180000);
});
