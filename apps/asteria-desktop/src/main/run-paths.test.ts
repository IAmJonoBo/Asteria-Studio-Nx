import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  getRunDir,
  getRunManifestPath,
  getRunNormalizedPath,
  getRunOverlayPath,
  getRunPreviewPath,
  getRunReviewQueuePath,
  getRunSidecarPath,
} from "./run-paths.ts";

describe("run-paths", () => {
  it("builds run-scoped artifact paths", () => {
    const outputDir = "/tmp/asteria-output";
    const runId = "run-123";
    const runDir = getRunDir(outputDir, runId);

    expect(runDir).toBe(path.join(outputDir, "runs", runId));
    expect(getRunSidecarPath(runDir, "page-1")).toBe(path.join(runDir, "sidecars", "page-1.json"));
    expect(getRunNormalizedPath(runDir, "page-1")).toBe(
      path.join(runDir, "normalized", "page-1.png")
    );
    expect(getRunPreviewPath(runDir, "page-1", "source")).toBe(
      path.join(runDir, "previews", "page-1-source.png")
    );
    expect(getRunPreviewPath(runDir, "page-1", "normalized")).toBe(
      path.join(runDir, "previews", "page-1-normalized.png")
    );
    expect(getRunOverlayPath(runDir, "page-1")).toBe(
      path.join(runDir, "overlays", "page-1-overlay.png")
    );
    expect(getRunManifestPath(runDir)).toBe(path.join(runDir, "manifest.json"));
    expect(getRunReviewQueuePath(runDir)).toBe(path.join(runDir, "review-queue.json"));
  });
});
