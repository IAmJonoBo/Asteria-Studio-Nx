# Pipeline Core

Rust-based CV/ML pipeline for Asteria Studio, exposed to Node via N-API.

## Responsibilities

- Deskew, dewarp, layout detection, ornament detection, margin estimation.
- Apply normalization given target dimensions/DPI and bleed/trim rules.
- Emit JSON sidecars conforming to `spec/page_layout_schema.json`.

## Current N-API Exports

- `processPageStub(pageId: string): string`
- `projectionProfileX(data: Buffer, width: number, height: number): number[]`
- `projectionProfileY(data: Buffer, width: number, height: number): number[]`
- `sobelMagnitude(data: Buffer, width: number, height: number): number[]`
- `dhash9x8(data: Buffer): string`

## Next Actions

- Scaffold crate with OpenCV + ONNX Runtime + Tesseract dependencies.
- Define N-API surface (`process_page`, `run_pipeline`) and data types.
- Set up golden image tests and benchmarks.
