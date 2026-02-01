import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { deriveFolioModel, deriveOrnamentLibrary, deriveRunningHeadTemplates } from "./book-priors";

type TestImageSpec = {
  width: number;
  height: number;
  topBand?: boolean;
  bottomBand?: boolean;
  ornament?: boolean;
};

const createTestImage = async (dir: string, name: string, spec: TestImageSpec): Promise<string> => {
  const { width, height } = spec;
  const buffer = Buffer.alloc(width * height * 3, 255);

  if (spec.topBand) {
    const bandHeight = Math.round(height * 0.12);
    for (let y = 0; y < bandHeight; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        buffer[idx] = 40;
        buffer[idx + 1] = 40;
        buffer[idx + 2] = 40;
      }
    }
  }

  if (spec.bottomBand) {
    const bandHeight = Math.round(height * 0.1);
    for (let y = height - bandHeight; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        buffer[idx] = 40;
        buffer[idx + 1] = 40;
        buffer[idx + 2] = 40;
      }
    }
  }

  if (spec.ornament) {
    const startY = Math.round(height * 0.16);
    const endY = Math.round(height * 0.22);
    const startX = Math.round(width * 0.4);
    const endX = Math.round(width * 0.6);
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 3;
        const toggle = (x + y) % 2 === 0 ? 30 : 220;
        buffer[idx] = toggle;
        buffer[idx + 1] = toggle;
        buffer[idx + 2] = toggle;
      }
    }
  }

  const filePath = path.join(dir, name);
  await sharp(buffer, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
  return filePath;
};

describe("book priors", () => {
  it("derives running head templates from repeated top bands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-priors-head-"));
    const images = await Promise.all(
      Array.from({ length: 4 }).map((_, i) =>
        createTestImage(dir, `page-${i}.png`, { width: 200, height: 300, topBand: true })
      )
    );

    const templates = await deriveRunningHeadTemplates(images, { width: 200, height: 300 }, 2);
    expect(templates.length).toBeGreaterThan(0);
  });

  it("derives folio model from repeated bottom bands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-priors-folio-"));
    const images = await Promise.all(
      Array.from({ length: 4 }).map((_, i) =>
        createTestImage(dir, `page-${i}.png`, { width: 200, height: 300, bottomBand: true })
      )
    );

    const folio = await deriveFolioModel(images, { width: 200, height: 300 }, 2);
    expect(folio).toBeDefined();
    expect(folio?.positionBands?.length).toBeGreaterThan(0);
  });

  it("derives ornament library from high-variance bands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-priors-ornament-"));
    const images = await Promise.all(
      Array.from({ length: 3 }).map((_, i) =>
        createTestImage(dir, `page-${i}.png`, { width: 200, height: 300, ornament: true })
      )
    );

    const ornaments = await deriveOrnamentLibrary(images, { width: 200, height: 300 }, 2);
    expect(ornaments.length).toBeGreaterThan(0);
  });
});
