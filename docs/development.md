# Development

## Quick Commands

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

## Nx Usage

```bash
# Graph
pnpm nx -- graph

# Affected (CI-style)
pnpm affected:lint
pnpm affected:test
pnpm affected:build

# Run many targets locally
pnpm nx -- run-many -t lint,test,build
```

## Formatting

- Check formatting: `pnpm format`
- Apply formatting: `pnpm format:write`

## Golden Corpus Tests

```bash
pnpm golden:test
```

## Rust (Pipeline Core)

```bash
cd packages/pipeline-core
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all
```

## Environment Configuration

Copy `.env.example` to `.env` for local overrides. Key options include:

- `ASTERIA_OUTPUT_DIR`
- `ASTERIA_PIPELINE_CONFIG_PATH`
- `ASTERIA_REMOTE_LAYOUT_ENDPOINT`
- `ASTERIA_REMOTE_LAYOUT_TOKEN`
