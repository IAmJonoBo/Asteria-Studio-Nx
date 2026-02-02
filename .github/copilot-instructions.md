# Copilot Instructions for Asteria Studio

## Big picture
- This is an Electron desktop app with a React renderer and a Node main process; renderer communicates only through a secure preload bridge (contextIsolation: true, nodeIntegration: false). See apps/asteria-desktop/src/main/main.ts and apps/asteria-desktop/src/preload/index.ts.
- The pipeline is split into: UI shell (renderer), IPC/orchestrator (main), and a native Rust CV core loaded via N-API. Native bindings are resolved through packages/pipeline-core and loaded in apps/asteria-desktop/src/main/pipeline-core-native.ts.
- The pipeline outputs JSON sidecars conforming to spec/page_layout_schema.json and uses defaults in spec/pipeline_config.yaml. Corpus storage layout and flows are documented in docs/architecture.md.

## Key flows and boundaries
- Renderer never imports Node APIs; use window.asteria.ipc (typed in apps/asteria-desktop/src/ipc/contracts.ts) exposed by the preload bridge.
- IPC handlers live in apps/asteria-desktop/src/main/ipc.ts and are validated by apps/asteria-desktop/src/ipc/validation.ts before any work is done.
- Corpus scan + analysis live in apps/asteria-desktop/src/ipc/corpusScanner.ts and apps/asteria-desktop/src/ipc/corpusAnalysis.ts (used by IPC and pipeline runner).
- The CLI pipeline runner (apps/asteria-desktop/src/main/pipeline-runner.ts) orchestrates normalization and book-priors; it is the reference integration point for future Rust bindings.

## Developer workflows (pnpm workspace)
- App dev: pnpm -C apps/asteria-desktop dev (runs Vite renderer + Electron main).
- Build: pnpm -C apps/asteria-desktop build (renderer + main).
- Typecheck: pnpm -C apps/asteria-desktop typecheck.
- Unit/UI tests: pnpm -C apps/asteria-desktop test or test:ui (Vitest + jsdom).
- E2E tests: pnpm -C apps/asteria-desktop test:e2e (Playwright; uses Vite dev server).
- Pipeline eval: pnpm -C apps/asteria-desktop pipeline:run [projectRoot] [sampleCount].
- Export-only: pnpm -C apps/asteria-desktop pipeline:export <projectRoot> [count].

## Project-specific conventions
- IPC channels are prefixed with asteria: and typed via IpcChannels; validate inputs on both preload and main before invoking work.
- The pipeline runner writes artifacts to pipeline-results/ and expects project inputs under projects/{projectId}/input/raw/.
- Normalization is in TypeScript (apps/asteria-desktop/src/main/normalization.ts) and is currently the source of truth for metrics, previews, and QA signals.
- The Rust core is optional at runtime; load defensively via getPipelineCoreNative() and keep a JS fallback path.

## UX & accessibility standards
- **Keyboard-first**: All UI operations must be accessible without a mouse. Use semantic HTML and proper ARIA labels.
- **Focus visible**: Always show focus (`:focus-visible` with 2px outline). Never hide focus outlines without alternatives.
- **WCAG 2.2 Level AA**: Maintain 4.5:1 contrast for text, 3:1 for UI elements. Test with browser DevTools.
- **Keyboard shortcuts**: Documented in docs/ux.md. Review queue uses J/K navigation, A/F/R for accept/flag/reject, Space for overlay toggle.
- **Command palette**: Ctrl/Cmd+K opens global command palette for all actions and navigation.
- **Theme support**: Light/dark theme via `useTheme()` hook, persisted in localStorage, respects `prefers-color-scheme`.
- **Design tokens**: All spacing, colors, typography defined in `src/renderer/theme/tokens.ts` and applied via CSS custom properties.
- **Empty states**: Every screen has empty/loading/error states with clear next actions.
- **Plain-language reason codes**: Avoid jargon; use actionable descriptions ("Page edges unclear — review crop manually" instead of "Bounds confidence: 0.43").

## Integration points
- External deps: sharp for image manipulation; Playwright and Vitest for testing.
- Data contracts: PageLayoutSidecar mirrors spec/page_layout_schema.json; update both the schema and contracts together.
- UI components: Reusable components in `src/renderer/components/`, screens in `src/renderer/screens/`.
- Style guide: See docs/style.md for component patterns, accessibility checklist, and visual quality standards.
