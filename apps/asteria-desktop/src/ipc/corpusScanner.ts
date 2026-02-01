import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { PipelineRunConfig, ScanCorpusOptions } from "./contracts.ts";

const DEFAULT_TARGET_DPI = 400;
const DEFAULT_DIMENSIONS_MM = { width: 210, height: 297 };
const SUPPORTED_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hashFile = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
};

const listFilesRecursive = async (root: string): Promise<string[]> => {
  const results: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(full);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
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
  if (!stats.isDirectory()) {
    throw new Error("Corpus root must be a directory");
  }

  const files = await listFilesRecursive(resolvedRoot);
  const imageFiles = files.filter((file) => SUPPORTED_EXT.has(path.extname(file).toLowerCase()));

  if (imageFiles.length === 0) {
    throw new Error("No supported page images found in corpus");
  }

  const sortedFiles = imageFiles.slice().sort((a: string, b: string) => a.localeCompare(b));
  const pages = await Promise.all(
    sortedFiles.map(async (file: string, index: number) => {
      const confidenceScores: Record<string, number> = {};
      const checksum = options?.includeChecksums ? await hashFile(file) : undefined;
      const id = path.basename(file, path.extname(file)) || `page-${index + 1}`;
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
