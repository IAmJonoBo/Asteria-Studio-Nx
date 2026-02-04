# Asteria Studio — Prelaunch Checklist (Release Preflight)

> **Scope:** Everything except security. Target is “release-grade”: deterministic pipeline, truthful UX, strong QA, packaging polish, and sane defaults.

---

## 0) Release gates

### Hard gates (must pass)
- ✅ `pnpm preflight` passes (lint, typecheck, unit/integration/renderer tests, golden regressions, E2E smoke).
- ✅ **Run integrity**: *no* global artefact writes; all outputs are run-scoped; run-aware IPC reads.
- ✅ **UI responsiveness**: no renderer freezes during processing/review; progress updates throttled.
- ✅ **Keyboard-first**: all primary flows work without pointer; focus indicator is clearly visible and not obscured.
- ✅ **Truthful UI**: every “auto” decision shows **source + confidence**; low-confidence guides are gated or clearly labelled.

### Soft gates (strongly preferred)
- ✅ Smoke on macOS + Windows (fresh install).
- ✅ No known crashers; logs show no unhandled promise rejections.
- ✅ Performance targets met (startup time, queue scrolling, preview loading).

### Preflight evidence
- [ ] Attach `artifacts/preflight/preflight-report.md`
- [ ] Attach `artifacts/preflight/preflight-report.json`
- [ ] Preflight report status = PASS (no failures)

---

## 1) Automated checks

### 1.1 Code quality
- [ ] Lint clean (`pnpm nx run asteria-desktop:lint`)
- [ ] Typecheck clean (`pnpm nx run asteria-desktop:typecheck`)
- [ ] No disabled eslint rules in app code (especially React hooks)
- [ ] No stray binaries / `.DS_Store` / build outputs committed

### 1.2 Tests
- [ ] App test suite pass (`pnpm nx run asteria-desktop:test`)
- [ ] Golden regressions pass (`pnpm nx run asteria-desktop:golden`)  
  - On failure, diffs include SSIM/pixelmatch metrics + diff images.
- [ ] E2E smoke pass (`pnpm nx run asteria-desktop:e2e`)

### 1.3 Determinism tripwires
- [ ] Tripwire: assert **no creation** of:
  - `outputDir/normalized`, `outputDir/previews`, `outputDir/sidecars`, `outputDir/overlays`
- [ ] Two consecutive runs produce distinct `runs/<runId>/…` trees with no collisions
- [ ] Corpus scan ordering is deterministic and documented
- [ ] All JSON writes are atomic (temp + rename)

---

## 2) Functional preflight (human QA)

### 2.1 Happy path
- [ ] Create/import project (folder picker + project metadata saved)
- [ ] Start run; monitor shows *honest* progress (no fake stage bars)
- [ ] Run completes; review queue opens; pages show correct previews and sidecars
- [ ] Apply guide edits (baseline/columns/margins, etc); overrides persist
- [ ] Submit review: training bundle is written and manifest updated
- [ ] Export run: bundle includes artefacts + provenance (manifest/config/report/review queue/sidecars/training)

### 2.2 Review Queue ergonomics
- [ ] Keyboard loop: J/K, A/F/R/U etc. all function and are documented
- [ ] Layers panel: group opacity sliders; solo layer; LOD by zoom
- [ ] Smart snapping:
  - snap zone behaviour is predictable
  - can disable snapping while dragging (Ctrl/Cmd)
  - smart guide lines show only during drag

### 2.3 Guides correctness (trust surface)
- [ ] Baseline grid is **confidence-gated**; auto vs user source displayed
- [ ] Baseline peak view (if enabled) matches page content plausibly
- [ ] Coordinate mapping stable under zoom/pan; no drift
- [ ] “Mark as correct” writes a training label without changing geometry
- [ ] “Apply to selection / section / template” works if implemented

---

## 3) Performance & stability

### 3.1 Electron-specific
- [ ] No long-running ops in renderer or main thread that freeze UI (use async + workers)
- [ ] IPC progress events throttled (e.g., 5–10 Hz)
- [ ] Lists virtualised (runs/pages/queue) and remain smooth with 500+ pages
- [ ] Previews load progressively (low-res first; refine) and cache effectively

### 3.2 Memory/CPU
- [ ] Run a “large-ish” corpus and ensure CPU stays bounded; memory doesn’t leak over time
- [ ] Cancelling a run is cooperative and leaves consistent manifests

---

## 4) Accessibility & input

- [ ] Focus indicator always visible (and not obscured by overlays)
- [ ] Keyboard navigation covers every control (including sliders and layer toggles)
- [ ] Dragging operations have keyboard alternatives where feasible
- [ ] Labels are not placeholder-only; icons have accessible names

---

## 5) Desktop app “standard shipping” items

### 5.1 Menus and commands
- [ ] Application menu includes:
  - About (version + build hash)
  - Preferences/Settings (Cmd+, on macOS)
  - Hide/Show/Quit (platform standard)
- [ ] File menu includes:
  - New project / Import corpus
  - Export run
  - Page setup (if applicable)
- [ ] View menu includes:
  - Toggle Guides, Toggle Rulers, Toggle Layers, Zoom controls
- [ ] Help menu includes:
  - Keyboard shortcuts
  - Troubleshooting / Diagnostics
  - Open logs folder
  - Open current run folder

### 5.2 Diagnostics bundle (must have)
- [ ] “Copy debug bundle” produces:
  - run manifest + config snapshot + last logs + minimal metadata
  - (no huge binaries unless user opts in)

### 5.3 First-run experience
- [ ] Onboarding checklist ends in a successful sample run on a tiny corpus
- [ ] Default output location is clear and editable

---

## 6) Release packaging

- [ ] Versioning: semver; build hash stored in About + manifests
- [ ] Cross-platform file URL handling uses `pathToFileURL`
- [ ] License attributions accessible in-app and included in export bundle
- [ ] Clean install/uninstall behaviour verified on macOS + Windows

---

## 7) Release sign-off

- [ ] All hard gates passed
- [ ] Known issues recorded with severity and mitigation
- [ ] Release notes written (new features, known limitations, upgrade notes)
