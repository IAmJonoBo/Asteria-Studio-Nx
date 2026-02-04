# Getting Started

## Prerequisites

- Node.js `24.13.0` (see `.node-version`)
- `pnpm` `10.28.2` (see `package.json`)
- Rust toolchain (optional, for `packages/pipeline-core`)

## Install

```bash
pnpm install
```

## Run the Desktop App

```bash
pnpm dev
```

## Common Tasks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Offline (Air-Gapped) Notes

If you need to work without internet access, pre-seed dependencies and follow
the offline install steps in `docs/ci-cd.md`.
