# Development

## Quick Commands

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm validate
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
- Trunk format check: `pnpm trunk:fmt`

## Golden Corpus Tests

```bash
pnpm golden:test
```

## Tooling Upgrades

```bash
pnpm upgrade:stack
```

This updates workspace dependencies, upgrades Trunk-managed linters, and syncs
the Node version metadata from the current runtime.
By default it skips dependency or Trunk upgrades if the last run was within the
previous 24 hours. Use `pnpm upgrade:stack -- --force` to override the cooldown
or `UPGRADE_COOLDOWN_HOURS` to change the window.

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
