# Asteria Studio — UX Design & Interaction Patterns

## Design Principles

1. **Fail-closed UX**: Ambiguity routes to QA with clear explanations
2. **Deterministic outcomes**: Every action is traceable via manifests
3. **Keyboard-first**: All operations accessible without mouse
4. **Performance**: UI stays responsive during heavy processing
5. **Accessibility**: WCAG 2.2 Level AA compliance, visible focus, semantic HTML

## Information Architecture

### Top-level Navigation

```
📁 Projects       - Corpus library management
📊 Run History    - Past pipeline executions
⚡ Live Monitor   - Active run progress & control
🔍 Review Queue   - QA triage and decisions
📦 Exports        - Package & deliver outputs
⚙️ Settings       - Pipeline defaults & preferences
```

**Navigation shortcuts**: `Ctrl/Cmd + 1-6`
**Command palette**: `Ctrl/Cmd + K`

## Core Workflows

### 1. Import → Process → Review → Export

```
Projects → Import Corpus
  ↓
Configure target dimensions, DPI, pipeline stages
  ↓
Start Run → Monitor progress
  ↓
Review Queue appears for low-confidence pages
  ↓
Triage: Accept (A) / Flag (F) / Reject (R)
  ↓
Export normalized outputs + JSON sidecars
```

### 2. Review Queue Ergonomics (Keyboard-First)

**Primary workflow**: Designed for 500+ page books with minimal fatigue.

| Key                | Action          | Description                         |
| ------------------ | --------------- | ----------------------------------- |
| `J`                | Next page       | Move down in queue                  |
| `K`                | Previous page   | Move up in queue                    |
| `A`                | Accept          | Approve page, move to next          |
| `F`                | Flag            | Mark for later review, move to next |
| `R`                | Reject          | Reject page, move to next           |
| `U`                | Undo            | Undo last decision on current page  |
| `Space`            | Toggle overlays | Show/hide detection overlays        |
| `Tab`              | Cycle overlays  | Switch between overlay layers       |
| `1-9`              | Jump to page    | Quick navigation by number          |
| `Ctrl/Cmd + Enter` | Batch apply     | Apply decision to selection/range   |

**Overlay layers** (toggle individually):

- Page bounds (blue)
- Content box (green)
- Text blocks (amber)
- Ornaments (purple)
- Running heads (pink)
- Folios (cyan)
- Gutter bands (red)

### 3. Run Status & Feedback

**Run states**:

- `Queued` → `Running` → `Completed`
- `Paused` (user action) → `Resuming`
- `Cancelling` → `Cancelled` (consistent state)
- `Failed` (with error details)

**Progress visibility**:

1. **Run-level**: Total pages, ETA, throughput (pages/sec)
2. **Stage-level**: Current stage name, sub-step progress bar
3. **Page-level**: Per-page status badges (ok/flagged/error)

**Pause/Resume semantics**:

- Pause completes current atomic step, writes checkpoint
- Resume picks up from last checkpoint
- Cancel writes final manifest marking incomplete state

## Reason Codes (Plain Language)

**Instead of**: "Low bounds confidence (0.43)"
**Use**: "Page edges unclear — adjust crop manually or reprocess with higher contrast"

**Reason code examples**:

- `Crop box uncertain` → Suggested action: "Review crop or apply book-level priors"
- `High skew angle (>5°)` → "Verify rotation or enable deskew refinement"
- `Shadow detected on spine` → "Accept if spine shadow is acceptable, or enable shading correction"
- `Baseline inconsistency` → "Check for multi-column layout or illustration pages"

## Accessibility Features

### Keyboard Navigation

- **Tab order**: Logical, left-to-right, top-to-bottom
- **Focus visible**: 2px blue outline, never hidden
- **Skip links**: "Skip to main content" for screen readers
- **Modals**: Focus trapped, Escape to close, focus restored on dismiss

### Screen Reader Support

- Semantic HTML (`<nav>`, `<main>`, `<section>`, `<button>`, `<label>`)
- ARIA labels for icon-only buttons
- Live regions for progress updates
- Form labels and error associations

### Visual

- **Contrast ratios**: 4.5:1 minimum (text), 3:1 (UI elements)
- **Focus indicators**: Not reliant on color alone
- **Text scaling**: Supports browser zoom up to 200%
- **Reduced motion**: Respects `prefers-reduced-motion`

## Empty States & Onboarding

Every screen includes:

1. **Icon** (visual anchor)
2. **Headline** ("No projects yet")
3. **Description** (what this screen does)
4. **Primary action** ("Import Corpus")
5. **Help text** (what you need to proceed)

**First-run experience**:

1. Welcome screen with "Try sample project" button
2. Sample corpus (10-page synthetic book) bundled
3. Guided run: Import → Process → Review → Export
4. Success confirmation with "Create your own project" CTA

## Error Prevention & Recovery

### Destructive Actions

- **Delete project**: Confirmation dialog, shows page count
- **Cancel run**: Warns of incomplete state, offers pause instead
- **Reprocess all**: Shows diff from last run, requires confirmation

### Undo/Redo

- **Per-page decisions**: Undo available in review queue (U key)
- **Run-level**: Manifest versioning allows "revert to run X"
- **Settings**: "Reset to defaults" available for all config

### Error States

**When a page fails**:

- Show error message in plain language
- Suggest next actions ("Retry with higher DPI" / "Skip page" / "Review logs")
- Provide "Copy debug bundle" (logs + config + page metadata)

**When a run fails**:

- Mark as `Failed`, preserve partial outputs
- Show stage that failed + error reason
- Offer "Retry from last checkpoint" or "Restart"

## Performance Guarantees

1. **UI responsiveness**: No long tasks on main thread (16ms budget)
2. **Large lists**: Virtualized (render only visible items)
3. **Image loading**: Progressive (low-res preview → full resolution)
4. **IPC throttling**: Progress updates batched at 10 Hz
5. **Worker offload**: Heavy image processing in Web Workers

## Settings & Presets

**Three-tier configuration**:

1. **Global defaults** (conservative, safe)
2. **Per-project overrides** (saved in project manifest)
3. **Per-run snapshots** (immutable, versioned)

**Preset management**:

- Save custom presets ("My 300 DPI workflow")
- Load from library or file
- Show diff from defaults
- "Reset to recommended" button

## Microcopy Guidelines

**Avoid jargon**:

- ❌ "Book priors"
- ✅ "Consistency model" (with tooltip: "Median margins and baselines from sample pages")

**Reason codes**:

- ❌ "Bounds detection confidence: 0.43"
- ✅ "Page edges unclear (43% confidence) — review crop manually"

**Button labels**:

- ❌ "Execute"
- ✅ "Start Run"

**Confirmations**:

- ❌ "Are you sure?"
- ✅ "Delete 'Mind, Myth and Magick' (783 pages)? This cannot be undone."

## Testing & Quality

**Automated tests**:

1. **Keyboard navigation**: Tab order, focus visible, shortcuts work
2. **Screen reader**: ARIA labels present, semantic structure valid
3. **Visual regression**: Key screens captured, diffs flagged
4. **Performance**: List virtualization, no UI thread blocking
5. **Critical flows**: Import → Run → Review → Export (end-to-end)

**Acceptance criteria**:

- New user completes first run without external docs
- Review queue navigable entirely by keyboard
- UI responsive during 1000-page corpus processing
- Focus always visible and logical
- WCAG 2.2 Level AA validation passes

## Keyboard Shortcuts Reference

### Global

| Shortcut         | Action                  |
| ---------------- | ----------------------- |
| `Ctrl/Cmd + K`   | Open command palette    |
| `Ctrl/Cmd + 1-6` | Navigate to section     |
| `Ctrl/Cmd + ,`   | Open settings           |
| `F1`             | Show keyboard shortcuts |

### Review Queue

| Shortcut           | Action               |
| ------------------ | -------------------- |
| `J` / `↓`          | Next page            |
| `K` / `↑`          | Previous page        |
| `A`                | Accept page          |
| `F`                | Flag for review      |
| `R`                | Reject page          |
| `U`                | Undo decision        |
| `Space`            | Toggle overlays      |
| `Tab`              | Cycle overlay layers |
| `Ctrl/Cmd + Enter` | Batch apply          |
| `Esc`              | Close inspector      |

### Run Monitor

| Shortcut       | Action              |
| -------------- | ------------------- |
| `Ctrl/Cmd + P` | Pause/Resume run    |
| `Ctrl/Cmd + .` | Cancel run          |
| `Ctrl/Cmd + D` | Open details drawer |

## Design Rationale

**Why keyboard-first?**
Reviewing 500+ pages requires speed and low cognitive load. Keyboard navigation is 3-5x faster than mouse for repetitive triage tasks.

**Why visible focus always?**
Accessibility requirement; also aids sighted keyboard users in dense UIs.

**Why plain-language reason codes?**
Technical jargon ("deskew confidence: 0.43") requires mental translation. Plain language ("Page appears tilted — verify rotation") directly suggests action.

**Why three-tier config?**
Separates safe defaults from project-specific tuning from immutable run history. Enables reproducibility and easy rollback.

**Why deterministic manifests?**
Every run must be explainable: "What changed?" / "Why was this page flagged?" / "Can I reproduce this?" Manifests answer all three.
