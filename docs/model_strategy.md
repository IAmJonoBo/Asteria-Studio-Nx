# Asteria Studio — Model & CV Strategy

## Goals

- High-quality deskew/dewarp and layout detection with confidence scoring.
- Operate offline by default; allow optional remote inference for heavier models with automatic fallback.
- Deterministic, debuggable outputs with measurable quality metrics.

## Deskew

- **Methods**: Hough line aggregation, text-line projection profiles, phase correlation on binarized text masks.
- **Quality**: angle error target ±0.3°. Use consensus of multiple estimators; reject outliers.
- **Outputs**: `skew_angle`, `confidence`, rotated image.

## Dewarp

- **Methods**: page contour detection for simple cases; UNet-based surface normal/height map for curved pages; thin-plate spline warp.
- **Fallbacks**: if confidence < threshold, keep original and mark for QA.
- **Metrics**: straightness error of text baselines; residual warp score.

## Layout & Element Detection

- **Elements**: page bounds, text blocks, titles/headers, running heads, folios, ornaments/decorators, drop caps, footnotes, marginalia.
- **Models**: lightweight detector (e.g., YOLOv8n/PP-PicoDet) fine-tuned on printed page layouts; heuristic post-processing for margins and grids.
- **OCR assist**: Tesseract/ONNX textline detector to refine text region masks; optional language model for semantic hints (title vs body).
- **Confidence**: per-element scores; ensemble when local+remote disagree.

## Spread Split (Two-Page Scans)

- **Methods**: detect central gutter bands via low-frequency intensity dips and symmetry checks.
- **Guardrails**: split only when confidence is high; otherwise route to QA.
- **Outputs**: stable page IDs with `_L`/`_R` suffixes, retained checksums.

## Normalization & Scaling

- Inputs: user-provided dimensions (mm/cm/in) + target DPI.
- Compute scale factor and crop window; enforce bleed/trim rules; align baseline grid where applicable.
- Apply color normalization (white balance, contrast) with conservative defaults.

## Illumination & Shading Correction

- **Methods**: estimate low-frequency background field from border sampling + regression.
- **Spine Shadows**: directional gradient/band models with confidence scoring.
- **Guardrails**: revert when residual noise increases beyond threshold; route to QA.

## Book Priors (Consistency Engine)

- **Pass A**: sample first N pages to estimate median trim/content boxes and baseline spacing.
- **Pass B**: snap crops to medians within drift bounds; flag anomalies.
- **Determinism**: priors stored in manifests and reused for later batches.

## Remote vs Local Execution

- **Local defaults**: shipped ONNX models + Tesseract; runs on CPU/GPU.
- **Remote option**: configurable endpoint (e.g., Triton HTTP) per model; orchestrator selects best path based on user choice/perf; caches results locally.
- **Fallbacks**: if remote unreachable or slow, auto-switch to local and log.

## Evaluation

- Datasets: per-project labeled subsets; synthetic warped pages for robustness.
- Metrics: deskew MAE, warp straightness, IoU per element, F1 on titles/folios, latency per stage.
- Golden tests: frozen inputs with expected crops/angles/layout JSON; CI checks diffs.

## Model Packaging & Updates

- Versioned models with SHA256; stored under `models/{name}/{version}` with manifest.
- Safe rollbacks; per-project pinning.
- Hardware detection to choose optimized runtimes (CPU vs CUDA/Metal).
