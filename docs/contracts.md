# Asteria Studio — Contracts Notes

## Guides + Overrides (Contracts + UI Architecture)

### Guiding principles

- **Overrides live in `overrides.guides`** (not adjustments). This keeps layout intent separate from geometric corrections and supports a clean merge model:
  $$\text{effectiveGuides} = \text{autoGuides} \oplus \text{templateGuides} \oplus \text{userOverrides}$$
- **Persist minimal guide metadata** for determinism and auditability:
  - `role` (baseline/margin/column/headerBand/footerBand/gutter/ornament/etc.)
  - `source` (auto | template | user)
  - `confidence` (0–1)
  - deterministic `id`
  - optional `locked`
- **Derive styling at render time** (color, dashes, opacity, LOD).

### Sidecar structure

- `normalization.guides`: auto measurements/estimates (baseline grid, etc.).
- `templates.*`: template priors (optional; may live in run manifest).
- `overrides.guides`: user edits, per page.

### UX architecture

- Guides panel lives in the right inspector with View/shortcut toggles.
- Sections:
  - **Guides**: layers, opacity, LOD, snapping toggles.
  - **Baseline Grid**: spacing/offset/angle + snap-to-peaks + mark-correct.
  - **Template**: apply scope (page/section/template).
- View actions and shortcuts: Toggle Guides, Toggle Rulers, Toggle Snapping, Reset View.

### Snapping model

- Snapping follows the InDesign mental model: baseline grid participates in **Snap To Guides**.
- Provenance is visible in tooltips and guide styling.
