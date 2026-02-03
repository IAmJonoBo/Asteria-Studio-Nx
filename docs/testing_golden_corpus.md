# Golden corpus testing

The golden corpus provides deterministic fixtures and regression checks for the normalization pipeline.

## Commands

- Generate inputs + truth:

```sh
pnpm golden:generate
```

If your default `python3` is incompatible (for example, Python 3.14), set:

```sh
GOLDEN_PYTHON=python3.11 pnpm golden:generate
```
- Bless expected outputs (writes `expected/`):

```sh
pnpm golden:bless
```

If needed:

```sh
GOLDEN_PYTHON=python3.11 pnpm golden:bless
```

- Run regressions:

```sh
pnpm golden:test
```

## Adding a new golden case

1) Update `tools/golden_corpus/generate.py` with a new page spec and truth fields.
2) Add a manifest entry (tags + SSIM threshold).
3) Run `pnpm golden:bless` to capture new expected outputs.
4) Commit the updated fixtures and expected outputs.

### Current case expectations

- **Rotation**: `p13_rotation_only` isolates skew handling without perspective warps.
- **Gutter splits**: `p14_spread_light_gutter` validates split confidence with a lighter gutter.
- **Crop adjustments**: `p15_crop_adjustment` stresses trim/crop alignment by pushing content toward the edges.
- **Overlay element classes**: `p16_overlay_elements` ensures overlay classes (title, drop cap, marginalia, footnotes, ornament) are present in review overlays.

### Baseline cases (v1 manifest)

Use these baseline cases as the minimum sanity set when evaluating changes or scanning diff bundles:

- **`p01_clean_single`** — clean single-column page (baseline for clean text + margins).
- **`p02_clean_double`** — clean two-column layout (column detection + spacing).
- **`p03_running_head_folio`** — running head + folio bands (header/footer segmentation).
- **`p04_ornament`** — ornament page (ornament class + hash validation).
- **`p05_footnotes_marginalia`** — footnotes and marginalia (side-structure detection).
- **`p06_blank_verso`** — blank page handling (blank detection + minimal artifacts).
- **`p07_plate`** — illustration plate (non-text segmentation).
- **`p08_shadow_left`** / **`p09_shadow_right`** — gutter shadow handling.
- **`p10_spread_dark_gutter`** — dark gutter spread split.
- **`p11_curved_warp`** — baseline curve/warp handling.
- **`p12_rot_perspective`** — rotation + perspective warp stress.

## SSIM thresholds

- Default threshold is `0.99`.
- Lower thresholds only when a deterministic change is expected (warps, gutter blends, crop stress cases).
- The lighter gutter split case (`p14_spread_light_gutter`) uses `0.98` because the gutter blend can produce slightly more variance.
- When adjusting thresholds, update `tests/fixtures/golden_corpus/v1/manifest.json` and document the rationale in the commit message.

## Failure diagnostics

On failure, the test writes an artifact bundle to `.golden-artifacts/<runId>/` with:

- SSIM score per page
- diff images for mismatched outputs
- a short report of the failing rule

Optional: enable ornament hash validation with `GOLDEN_CHECK_ORNAMENT_HASHES=1`.

Open the diff images to understand whether the change is a regression or an intentional update.

### Diff interpretation

When reviewing `.golden-artifacts/<runId>/diffs/`:

- **Small localized halos on edges**: often indicate crop or deskew adjustments.
- **Full-frame brightness shifts**: likely shading or background normalization changes.
- **Color-coded mask mismatches**: suggest segmentation/class changes (e.g., text blocks vs ornaments).
- **Gutter split offsets**: check spread detection logic or split thresholds.
- **New artifacts near borders**: review page bounds confidence and trim logic.

If the diff aligns with an intentional change, document the rationale and re-bless expected outputs.
