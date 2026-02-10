import type { RunProgressEvent } from "../../ipc/contracts.js";

export const RUN_STAGE_SEQUENCE = [
  "starting",
  "scan",
  "analysis",
  "preprocess",
  "deskew",
  "dewarp",
  "shading",
  "layout-detection",
  "normalize",
  "second-pass",
  "review",
  "complete",
] as const;

const CONTROL_STAGES = new Set(["running", "paused", "cancelling"]);
const TERMINAL_STAGES = new Set(["complete", "cancelled", "error"]);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const safeRatio = (processed: number, total: number): number =>
  total > 0 ? clamp01(processed / total) : 0;

export const isControlStage = (stage: string): boolean => CONTROL_STAGES.has(stage);

export const isTerminalStage = (stage: string): boolean => TERMINAL_STAGES.has(stage);

export const getStageSortIndex = (stage: string): number => {
  const index = RUN_STAGE_SEQUENCE.indexOf(stage as (typeof RUN_STAGE_SEQUENCE)[number]);
  return index === -1 ? RUN_STAGE_SEQUENCE.length : index;
};

export const formatStageLabel = (stage: string): string =>
  stage
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => {
      const upper = part.toUpperCase();
      if (["AI", "OCR", "QA", "CV"].includes(upper)) return upper;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");

export const getStageProgressPercent = (
  event: RunProgressEvent,
  isActiveStage = false
): number => {
  if (event.stage === "complete") return 100;
  if (event.stage === "review") {
    // Review includes queue synthesis, overlay generation, and post-processing.
    // Keep this below 100 until complete so users do not perceive a hang.
    return isActiveStage ? 35 : 100;
  }
  if (isControlStage(event.stage)) return 0;
  return Math.round(safeRatio(event.processed, event.total) * 100);
};

export const getOverallProgressPercent = (event: RunProgressEvent): number => {
  if (event.stage === "complete") return 100;
  if (event.stage === "cancelled" || event.stage === "error") return 100;

  const stageIndex = getStageSortIndex(event.stage);
  if (stageIndex >= RUN_STAGE_SEQUENCE.length) {
    return Math.round(safeRatio(event.processed, event.total) * 100);
  }

  let inStageRatio = safeRatio(event.processed, event.total);
  if (event.stage === "starting") {
    inStageRatio = 0.1;
  } else if (event.stage === "review") {
    inStageRatio = 0.2;
  } else if (isControlStage(event.stage)) {
    inStageRatio = 0;
  }

  const denominator = Math.max(1, RUN_STAGE_SEQUENCE.length - 1);
  const progress = ((stageIndex + inStageRatio) / denominator) * 100;
  return Math.min(99, Math.max(0, Math.round(progress)));
};

