# Security

## Threat Model (Lite)

### Assets

- Source code and models
- Build artefacts and installers
- Pipeline outputs and customer data

### Trust Boundaries

- Developer machines
- CI runners (cloud or self-hosted)
- Remote cache services

### Key Risks

- Dependency supply-chain attacks
- Cache poisoning in remote caches
- Leaked secrets in CI logs or artefacts

## Dependency Policy

- Depend on pinned versions with a committed lockfile.
- Prefer vetted registries and mirrors in restricted environments.
- Review update PRs and verify checksums when available.

## Secrets

- Store tokens in CI secrets, never in the repo.
- Use least-privilege tokens for cache and release systems.
- Rotate secrets regularly.

## Build Integrity

- Use Nx local cache by default.
- Keep air-gapped builds fully offline after dependency seeding.
