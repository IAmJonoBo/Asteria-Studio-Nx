import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const createSharpInstance = (input: string) => {
  const api = {
    metadata: vi.fn(async () => ({ pages: 2 })),
    png: vi.fn(() => api),
    toFile: vi.fn(async (outputPath: string) => {
      await fs.writeFile(outputPath, `rendered:${path.basename(input)}`);
    }),
  };
  return api;
};

vi.mock("sharp", () => ({
  default: vi.fn((input: string) => createSharpInstance(input)),
}));

describe("corpusScanner PDF handling", () => {
  it("expands PDF inputs into rendered image pages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-scan-pdf-"));
    await fs.writeFile(path.join(root, "sample.pdf"), Buffer.from("%PDF-1.4"));

    const { scanCorpus } = await import("./corpusScanner.js");
    const config = await scanCorpus(root, { maxPdfPages: 10 });

    expect(config.pages).toHaveLength(2);
    expect(config.pages.every((page) => page.filename.endsWith(".png"))).toBe(true);
  });
});
