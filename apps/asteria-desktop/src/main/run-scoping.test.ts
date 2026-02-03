import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const runScopedSearch = (): string => {
  try {
    return execSync(
      [
        "rg -n",
        "--glob '!**/*.test.ts'",
        '"getNormalizedDir\\(outputDir|getPreviewDir\\(outputDir|path\\.join\\(outputDir, \\"normalized\\"|path\\.join\\(outputDir, \\"previews\\"|outputDir\\s*\\+\\s*\\"/normalized\\"|outputDir\\s*\\+\\s*\\"/previews\\""',
        "src/main",
      ].join(" "),
      { encoding: "utf-8" }
    ).trim();
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return "";
    throw error;
  }
};

describe("run scoping", () => {
  it("does not use outputDir/normalized or outputDir/previews for writes", () => {
    expect(runScopedSearch()).toBe("");
  });
});
