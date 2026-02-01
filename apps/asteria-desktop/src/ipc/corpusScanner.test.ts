import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanCorpus } from "./corpusScanner";

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
});
