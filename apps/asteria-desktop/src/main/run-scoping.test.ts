import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SCOPED_PATTERN =
  /getNormalizedDir\(outputDir|getPreviewDir\(outputDir|path\.join\(outputDir, "normalized"|path\.join\(outputDir, "previews"|outputDir\s*\+\s*"\/normalized"|outputDir\s*\+\s*"\/previews"/;

const runScopedSearch = (): string => {
  const root = path.resolve(process.cwd(), "src", "main");
  const matches: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const contents = fs.readFileSync(fullPath, "utf-8");
      if (SCOPED_PATTERN.test(contents)) {
        matches.push(fullPath);
      }
    }
  };
  walk(root);
  return matches.join("\n");
};

describe("run scoping", () => {
  it("does not use outputDir/normalized or outputDir/previews for writes", () => {
    expect(runScopedSearch()).toBe("");
  });
});
