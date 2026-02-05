# Asteria Studio — CLI Observability

This document describes the shared observability contract used by Asteria’s CLI and tooling scripts.

## Goals

- Deterministic, low-noise progress in the terminal.
- Durable event output to JSONL (never suppressed by terminal UI).
- Actionable diagnostics via VS Code Problems (ASTERIA_ERROR lines).

## JSONL event schema (v1)

Each line is a single JSON object:

- eventVersion: "1"
- ts: ISO8601 UTC
- runId: string
- tool: "preflight" | "pipeline" | "golden_corpus" | ...
- phase: string
- kind: "start" | "progress" | "end" | "warning" | "error" | "metric"
- counters: { current, total } (optional)
- ms: duration in milliseconds (optional)
- attrs: object (optional)

## Event output locations

- CLI tools: artifacts/observability/<tool>/<runId>.jsonl
- (Future) App runs: runDir/diagnostics/events.jsonl

Override:

- ASTERIA_OBS_DIR=/custom/path (writes to <path>/<tool>/<runId>.jsonl)

## Canonical error format

All actionable errors **must** emit a single line that matches:

ASTERIA_ERROR <file>:<line>:<col> <code> <message>

Example:

ASTERIA_ERROR apps/asteria-desktop/src/main/pipeline-runner.ts:2754:0 PIPELINE_FAILED Corpus scan failed

## VS Code Tasks integration

The task problem matcher parses ASTERIA_ERROR lines so diagnostics appear in the Problems panel. See:

- .vscode/tasks.json

## Current tool coverage

- Node: tools/preflight/run-preflight.mjs
- Node: tools/preflight/run-pipeline.mjs
- Node: apps/asteria-desktop/scripts/run-pipeline.ts
- Node: apps/asteria-desktop/scripts/run-golden-generator.ts
- Node: apps/asteria-desktop/scripts/bless-golden.ts
- Python: tools/golden_corpus/generate.py

## Notes

- Terminal UI is throttled (<=10Hz).
- JSONL output is append-only and ordered.
- When a failure lacks a precise source file, the ASTERIA_ERROR line points to the best available artifact (e.g., stderr log or report.json).
