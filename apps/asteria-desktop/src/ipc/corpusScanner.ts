import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import type { PipelineRunConfig, ScanCorpusOptions } from "./contracts.js";

const DEFAULT_TARGET_DPI = 400;
const DEFAULT_DIMENSIONS_MM = { width: 210, height: 297 };
const SUPPORTED_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".pdf"]);
const PDF_CACHE_ROOT = path.join(os.tmpdir(), "asteria-pdf-cache");
const PDF_DENSITY = 300;

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_MAX_DEPTH = 25;
const DEFAULT_MAX_PDF_PAGES = 50;
const CORPUS_SIZE_LIMIT_ERROR = "Corpus scan exceeded size limit";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hashFile = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("error", (error) => {
      stream.destroy();
      reject(error);
    });
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
};

const listFilesRecursive = async (
  root: string,
  options: { maxFiles: number; maxTotalBytes: number; maxDepth: number }
): Promise<{ files: string[]; totalBytes: number }> => {
  const results: string[] = [];
  let totalBytes = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > options.maxDepth) return;
    if (results.length >= options.maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= options.maxFiles) return;
      const full = path.join(dir, entry.name);

      // Avoid following symlinks during corpus enumeration.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      try {
        const stats = await fs.stat(full);
        totalBytes += stats.size;
        if (totalBytes > options.maxTotalBytes) {
          throw new Error(CORPUS_SIZE_LIMIT_ERROR);
        }
        results.push(full);
      } catch (error) {
        if (error instanceof Error && error.message === CORPUS_SIZE_LIMIT_ERROR) {
          throw error;
        }
        // Skip unreadable entries.
      }
    }
  };

  await walk(root, 0);
  return { files: results, totalBytes };
};

const getPdfCacheDir = async (pdfPath: string): Promise<{ cacheDir: string; baseName: string }> => {
  const stats = await fs.stat(pdfPath);
  const hash = crypto
    .createHash("sha256")
    .update(`${pdfPath}:${stats.mtimeMs}:${stats.size}`)
    .digest("hex")
    .slice(0, 12);
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const cacheDir = path.join(PDF_CACHE_ROOT, `${baseName}-${hash}`);
  await fs.mkdir(cacheDir, { recursive: true });
  return { cacheDir, baseName };
};

const renderPdfPages = async (pdfPath: string, maxPages: number): Promise<string[]> => {
  const { cacheDir, baseName } = await getPdfCacheDir(pdfPath);
  const meta = await sharp(pdfPath, { density: PDF_DENSITY }).metadata();
  const pageCount = Math.max(1, meta.pages ?? 1);
  if (pageCount > maxPages) {
    throw new Error(`PDF exceeds page limit (${pageCount} > ${maxPages})`);
  }
  const outputPaths: string[] = [];

  for (let page = 0; page < pageCount; page += 1) {
    const filename = `${baseName}-p${String(page + 1).padStart(4, "0")}.png`;
    const outputPath = path.join(cacheDir, filename);
    try {
      const existing = await fs.stat(outputPath);
      if (existing.isFile()) {
        outputPaths.push(outputPath);
        continue;
      }
    } catch {
      // Render below if the cached file doesn't exist.
    }
    await sharp(pdfPath, { density: PDF_DENSITY, page }).png().toFile(outputPath);
    outputPaths.push(outputPath);
  }

  return outputPaths;
};

const buildPageId = (
  filePath: string,
  rootPath: string,
  index: number,
  usedIds: Set<string>
): string => {
  const relative = path.relative(rootPath, filePath);
  const withoutExt = relative.replace(path.extname(relative), "");
  const normalized = withoutExt.replace(/[\\/]+/g, "-");
  const baseId = normalized || `page-${index + 1}`;
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
};

export const scanCorpus = async (
  rootPath: string,
  options?: ScanCorpusOptions
): Promise<PipelineRunConfig> => {
  if (!isNonEmptyString(rootPath)) {
    throw new Error("Invalid root path for corpus scan");
  }

  const resolvedRoot = path.resolve(rootPath);
  const stats = await fs.stat(resolvedRoot);
  const isDirectory = stats.isDirectory();
  const isFile = stats.isFile();
  if (!isDirectory && !isFile) {
    throw new Error("Corpus root must be a directory or file");
  }

  const maxFiles = Math.max(1, Math.floor(options?.maxFiles ?? DEFAULT_MAX_FILES));
  const maxTotalBytes = Math.max(1, Math.floor(options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES));
  const maxDepth = Math.max(0, Math.floor(options?.maxDepth ?? DEFAULT_MAX_DEPTH));
  const maxPdfPages = Math.max(1, Math.floor(options?.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES));

  const files = isDirectory
    ? (await listFilesRecursive(resolvedRoot, { maxFiles, maxTotalBytes, maxDepth })).files
    : [resolvedRoot];
  const filteredFiles = files.filter((file) => SUPPORTED_EXT.has(path.extname(file).toLowerCase()));
  const imageFiles: string[] = [];
  for (const file of filteredFiles) {
    if (path.extname(file).toLowerCase() === ".pdf") {
      const rendered = await renderPdfPages(file, maxPdfPages);
      imageFiles.push(...rendered);
    } else {
      imageFiles.push(file);
    }
  }

  if (imageFiles.length === 0) {
    throw new Error("No supported page images found in corpus");
  }

  const sortedFiles = imageFiles.slice().sort((a: string, b: string) => a.localeCompare(b));
  const usedIds = new Set<string>();
  const pages = await Promise.all(
    sortedFiles.map(async (file: string, index: number) => {
      const confidenceScores: Record<string, number> = {};
      const checksum = options?.includeChecksums ? await hashFile(file) : undefined;
      const rootForId =
        isDirectory && file.startsWith(resolvedRoot) ? resolvedRoot : path.dirname(file);
      const id = buildPageId(file, rootForId, index, usedIds);
      return {
        id,
        filename: path.basename(file),
        originalPath: file,
        confidenceScores,
        ...(checksum ? { checksum } : {}),
      };
    })
  );

  return {
    projectId: options?.projectId ?? path.basename(resolvedRoot),
    pages,
    targetDpi: options?.targetDpi ?? DEFAULT_TARGET_DPI,
    targetDimensionsMm: options?.targetDimensionsMm ?? DEFAULT_DIMENSIONS_MM,
  };
};
