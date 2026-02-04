# Asteria Studio — `pnpm preflight` Task Spec

This document defines what **`pnpm preflight`** runs, what it outputs, and what constitutes pass/fail.

---

## 1) Command

Add a root script:

```json
{
  "scripts": {
    "preflight": "node ./tools/preflight/run-preflight.mjs"
  }
}
```

---

## 2) Outputs

`tools/preflight/` should write:

- `artifacts/preflight/preflight-report.json`
- `artifacts/preflight/preflight-report.md`
- `artifacts/preflight/logs/*.stdout.log`
- `artifacts/preflight/logs/*.stderr.log`
- `artifacts/preflight/diffs/` (only if golden fails; copy `.golden-artifacts` if present)

The report must include:
- git commit hash
- app version
- OS/Node/Electron versions (as available)
- command results (pass/fail + logs pointer)
- release gate summary

---

## 3) Steps (in order)

### Step A — Static checks
1) `pnpm nx run asteria-desktop:lint`
2) `pnpm nx run asteria-desktop:typecheck`
3) `pnpm nx run asteria-desktop:build:main` (skip with `PREFLIGHT_SKIP_BUILD=1`)

Fail if any fails.

### Step B — Tests
4) `pnpm nx run asteria-desktop:test` (or explicit unit/integration/renderer suite)
5) `pnpm nx run asteria-desktop:golden` (skip with `PREFLIGHT_SKIP_GOLDEN=1`)
6) `pnpm nx run asteria-desktop:e2e` (skip with `PREFLIGHT_SKIP_E2E=1`)

Fail if any fails. On golden failure, ensure diff artifacts are written.

### Step C — Determinism tripwires
7) Run a tiny corpus run twice using `node tools/preflight/run-pipeline.mjs` (built main required):
   - corpus resolved from `PREFLIGHT_CORPUS_DIR`, else `tests/fixtures/golden_corpus/v1/inputs`
   - sample count defaults to 2 (`PREFLIGHT_SAMPLE_COUNT` to override)
   - Confirm `runs/<runId>/...` artefacts exist
   - Confirm forbidden global paths do **not** exist
   - Confirm stable manifest schema and atomic JSON writes

Fail if:
- forbidden directories created
- run manifests or review queues are not parseable
- run collisions detected (same pageId overwrites across runs)

### Step D — Bundle sanity (run output)
8) Verify the latest run output contains:
- manifest.json
- report.json
- review-queue.json
- sidecars/
- normalized outputs

Fail if missing.

### Step E — Basic performance smoke (non-benchmark)
9) Record pipeline run duration + throughput:
- warn if runtime exceeds the configured threshold (default 120s)
- additional UI responsiveness checks remain manual (see prelaunch checklist)

Fail only on severe cases (e.g., obvious freeze); otherwise warn.

---

## 4) Pass/fail rules

**FAIL** on:
- any lint/typecheck/test failures
- golden regressions outside tolerance
- any global artefact writes
- export missing required provenance files
- unparseable JSON manifests/review queues
- uncaught exceptions in logs during the run

**WARN** on:
- performance thresholds exceeded
- minor UI/accessibility advisory checks (unless you decide to promote them to FAIL)

---

## 5) Recommended implementation notes

- Use `execa` to run commands and capture stdout/stderr.
- Ensure deterministic temp dirs.
- Store command timings in the report.
- Keep the script fast; avoid heavy corpora.

---

## 6) Developer usage

- Normal dev loop: `pnpm preflight` before creating a release tag.
- CI: run `pnpm preflight` on release branches and upload `artifacts/preflight/` as build artifacts.

---

## 7) Overrides

- `PREFLIGHT_SKIP_GOLDEN=1`: skip golden tests (warns).
- `PREFLIGHT_SKIP_E2E=1`: skip E2E tests (warns).
- `PREFLIGHT_SKIP_PIPELINE=1`: skip determinism/bundle checks (warns).
- `PREFLIGHT_SKIP_BUILD=1`: skip build:main (warns; determinism will fail without dist output).
- `PREFLIGHT_CORPUS_DIR=/path/to/corpus`: explicit corpus root for determinism runs.
- `PREFLIGHT_SAMPLE_COUNT=2`: override sample size for determinism runs.
