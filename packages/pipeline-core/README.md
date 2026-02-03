# Pipeline Core

Rust-based CV/ML pipeline for Asteria Studio, exposed to Node via N-API.

## Responsibilities

- Deskew, dewarp, layout detection, ornament detection, margin estimation.
- Apply normalization given target dimensions/DPI and bleed/trim rules.
- Emit JSON sidecars conforming to `spec/page_layout_schema.json`.

## Current N-API Exports

- `estimateSkewAngle(data: Buffer, width: number, height: number): { angle: number; confidence: number }`
- `baselineMetrics(data: Buffer, width: number, height: number): { lineConsistency: number; textLineCount: number }`
- `columnMetrics(data: Buffer, width: number, height: number): { columnCount: number; columnSeparation: number }`
- `detectLayoutElements(data: Buffer, width: number, height: number): Array<{ id: string; type: string; bbox: number[]; confidence: number }>`
- `projectionProfileX(data: Buffer, width: number, height: number): number[]`
- `projectionProfileY(data: Buffer, width: number, height: number): number[]`
- `sobelMagnitude(data: Buffer, width: number, height: number): number[]`
- `dhash9x8(data: Buffer): string`

## Next Actions

- Scaffold crate with OpenCV + ONNX Runtime + Tesseract dependencies.
- Extend N-API surface (`process_page`, `run_pipeline`) and data types.
- Set up golden image tests and benchmarks.
