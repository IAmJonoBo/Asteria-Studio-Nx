# Asteria Studio — Architecture

## Overview

Electron desktop app with React front end, Rust CV/ML core exposed to Node via N-API, and a local job orchestrator. Offline-first, single-machine projects with optional remote accelerators for heavy inference. All outputs are versioned in a local project workspace.

## Major Components

- **UI Shell (Electron + React/Vite)**: project selector, batch controls, review queue, side-by-side before/after, overlays, manual dimension dialog, bulk apply, undo/version timeline.
- **Job Orchestrator (Node)**: schedules pipeline stages, manages run manifests, tracks progress, retries, and resource limits (GPU/CPU). Exposes IPC to UI.
- **CV/ML Core (Rust)**: deskew, dewarp, layout detection, ornament detection, margin estimation, scaling/cropping. Uses OpenCV + ONNX Runtime; builds as a native module consumed via N-API.
- **Model Runner Abstraction**: local ONNX/Tesseract backends by default; optional remote inference endpoint (Triton/HTTP) selectable per model with auto-fallback to local.
- **Project Store**: filesystem-backed; caches inputs, intermediates, and outputs; keeps manifests, JSON sidecars, thumbnails, and metrics. No database required initially.
- **Exporter**: generates normalized PNG/TIFF/PDF plus JSON layout sidecars and run summaries.

## Data Flow (per batch)

1. Ingest: register source PDF/images, derive page ordering, compute checksums.
2. Preprocess: denoise, contrast-normalize, binarize hint layers; estimate orientation.
3. Deskew: Hough/phase-correlation to detect angle; rotate to upright.
4. Dewarp: page contour detection + UNet-based surface estimation; warp correction.
5. Spread Split: detect two-page scans; split at gutter when confidence is high.
6. Layout Detection: detect page bounds, text blocks, titles, ornaments, folios; compute confidence scores.
7. Normalize: apply target dimensions/DPI; scale/crop with bleed/trim rules; align elements to consistent grids.
8. Shading Correct: estimate low-frequency illumination field and correct spine shadow.
9. Book Priors: derive median trim/content boxes, running heads, and baseline grid; re-apply.
10. QA: produce overlays, thumbnails, and metrics for reviewer queue.
11. Export: write normalized images and JSON sidecars; record manifest.

## Projects & Storage

- Root: `projects/{projectId}/`
  - `input/` original assets (read-only copies), `work/` intermediates, `output/` finals.
  - `manifests/{runId}.json` (pipeline config + checksums + metrics + decisions).
  - `overlays/` rendered vectors/PNGs; `thumbs/` low-res previews.
- Local filesystem only per requirement; future: optional remote cache.

## Pipelines & Stages

- **Configurable Stages**: toggle/threshold per stage; stop-on-low-confidence rules, including spread split, shading correction, and book priors.
- **Parallelism**: per-page parallel tasks; per-batch ordering when needed.
- **Determinism**: seeds + versioned models; manifest captures hashes of binaries and models.

## Tech Stack Choices

- UI: Electron + React + Vite + Tailwind (for speed) + Zustand/Redux for state. Native menus and shortcuts.
- Native: Rust 1.75+, OpenCV, ONNX Runtime, Tesseract; N-API bindings via `napi-rs`.
- Packaging: Electron Builder for Mac/Win/Linux; auto-update channel optional.
- Testing: Playwright for UI smoke; Rust unit/integration tests for CV core; golden image tests for pipeline outputs.

## Interop Contracts

- **Node ⇔ Rust**: N-API module exposes `process_page`, `detect_layout`, `run_pipeline(batchConfig)` returning typed results and confidences.
- **UI ⇔ Orchestrator**: IPC channels (`startRun`, `cancelRun`, `fetchPage`, `applyOverride`, `exportRun`).
- **Artifacts**: JSON schema in `spec/page_layout_schema.json`; pipeline config `spec/pipeline_config.yaml` (defaults) per project.

## Observability & Safety

- Logging: structured logs per stage; keep per-run log file.
- Metrics: per-page timing, angle corrections, warp error, detection confidences.
- Guardrails: fail on suspicious crops, extreme warps, or low-confidence bounds; route to QA queue.

## Current Pipeline Evaluation (Mind, Myth and Magick)

- Run scope: 783 pages (full corpus), target 300 DPI, 210x297 mm; uniform 1275x1650 px after scan/analyze.
- Performance: ~3495 pages/sec (simulated pipeline), avg 0.29 ms/page; throughput sufficient for desktop batches.
- Gaps observed: bleed/trim fell back to defaults (JPEG SOF marker parsing needs hardening); no Rust CV stages yet; sidecar emission not wired.
- Immediate actions:
  - Harden JPEG dimension probing (SOF parsing + larger window), add checksum-aware failures.
  - Wire Rust pipeline-core for deskew/dewarp/detect; run golden image tests when available.
  - Emit JSON sidecars matching spec/page_layout_schema.json alongside normalized outputs.
  - Add per-page parallelism/batching in orchestrator for large corpora.
  - Keep pipeline-results/ artifacts gitignored to avoid noise in CI.

## Roadmap Hooks

- Remote accelerator toggle per model.
- Future collaboration layer: shared manifests and comments.
- Plugin interface for custom detectors (e.g., drop caps, marginalia styles).
