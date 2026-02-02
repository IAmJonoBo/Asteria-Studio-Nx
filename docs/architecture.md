# Asteria Studio — Architecture

## Overview

Electron desktop app with React front end, Rust CV/ML core (in progress) exposed to Node via N-API, and a local job orchestrator. Offline-first, single-machine projects with optional remote accelerators for heavy inference. All outputs are versioned in a local project workspace.

```mermaid
graph TD
    subgraph "Renderer Process (React)"
        A[UI Components]
        B[Navigation]
        C[ReviewQueue]
        D[CommandPalette]
    end

    subgraph "Main Process (Node)"
        E[IPC Handlers]
        F[Pipeline Runner]
        G[Corpus Scanner]
        H[Normalization Engine]
        I[Book Priors]
    end

    subgraph "Native Layer (Rust/N-API)"
        J[CV Core - Planned]
        K[Deskew/Dewarp]
        L[Layout Detection]
    end

    subgraph "Storage"
        M[Projects FS]
        N[Pipeline Results]
        O[Manifests/Sidecars]
    end

    A --> E
    B --> E
    C --> E
    D --> E
    E --> F
    F --> G
    F --> H
    F --> I
    F -.Future.-> J
    J -.-> K
    J -.-> L
    F --> M
    H --> N
    F --> O
```

## Major Components

### Implemented (✅)

- **UI Shell (Electron + React/Vite)**: Navigation, review queue, command palette, keyboard shortcuts, theme support, accessibility features
- **IPC Bridge (Preload)**: Secure contextIsolation with typed contracts; validation layer for all main ↔ renderer communication
- **Pipeline Orchestrator (Node)**: Schedules stages, manages manifests, tracks progress, implements recovery/resume logic
- **Corpus Scanner**: Discovers pages, computes checksums, detects duplicates, validates inputs
- **Normalization Engine**: Scale/crop to target DPI+dimensions, quality metrics, preview/overlay generation
- **Book Priors**: Samples first N pages to derive median trim/content boxes, applies to full corpus
- **Spread Split Detection**: Identifies two-page scans with confidence gating, splits at gutter
- **Project Store**: Filesystem-backed storage for inputs, intermediates, outputs, manifests, and sidecars
- **Sidecar Emission**: JSON sidecars conforming to `spec/page_layout_schema.json` with full element sets
- **Native Utilities**: Projection profiles + dHash integrated via N-API (performance assist)
- **Native Layout Heuristics**: Local layout element detection via N-API

### In Progress (🚧)

- **CV/ML Core (Rust)**: N-API bindings scaffolded; deskew, dewarp, layout detection implementations pending
- **Model Runner Abstraction**: Local ONNX/Tesseract backends planned; remote inference endpoint optional
- **Exporter**: Generates normalized PNGs, previews, overlays, and schema-compliant sidecars
- **Packaging**: Electron Builder configuration added (Mac/Win/Linux targets)
- **Remote Inference**: HTTP layout endpoint scaffolding with optional auth + timeout

## Data Flow (per batch)

```mermaid
sequenceDiagram
    participant UI as Renderer UI
    participant IPC as IPC Bridge
    participant Runner as Pipeline Runner
    participant Scanner as Corpus Scanner
    participant Analyzer as Corpus Analyzer
    participant Priors as Book Priors
    participant Norm as Normalization

    UI->>IPC: runPipeline(config)
    IPC->>Runner: execute(config)
    Runner->>Scanner: scanCorpus(inputPath)
    Scanner-->>Runner: pages[], checksums
    Runner->>Analyzer: analyzeCorpus(pages, config)
    Analyzer-->>Runner: targetDimensions, metrics
    Runner->>Priors: deriveBookModel(samplePages)
    Priors-->>Runner: bookModel (medianTrim, contentBox)
    loop Each Page
        Runner->>Norm: normalizePage(page, config, priors)
        Norm-->>Runner: normalized image + metrics
    end
    Runner-->>IPC: manifest + results
    IPC-->>UI: success + runId
```

### Pipeline Stages (Current Implementation)

1. **Ingest**: Register source images, derive page ordering, compute SHA-256 checksums, detect duplicates
2. **Analysis**: Compute target dimensions from user config (mm/inches + DPI), detect aspect ratios, quality signals
3. **Spread Split** (Optional): Detect two-page scans via center gutter analysis; split when confidence > threshold
4. **Book Priors** (Optional): Sample first N pages to derive median trim/content boxes, running heads, baseline grid
5. **Normalization**:
   - Scale to target DPI
   - Crop with bleed/trim rules
   - Generate quality metrics (sharpness, contrast)
   - Create preview thumbnails (320px wide)
   - Create overlay annotations
6. **Export**: Write normalized PNGs, previews, overlays to `pipeline-results/`; generate manifest JSON

- Emit schema-compliant JSON sidecars in `pipeline-results/sidecars/`

### Planned Stages (Future)

1. **Preprocess**: Denoise, contrast-normalize, binarize hint layers; estimate orientation
2. **Deskew**: Hough/phase-correlation to detect angle; rotate to upright
3. **Dewarp**: Page contour detection + UNet-based surface estimation; warp correction
4. **Layout Detection**: Detect page bounds, text blocks, titles, ornaments, folios; compute confidence scores
5. **Shading Correct**: Estimate low-frequency illumination field and correct spine shadow
6. **QA**: Produce overlays, thumbnails, and metrics for reviewer queue

## Projects & Storage

Current filesystem layout:

```text
projects/{projectId}/
├── input/
│   └── raw/                    # Original source files (read-only copies)
│       └── {BookTitle}/
│           └── Pages/          # Individual page images (JPEG/PNG/TIFF)
├── work/                       # Intermediate processing artifacts (future)
└── output/
    └── normalized/
        ├── manifest.json       # Run metadata, config, checksums, metrics
        └── {BookTitle}/
            └── Pages/          # Normalized output images

pipeline-results/               # Working directory (gitignored)
├── normalized/                 # Processed images at target DPI/dimensions
├── previews/                   # 320px width thumbnails for UI
├── overlays/                   # Annotated visualization (crop boxes, grids)
├── sidecars/                   # JSON layout metadata (schema-compliant)
└── priors-sample/              # Book model from sampled pages
```

### Manifest Structure

Each pipeline run generates a `manifest.json`:

```json
{
  "runId": "run-{timestamp}-{hash}",
  "version": "0.1.0",
  "timestamp": "2026-02-02T10:30:00Z",
  "config": {
    /* pipeline config */
  },
  "configHash": "sha256...",
  "totalPages": 783,
  "sampledPages": 50,
  "bookModel": {
    /* priors */
  },
  "pages": [
    {
      "id": "page-001",
      "filename": "page-001.jpg",
      "checksum": "sha256...",
      "dhash": "3fa82c9bd01e7a11",
      "metrics": {
        /* quality, dimensions */
      }
    }
  ]
}
```

### Storage Principles

- **Local-only**: No cloud dependencies; all data stays on machine
- **Checksums**: SHA-256 for inputs, detect changes and duplicates
- **Versioned runs**: Each execution creates new manifest with unique ID
- **Idempotent**: Same inputs + config = same outputs (future: with Rust determinism)
- **Resumable**: Pipeline tracks progress, can resume from last checkpoint (implemented)

## Pipelines & Stages

- **Configurable Stages**: Toggle/threshold per stage; stop-on-low-confidence rules
- **Parallelism**: Per-page async tasks with Promise.allSettled; sequential ordering when needed
- **Recovery**: Checkpoint tracking with resumable execution on failure
- **Determinism**: Manifests capture config hashes, checksums, and version; reproducible outputs (future: seeded RNG)

## Tech Stack

### Current Implementation

| Layer                | Technology            | Version | Purpose                                      |
| -------------------- | --------------------- | ------- | -------------------------------------------- |
| **Desktop Shell**    | Electron              | 40.1    | Cross-platform window management             |
| **UI Framework**     | React                 | 19.2    | Component-based renderer                     |
| **Build Tool**       | Vite                  | 7.3     | Fast dev server + bundling                   |
| **Language**         | TypeScript            | 5.9     | Type safety across codebase                  |
| **Image Processing** | Sharp                 | 0.34    | Resize, format conversion, metadata          |
| **Testing (Unit)**   | Vitest                | 4.0     | Fast test runner + coverage                  |
| **Testing (E2E)**    | Playwright            | 1.58    | Browser automation                           |
| **Testing (UI)**     | Testing Library       | 16.3    | Accessible component testing                 |
| **State**            | React hooks           | —       | Local component state (useState, useReducer) |
| **Theming**          | CSS Custom Properties | —       | Light/dark themes via localStorage           |

### Native Layer (In Progress)

| Component      | Technology   | Status           |
| -------------- | ------------ | ---------------- |
| **Bindings**   | `napi-rs`    | Scaffolded       |
| **CV Library** | OpenCV       | Planned          |
| **ML Runtime** | ONNX Runtime | Planned          |
| **OCR**        | Tesseract    | Planned          |
| **Language**   | Rust 1.75+   | Cargo.toml ready |

### Packaging (Planned)

- **Electron Builder**: Mac (.dmg), Windows (.exe), Linux (.AppImage)
- **Auto-update**: Optional update channel
- **Code Signing**: Platform-specific certificates

## Interop Contracts

### IPC Communication

**Secure Bridge Pattern** (contextIsolation: true, nodeIntegration: false)

```typescript
// Preload (bridge)
contextBridge.exposeInMainWorld("asteria", {
  ipc: {
    scanCorpus: (path: string) => ipcRenderer.invoke("asteria:scanCorpus", path),
    runPipeline: (config: PipelineRunConfig) => ipcRenderer.invoke("asteria:runPipeline", config),
    // ... other channels
  },
});

// Renderer (React)
const result = await window.asteria.ipc.scanCorpus("/path/to/project");

// Main (handlers)
ipcMain.handle("asteria:scanCorpus", async (event, path: string) => {
  // Validate input
  // Execute scanner
  // Return typed result
});
```

**Channel Conventions**:

- All channels prefixed with `asteria:`
- Input validation on both preload and main sides
- Typed contracts in `src/ipc/contracts.ts`
- Error propagation with structured messages

**Available IPC Channels** (Implemented):

- `asteria:scan-corpus` — Discover pages in project (returns `PipelineRunConfig`)
- `asteria:analyze-corpus` — Compute target dimensions and metrics
- `asteria:start-run` — Execute full normalization pipeline and persist artifacts
- `asteria:fetch-review-queue` — Load review queue JSON for a run
- `asteria:submit-review` — Persist review decisions
- `asteria:apply-override` — Persist per-page overrides
- `asteria:export-run` — Return normalized output directory
- `asteria:cancel-run` — Abort running job (planned)

### Node ⇔ Rust (Planned)

N-API module will expose:

```rust
#[napi]
pub fn process_page(input: Buffer, config: ProcessConfig) -> Result<ProcessResult>

#[napi]
pub fn detect_layout(image: Buffer) -> Result<LayoutElements>

#[napi]
pub fn run_pipeline(batch_config: BatchConfig) -> Result<BatchResult>
```

### Data Artifacts

**JSON Schema**: `spec/page_layout_schema.json` defines sidecar structure
**Pipeline Config**: `spec/pipeline_config.yaml` provides defaults per project
**Manifest Format**: See Projects & Storage section above

**Remote Layout Settings** (config keys):

- `models.endpoints.remote_layout_endpoint`
- `models.endpoints.remote_layout_token_env`
- `models.endpoints.remote_layout_timeout_ms`

## Observability & Safety

### Logging

- Structured console logs per stage (timestamped, categorized)
- Per-run log files (future: written to `pipeline-results/logs/`)
- Error stack traces with context

### Metrics (Current)

- **Per-page**: Processing time, dimensions, aspect ratio, file size, checksum
- **Per-batch**: Total pages, success/failure counts, elapsed time, throughput
- **Quality**: Sharpness score, contrast ratio (basic implementation)

### Metrics (Planned)

- **Geometry**: Angle corrections, warp error, crop confidence
- **Detection**: Element bounding box IoU, confidence scores
- **Performance**: Stage timings, GPU utilization, memory usage

### Guardrails

- **Input validation**: File existence, format support, dimension sanity
- **Confidence gating**: Skip spread split if confidence < threshold
- **Checksum verification**: Detect input changes mid-run
- **Recovery**: Resume from last successful page on failure
- **Resource limits**: Timeout per page (future), memory caps

### Testing

```mermaid
graph LR
    A[Unit Tests] -->|Vitest| B[91 tests]
    C[Integration Tests] -->|Vitest| B
    D[E2E Tests] -->|Playwright| E[Smoke tests]
    F[Accessibility] -->|Testing Library| B
    B --> G[89% Coverage]
```

**Test Coverage** (Current):

- **Lines**: 89.17% (threshold: 80%) ✅
- **Statements**: 88.61% (threshold: 80%) ✅
- **Branches**: 75.00% (threshold: 75%) ✅
- **Functions**: 82.74% (threshold: 80%) ✅

**Test Categories**:

1. **IPC Contracts** — Channel validation, type safety
2. **Corpus Scanner** — File discovery, checksum computation, duplicate detection
3. **Corpus Analyzer** — Dimension calculation, aspect ratio, target resolution
4. **Normalization** — Scale/crop logic, metrics, preview generation
5. **Book Priors** — Median computation, outlier rejection, model derivation
6. **Pipeline Runner** — End-to-end flow, recovery, manifest generation
7. **UI Components** — Navigation, keyboard shortcuts, theme switching, accessibility
8. **Review Queue** — Keyboard triage (A/F/R), overlay toggle, badge updates

**Golden Image Tests** (Planned):

- Frozen inputs with expected outputs (crops, angles, layout JSON)
- CI checks for pixel-level diffs
- Regression detection for CV/ML changes

## Current Pipeline Evaluation (Mind, Myth and Magick)

**Test Corpus**: 783 pages from scanned grimoire
**Target Output**: 210×297 mm @ 300 DPI → 1275×1650 px normalized images

### Performance Metrics (Latest Run)

```text
Total Pages:     783
Sampled:         50 (for book priors)
Processed:       300 (test subset)
Throughput:      ~3495 pages/sec (simulated)
Avg Time:        0.29 ms/page (scan + analyze)
Normalization:   ~15-25 ms/page (scale + preview + overlay)
```

### Quality Observations

✅ **Working**:

- Corpus scanning with SHA-256 checksums
- Duplicate detection
- Target dimension calculation from DPI + physical size
- Uniform scaling to 1275×1650 px output
- Preview generation (320px width thumbnails)
- Manifest generation with config hash
- Pipeline recovery on failure

⚠️ **Needs Improvement**:

- Bleed/trim detection fell back to defaults (JPEG SOF marker parsing fragile)
- Aspect ratio variance not fully leveraged (all pages normalized to same size)
- Sharpness/contrast metrics basic (simple Laplacian + stddev)

🚧 **Not Yet Implemented**:

- Rust CV stages (deskew, dewarp, layout detection)
- JSON sidecars matching `spec/page_layout_schema.json`
- Spread split execution (detection logic ready, not wired to pipeline)
- Overlay rendering with element annotations
- Per-page parallelism (sequential execution currently)

### Immediate Actions

1. **Harden JPEG parsing**: Larger buffer for SOF marker detection, fallback to Sharp metadata
2. **Wire Rust pipeline-core**: N-API bindings for deskew/dewarp when CV implementation ready
3. **Emit JSON sidecars**: Generate layout metadata alongside normalized images
4. **Add parallelism**: Use Promise.allSettled for batch processing (already in place for some stages)
5. **Keep `pipeline-results/` gitignored**: Avoid bloating repo with test artifacts

## Roadmap & Future Features

### Near-Term (Next Sprint)

- ✅ Complete Rust N-API bindings with basic deskew/dewarp
- ✅ JSON sidecar emission matching schema
- ✅ Per-page parallelism in pipeline runner
- ✅ Electron Builder packaging (Mac, Windows, Linux)

### Mid-Term (2-3 Months)

- 🎯 Layout detection with YOLOv8/PP-PicoDet fine-tuned models
- 🎯 OCR integration (Tesseract/ONNX) for text region refinement
- 🎯 Shading correction (spine shadow, illumination field)
- 🎯 Undo/redo stack per page and per run
- 🎯 Version timeline to compare runs
- ✅ Performance optimization: review queue virtualization
- 🎯 Performance optimization: web workers for previews

### Long-Term (6+ Months)

- 🌐 Remote accelerator toggle per model (local/remote/auto)
- 🤝 Collaboration layer: shared manifests and comments
- 🔌 Plugin interface for custom detectors (drop caps, marginalia styles)
- 📊 Advanced metrics dashboard with quality trends
- 🎨 Element-specific adjustments (manual nudge/resize in UI)
- 📚 Multi-project workspace with cross-project priors

### Research & Exploration

- Handwriting transcription (HTR models)
- Full ePub/HTML reflow generation
- Cloud-optional backup/sync with E2E encryption
- AI-assisted element classification (title vs body text)

---

**Status Legend**:

- ✅ Implemented
- 🚧 In Progress
- 🎯 Planned
- 🌐 Future
- 🤝 Collaboration
- 🔌 Extensibility
- 📊 Analytics
- 🎨 UX Enhancement
- 📚 Multi-Project
