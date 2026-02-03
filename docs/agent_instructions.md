# Agent instructions

## Confidence + source rule

- Any user-visible confidence value must include both the numeric confidence and the source of that value.
- The source must name the model, heuristic, or config key (for example, `split.confidence.min`).
- If confidence is derived from multiple inputs, summarize the primary driver(s).

## Golden corpus requirements

- Any changes to shading, split, crop, or book-prior logic must update the golden corpus and pass `pnpm golden:test`.
- QA thresholds must remain config-driven. If a threshold changes, the failure reason should cite the config key that triggered it.
- When updating thresholds, also update the golden manifest thresholds, re-bless expected outputs, and include the threshold change rationale in the commit message.
