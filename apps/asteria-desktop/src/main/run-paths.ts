import path from "node:path";

type PreviewKind = "source" | "normalized";

export const getRunDir = (outputDir: string, runId: string): string =>
  path.join(outputDir, "runs", runId);

export const getRunSidecarPath = (runDir: string, pageId: string): string =>
  path.join(runDir, "sidecars", `${pageId}.json`);

export const getRunNormalizedPath = (runDir: string, pageId: string): string =>
  path.join(runDir, "normalized", `${pageId}.png`);

export const getRunPreviewPath = (runDir: string, pageId: string, kind: PreviewKind): string =>
  path.join(runDir, "previews", `${pageId}-${kind}.png`);

export const getRunOverlayPath = (runDir: string, pageId: string): string =>
  path.join(runDir, "overlays", `${pageId}-overlay.png`);

export const getRunManifestPath = (runDir: string): string => path.join(runDir, "manifest.json");

export const getRunReviewQueuePath = (runDir: string): string =>
  path.join(runDir, "review-queue.json");
