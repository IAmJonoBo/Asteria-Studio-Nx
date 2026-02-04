# Contributing

Thanks for your interest in contributing to Asteria Studio. This guide explains
how to set up the repo, run checks, and submit changes.

## Prerequisites

- Node.js `24.13.0` (see `.node-version`)
- `pnpm` `10.28.2` (see `package.json`)
- Rust toolchain (optional, only for `packages/pipeline-core`)

## Local Setup

```bash
pnpm install
pnpm dev
```

### Optional: Air-Gapped Setup

If you need an offline install, follow the steps in `docs/ci-cd.md`.

## Project Structure

- `apps/asteria-desktop`: Electron + React app
- `packages/ui-kit`: Shared UI components
- `packages/pipeline-core`: Rust CV core
- `docs/`: Documentation and ADRs
- `tools/`: Tooling scripts

## How We Work

- Prefer small, focused PRs with clear descriptions.
- Keep build, test, and lint green before requesting review.
- Update documentation alongside behaviour changes.

## Coding Standards

- TypeScript and ESLint are enforced.
- Use `pnpm format` before committing.
- Keep changes deterministic and reproducible.

## Branching & Commits

- Branch from `main`.
- Use short-lived feature branches.
- Commit messages: `type(scope): summary`
  - Examples: `feat(desktop): add pipeline status`, `fix(ci): pin node`

## Tests & Checks

```bash
# Lint
pnpm lint

# Typecheck
pnpm typecheck

# Unit/integration tests
pnpm test

# E2E (Playwright)
pnpm test:e2e

# Build
pnpm build

# Nx affected (CI-style)
pnpm ci:lint
pnpm ci:test
pnpm ci:build
```

## Pull Requests

- Fill out the PR template.
- Link issues where relevant.
- Ensure required checks pass.

## Security

For security issues, follow `SECURITY.md` and do not open a public issue.
