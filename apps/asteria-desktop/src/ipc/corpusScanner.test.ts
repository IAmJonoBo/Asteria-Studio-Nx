import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanCorpus } from "./corpusScanner.js";

const writeDummy = async (dir: string, name: string): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, "dummy");
  return filePath;
};

describe("corpusScanner", () => {
  it("builds pipeline config with discovered images", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-"));
    await writeDummy(root, "ignore.txt");
    await writeDummy(root, "page-1.jpg");
    await writeDummy(root, "page-2.png");

    const config = await scanCorpus(root, { projectId: "proj" });

    expect(config.projectId).toBe("proj");
    expect(config.pages).toHaveLength(2);
    expect(config.targetDpi).toBeGreaterThan(0);
    expect(config.targetDimensionsMm.width).toBeGreaterThan(0);
  });

  it("includes checksums when requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-"));
    await writeDummy(root, "page-1.jpg");

    const config = await scanCorpus(root, { includeChecksums: true });

    expect(config.pages[0]).toHaveProperty("checksum");
  });

  it("throws when no images are present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-"));
    await writeDummy(root, "note.md");

    await expect(scanCorpus(root)).rejects.toThrow(/No supported page images/);
  });

  it("throws when root path is invalid", async () => {
    await expect(scanCorpus("")).rejects.toThrow(/Invalid root path/i);
  });

  it("accepts a single file input", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-"));
    const file = await writeDummy(root, "page-1.jpg");

    const config = await scanCorpus(file);

    expect(config.pages).toHaveLength(1);
    expect(config.pages[0]?.originalPath).toBe(file);
  });

  it("generates unique page ids for duplicate filenames", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-"));
    const nested = path.join(root, "chapter-1");
    await fs.mkdir(nested);
    await writeDummy(root, "page-1.jpg");
    await writeDummy(nested, "page-1.jpg");

    const config = await scanCorpus(root);

    const ids = config.pages.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes("chapter-1"))).toBe(true);
  });
});
