import path from "node:path";

type PreviewKind = "source" | "normalized";

export const getRunDir = (outputDir: string, runId: string): string =>
  path.join(outputDir, "runs", runId);

export const getNormalizedDir = (runDir: string): string => path.join(runDir, "normalized");

export const getSidecarDir = (runDir: string): string => path.join(runDir, "sidecars");

export const getPreviewDir = (runDir: string): string => path.join(runDir, "previews");

export const getOverlayDir = (runDir: string): string => path.join(runDir, "overlays");

export const getTrainingDir = (runDir: string): string => path.join(runDir, "training");

export const getRunManifestPath = (runDir: string): string => path.join(runDir, "manifest.json");

export const getRunReportPath = (runDir: string): string => path.join(runDir, "report.json");

export const getRunReviewQueuePath = (runDir: string): string =>
  path.join(runDir, "review-queue.json");

export const getRunSidecarPath = (runDir: string, pageId: string): string =>
  path.join(getSidecarDir(runDir), `${pageId}.json`);

export const getRunNormalizedPath = (runDir: string, pageId: string): string =>
  path.join(getNormalizedDir(runDir), `${pageId}.png`);

export const getRunPreviewPath = (runDir: string, pageId: string, kind: PreviewKind): string =>
  path.join(getPreviewDir(runDir), `${pageId}-${kind}.png`);

export const getRunOverlayPath = (runDir: string, pageId: string): string =>
  path.join(getOverlayDir(runDir), `${pageId}-overlay.png`);
