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
