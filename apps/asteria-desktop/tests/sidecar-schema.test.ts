// @vitest-environment node
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const repoRoot = path.resolve(process.cwd(), "..", "..");
const schemaPath = path.join(repoRoot, "spec", "page_layout_schema.json");
const sidecarDir = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "golden_corpus",
  "v1",
  "expected",
  "sidecars"
);

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const assertRange = (value: number, min: number, max: number, label: string): string | null => {
  if (value < min || value > max) {
    return `${label} out of range: ${value} not in [${min}, ${max}]`;
  }
  return null;
};

describe("sidecar schema validation", () => {
  it("validates all expected sidecars against the schema and required fields", async () => {
    const schema = await readJson<Record<string, unknown>>(schemaPath);
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const files = (await fs.readdir(sidecarDir)).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const file of files) {
      const filePath = path.join(sidecarDir, file);
      const sidecar = await readJson<Record<string, unknown>>(filePath);
      const valid = validate(sidecar);

      if (!valid) {
        const errorText = ajv.errorsText(validate.errors, { separator: "; " });
        failures.push(`${file}: schema validation failed: ${errorText}`);
      }

      const normalization = sidecar.normalization as Record<string, unknown> | undefined;
      const metrics = sidecar.metrics as Record<string, unknown> | undefined;
      const elements = sidecar.elements as Array<Record<string, unknown>> | undefined;

      const rotation = normalization?.skewAngle;
      if (!isFiniteNumber(rotation)) {
        failures.push(`${file}: normalization.skewAngle missing or not a finite number`);
      } else {
        const rotationError = assertRange(rotation, -45, 45, "normalization.skewAngle");
        if (rotationError) failures.push(`${file}: ${rotationError}`);
      }

      const warp = normalization?.warp as Record<string, unknown> | undefined;
      const warpResidual = warp?.residual;
      if (!warp || !isFiniteNumber(warpResidual)) {
        failures.push(`${file}: normalization.warp.residual missing or not a finite number`);
      } else if (warpResidual < 0) {
        failures.push(`${file}: normalization.warp.residual must be >= 0`);
      }

      const warpScore = metrics?.warpScore;
      if (warpScore !== undefined && (!isFiniteNumber(warpScore) || warpScore < 0)) {
        failures.push(`${file}: metrics.warpScore must be a non-negative finite number`);
      }

      if (!Array.isArray(elements) || elements.length === 0) {
        failures.push(`${file}: elements missing or empty`);
      }

      const cropBox = normalization?.cropBox;
      if (Array.isArray(cropBox) && cropBox.length === 4 && cropBox.every(isFiniteNumber)) {
        const [x0, y0, x1, y1] = cropBox;
        if (Array.isArray(elements)) {
          elements.forEach((element, index) => {
            const bbox = element.bbox as number[] | undefined;
            if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(isFiniteNumber)) {
              failures.push(`${file}: elements[${index}].bbox invalid or missing`);
              return;
            }
            const [ex0, ey0, ex1, ey1] = bbox;
            if (ex0 < x0 || ey0 < y0 || ex1 > x1 || ey1 > y1) {
              failures.push(`${file}: elements[${index}].bbox out of cropBox bounds`);
            }
          });
        }
      }

      const overrides = sidecar.overrides;
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        failures.push(`${file}: overrides missing or not an object`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Sidecar schema validation failed:\n${failures.join("\n")}`);
    }
  });
});
