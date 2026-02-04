# ADR-0001: Adopt Nx for Monorepo Orchestration

## Status

Accepted — 2026-02-04

## Context

The repo already contains multiple apps and packages with mixed tooling (Node,
Electron, Rust). CI needs to be faster and more deterministic, and we need a
single task runner that works in both cloud and air-gapped environments.

## Decision

Adopt Nx as the monorepo backbone:

- Standardise task orchestration via `nx` targets.
- Enable local caching for build/test/lint.
- Support optional remote caching (Nx Cloud or self-hosted).

## Consequences

**Pros**

- Faster CI with affected-based execution.
- Consistent task interface across packages.
- Explicit caching and deterministic inputs.

**Cons**

- Additional configuration and maintenance.
- Developers must learn Nx commands and cache behaviour.

## Alternatives Considered

- Use only pnpm scripts: simpler but lacks affected-based orchestration.
- Migrate to another build system (Turbo, Bazel): larger disruption.
