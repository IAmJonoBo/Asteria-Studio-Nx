export type Box = [number, number, number, number];
export type SnapAxis = "x" | "y";
export type SnapEdge = "left" | "right" | "top" | "bottom";

export type SnapCandidate = {
  axis: SnapAxis;
  value: number;
  confidence: number;
  label?: string;
  sourceId: string;
};

export type SnapSourceConfig = {
  id: string;
  priority: number;
  minConfidence: number;
  weight: number;
  radius: number;
  enabled?: boolean;
  label?: string;
  candidates: SnapCandidate[];
};

export type SnapGuide = {
  axis: SnapAxis;
  value: number;
  edge: SnapEdge;
  label?: string;
  sourceId: string;
};

export type SnapResult = {
  box: Box;
  guides: SnapGuide[];
  applied: boolean;
};

const edgeToIndex: Record<SnapEdge, number> = {
  left: 0,
  top: 1,
  right: 2,
  bottom: 3,
};

const edgeToAxis: Record<SnapEdge, SnapAxis> = {
  left: "x",
  right: "x",
  top: "y",
  bottom: "y",
};

export const getBoxSnapCandidates = (
  box: Box,
  confidence: number,
  label: string | undefined,
  sourceId: string
): SnapCandidate[] => {
  return [
    { axis: "x", value: box[0], confidence, label, sourceId },
    { axis: "x", value: box[2], confidence, label, sourceId },
    { axis: "y", value: box[1], confidence, label, sourceId },
    { axis: "y", value: box[3], confidence, label, sourceId },
  ];
};

export const snapBoxWithSources = (params: {
  box: Box;
  edges: SnapEdge[];
  sources: SnapSourceConfig[];
}): SnapResult => {
  const { box, edges, sources } = params;
  const updated: Box = [...box];
  const guides: SnapGuide[] = [];
  const enabledSources = sources.filter((source) => source.enabled !== false);

  edges.forEach((edge) => {
    const axis = edgeToAxis[edge];
    const edgeValue = updated[edgeToIndex[edge]];
    let best:
      | {
          value: number;
          label?: string;
          sourceId: string;
          priority: number;
          score: number;
        }
      | undefined;

    enabledSources.forEach((source) => {
      const sourceLabel = source.label ?? source.id;
      source.candidates.forEach((candidate) => {
        if (candidate.axis !== axis) return;
        if (candidate.confidence < source.minConfidence) return;
        const distance = Math.abs(edgeValue - candidate.value);
        if (distance > source.radius) return;
        const normalizedDistance = source.radius > 0 ? distance / source.radius : distance;
        const score = source.weight * candidate.confidence - normalizedDistance;
        if (
          !best ||
          source.priority > best.priority ||
          (source.priority === best.priority && score > best.score)
        ) {
          best = {
            value: candidate.value,
            label: candidate.label ?? sourceLabel,
            sourceId: source.id,
            priority: source.priority,
            score,
          };
        }
      });
    });

    if (best) {
      updated[edgeToIndex[edge]] = best.value;
      guides.push({
        axis,
        value: best.value,
        edge,
        label: best.label,
        sourceId: best.sourceId,
      });
    }
  });

  return { box: updated, guides, applied: guides.length > 0 };
};
