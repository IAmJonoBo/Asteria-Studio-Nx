# Asteria Studio — Guides, Layout Intelligence, Snapping, Templates (Spec Brief)

**Purpose:** Provide a single, implementation-ready specification brief for Codex (planning tool) covering the work discussed since **“Executive snapshot”**: structural guides (baseline grids + InDesign-like tools), improved page/layout typing, confidence-weighted snapping, template/master-page systematisation, and a disciplined training-signal loop—while preserving determinism, QA, and keyboard-first ergonomics.

**Status assumptions:** Private repo; offline-first; security not a priority. Large binaries removed; pipeline already exists with run artifacts, review queue, config snapshots, and golden-test scaffolding.

---

## 1) Goals

### Product goals

1. **InDesign-inspired structural tools** for review and refinement:
   - baseline grid, rulers, margin/column guides, gutter, head/footer bands, ornament anchors.
2. **Confidence-gated intelligence**:
   - guides rendered only when confident; every auto decision labelled with `source` and `confidence`.
3. **Smart snapping**:
   - confidence-weighted magnetism to priors + guides + detected elements with a snap zone model.
4. **Template (“master page”) system**:
   - cluster pages into templates; expose template guides; allow confirm/correct/apply across page ranges/sections.
5. **Training-data capture that is directly learnable**:
   - every user correction becomes structured training signal with deltas vs auto, labels, and provenance.

### Engineering goals

- Deterministic outputs; run-scoped artifacts; reproducible config snapshots.
- Impeccable QA: unit + integration + golden regressions + minimal E2E.

---

## 2) Non-goals (explicitly out of scope for this tranche)

- Security hardening, sandboxing, external threat model.
- Full OCR, semantic text reconstruction, EPUB reflow.
- End-to-end learned models for everything (heuristics + light ML OK; training loop prepares future ML).
- Full deep-zoom tiling infrastructure (optional later).

---

## 3) Design principles and constraints

1. **Fail-closed:** uncertainty routes to QA and is explained; no silent destructive actions.
2. **Coordinate sanity:** one canonical coordinate space for guides and overlays:
   - **normalized image pixel space** (preferred) with explicit mapping to preview scale and crop/trim boxes.
3. **Truthful UI:** never show authoritative guides without confidence gating + explanation.
4. **Keyboard-first pro tooling:** every frequent action must be accessible without a mouse.
5. **Progressive disclosure:** novices get a simple flow; experts can open advanced panels.

---

## 4) Feature set

### 4.1 Guides Mode (Review Queue)

**Add a dedicated “Guides” mode** in Review Queue, including:

- Baseline grid + baseline peaks (when applicable)
- Rulers (x/y) with tick marks + optional labels (zoom-dependent)
- Margin guides (box)
- Column guides (x positions + inter-column gutter)
- Gutter band/centreline (for spreads and dual-page scans)
- Header/footer bands (running head/folio regions)
- Ornament anchors (hash-matched repeating decorators)

**Interactions:**

- Layer toggles (Groups: Structural Guides, Detected Elements, Diagnostics)
- Solo layer (Alt-click layer toggle)
- Group opacity sliders
- Quick toggle keys:
  - `G` baseline grid
  - `Shift+G` baseline peaks
  - `H` head/footer bands
  - `C` column guides
  - `M` margin guides
  - `U` gutter
  - `R` rulers
- “Hold modifier to reveal shortcuts” overlay on demand.

**Editable controls (Baseline grid panel):**

- Spacing (slider + numeric input)
- Offset/origin (slider + numeric input + draggable origin line)
- Angle (nudge ±0.1°, numeric input)
- Snap to peaks (sets spacing/offset from peaks)
- Mark as correct (training label without changing values)
- Apply override (persist to run + training signal)

**Apply scope (optional but high impact):**

- Apply to page only (default)
- Apply to selection (multi-select pages)
- Apply to section/template (advanced; see Templates below)

---

### 4.2 Visual Design System for Guides (clean, non-cluttered)

#### Tokens (CSS variables)

**Core guide palette (neutral, structural):**

- `--guide-passive: rgba(148,163,184,0.22)`
- `--guide-major: rgba(148,163,184,0.32)`
- `--guide-hover: rgba(59,130,246,0.55)`
- `--guide-active: rgba(59,130,246,0.85)`

**Snap feedback (temporary during drag only):**

- `--snap-line: rgba(34,211,238,0.95)`
- `--snap-glow: rgba(34,211,238,0.35)`

**Band fills (very light):**

- `--band-headfoot: rgba(236,72,153,0.08)`
- `--band-gutter: rgba(239,68,68,0.08)`

**Label pills (theme-aware):**

- Light mode: `rgba(255,255,255,0.75)`
- Dark mode: `rgba(17,24,39,0.65)`

#### Stroke widths & dash patterns (screen pixels; SVG)

| Layer                           | Stroke | Dash   | Notes                   |
| ------------------------------- | -----: | ------ | ----------------------- |
| Baseline grid (minor)           |    1.0 | solid  | hidden below zoom 0.8   |
| Baseline grid (major every N=4) |    1.0 | solid  | slightly higher opacity |
| Baseline origin line            |    2.0 | solid  | draggable + label       |
| Margins                         |    1.5 | `6 4`  | dashed                  |
| Columns                         |    1.5 | `2 4`  | dot-dash feel           |
| Gutter centreline               |    1.5 | `10 6` | only when relevant      |
| Ruler ticks                     |    1.0 | solid  | labels only > 1.6 zoom  |
| Smart snap guide                |    2.0 | solid  | add glow filter         |

#### Level-of-detail by zoom (avoid GIS clutter)

- Zoom < 0.8: only major guides + origin lines; no labels
- 0.8–1.6: full guides; labels only for active/hover
- > 1.6: show ruler labels + optional guide labels

#### Interaction states

- `passive` default (low opacity)
- `hover` (medium opacity)
- `active/selected` (high opacity, thicker stroke where applicable)
- Snap guides appear only while dragging, never persistent.

---

### 4.3 Baseline grid computation (make “auto” trustworthy)

#### Inputs

- Cropped text ROI (from content mask / layout blocks)
- Row projection signal (binarised or edge-based)
- Optional orientation signal (if residual skew/angle is known)

#### Outputs (per page)

- `metrics.baseline.peaksY?: number[]` (baseline candidate positions in normalized coords)
- `normalization.guides.baselineGrid`:
  - `spacingPx`
  - `offsetPx` (origin)
  - `angleDeg`
  - `confidence` (0–1)
  - `source: "auto" | "user"`

#### Confidence gating

Baseline grid should render only if:

- Page type is text-dominant (see 4.5)
- Peaks are consistent (median absolute deviation below threshold)
- Peak sharpness/contrast meets threshold
- Minimum peak count met (avoid sparse pages)

#### User adjustments

User edits write to:

- `overrides.guides.baselineGrid` (same shape)
- Training signals: record absolute + delta vs auto, plus “confirmed” boolean.

---

### 4.4 Smart snapping (“confidence-weighted magnetism”)

#### Snapping sources (priority)

1. **Template/master guides & book priors** (strong, stable)
2. **Detected elements** with high confidence (heads/folios/ornaments/columns)
3. **Baseline grid** (only if confident and relevant)
4. **User guides** (always honoured)

#### Snap zone model (avoid sticky behaviour)

- Each snap target defines a **snap radius** in px.
- Cursor/handle snaps only when within radius.
- Provide:
  - Toggle: Snap enabled
  - Temporary disable while dragging (hold Ctrl/Cmd)

#### Snap feedback

- Show Smart Guide lines only during drag:
  - snap line + glow
  - optional small tooltip: “Snapped to: Baseline / Column / Template guide”

#### Config

Add config keys:

- `snapping.enabled` (default true)
- `snapping.radiusPx` (default 6–10)
- `snapping.minConfidence` per source type
- `snapping.weighting` per source type

---

### 4.5 Page/layout typing + “master page” templates

#### Objective

Accurately detect page/layout types and systematise repeated structures (InDesign-like “master pages”).

#### Approach: features → clustering → labels

Compute measurable features and cluster pages into templates:

- text density heatmaps / projection profiles
- column count and widths (valley detection)
- head/footer band presence (repeatability)
- folio position band
- ornament hash matches
- whitespace ratio + connected components stats
- baseline grid confidence + spacing consistency
- spread likelihood / gutter signature

Cluster pages → create **template objects**:

- margin box
- column guides
- header/footer bands
- baseline grid (dominant, per section/template)
- ornament anchor expectations

Assign each page:

- `pageType` (enum)
- `templateId`
- per-template confidence

#### Page type taxonomy (initial)

- `blank_or_near_blank`
- `body_1col`
- `body_2col`
- `chapter_opening`
- `title_page`
- `front_matter`
- `index_dense`
- `plate_illustration`
- `table_heavy`
- `spread`

#### Template editor (UI)

- Template inspector (read-only first):
  - preview representative pages
  - show guides
  - show confidence and feature summary
- “Confirm/correct template”:
  - adjust guides once, apply across pages in template
  - record training signals for template adjustments

---

### 4.6 Training data capture (directly learnable)

**Rule:** any user change becomes structured training signal.

#### Training bundle layout (run-scoped)

`runs/<runId>/training/`

- `page/<pageId>.json` training record
- `template/<templateId>.json` (if template edits)
- `manifest.json` listing records + provenance

#### Training record fields (page)

- `auto.guides.baselineGrid` (if present)
- `final.guides.baselineGrid`
- `delta.guides.baselineGrid` (spacing/offset/angle)
- `confirmed`: true/false
- `pageType` + `templateId`
- `features` (optional snapshot for offline learning)
- `timestamp`, `appVersion`, `configHash`, `runId`

#### Training record fields (template)

- template guide definitions (final)
- list of pages applied
- deltas vs auto template

---

## 5) Implementation tasks (Codex-ready)

### 5.1 Fix run-scoping end-to-end

- Ensure **all writes** (normalized, previews, overlays, sidecars, manifests, review queues) are run-scoped.
- Ensure **all reads** in IPC and renderer are run-aware.
- Add tests that fail if global output paths are used.

### 5.2 Guides rendering system

- Implement a guide layer framework:
  - layer registry suggests: id, group, defaultVisible, renderFn, hitTestFn, editableFn
- Implement tokenised styling via CSS vars.
- Implement LOD by zoom.

### 5.3 Baseline grid compute + UI editor

- Compute `peaksY`, spacing, offset, confidence.
- Render baseline grid + peaks.
- Implement Baseline Grid panel and persist overrides.
- Update training signal export on submit-review.

### 5.4 Snapping engine

- Implement a central snapping engine used by all draggable tools.
- Add smart guide feedback while dragging.
- Add config for snap radii/conf thresholds.

### 5.5 Template system

- Implement feature extraction and clustering.
- Persist templates in run manifest (and later project-level caches).
- Add template inspector UI.
- Add apply-to-template controls for guides and training output.

### 5.6 Preview and performance

- Progressive previews:
  - low-res first, refine.
- Avoid blocking renderer:
  - move heavy computations to main/worker threads.
- Virtualise long lists.

---

## 6) QA / Testing requirements

### Unit tests

- Baseline peak detection determinism (seeded fixtures)
- Coordinate mapping (normalized px ↔ preview coords)
- Snapping engine: snap-zone behaviour, priority ordering, disable modifier

### Integration tests (guides)

- End-to-end artifact scoping: two runs must not collide
- IPC run-aware fetch: fetch-page and fetch-sidecar read correct runDir
- Apply override → sidecar merge → review UI reflects changes
- Submit review writes training bundle with baseline grid deltas

### Golden regressions

- Add at least 1–2 pages in golden corpus where baseline grid is expected.
- Validate:
  - guide JSON deterministically, and/or
  - overlay raster diffs (SSIM or pixelmatch) if available.

### E2E smoke (Playwright)

- Import → start run → open review → toggle guides → adjust baseline → apply → submit → export.

---

## 7) Config and docs

### Config updates

- Add/extend config sections:
  - `steps.baseline_grid` (confidence floor, peak params)
  - `snapping.*` (radius, weighting, min confidence)
  - `templates.*` (clustering params)
  - `guides.lod.*` (zoom thresholds)

### Docs to update

- `docs/style.md` (guide tokens + line specs)
- `docs/ux.md` (Guides mode, shortcuts, snapping)
- `docs/testing_golden_corpus.md` (baseline cases + diff interpretation)
- `docs/agent_instructions.md`:
  - “No heuristic without confidence + source”
  - golden required for guide/snap/template threshold changes
  - run scoping invariants

---

## 8) Acceptance criteria

1. **Run integrity:** no global artefact writes; all outputs run-scoped; run-aware reads only.
2. **Baseline grid:** appears only when confidence gated and page type supports it; labelled auto vs user.
3. **Editing:** user can adjust baseline spacing/offset/angle; changes persist; sidecars reflect override; training record written.
4. **Snapping:** snap zone + priority ordering + temporary disable works; smart guide feedback only during drag.
5. **Templates:** at least basic clustering into templates; UI shows template guides; applying template edits works.
6. **QA:** unit + integration + golden + minimal E2E pass; failures produce actionable diffs and logs.

---

## 9) Implementation order (recommended)

1. Run-scoping invariants + tests
2. Guide layer framework + tokenised styling + LOD
3. Baseline compute + baseline grid UI + training capture
4. Snapping engine + smart guide feedback
5. Page typing improvements + template clustering + inspector UI
6. Apply-to-template + batch reprocess

---

## References (design inspiration; not dependencies)

- Adobe InDesign: grids, guides, Snap To Guides behaviour, Smart Guides concepts.
- WCAG 2.2 focus visibility/appearance principles for keyboard-first UIs.
- Electron performance principles: keep heavy work off renderer thread.
