# ADR-0002: Caching Strategy (Local and Remote)

## Status

Accepted — 2026-02-04

## Context

CI runs in both cloud and air-gapped environments. We need reliable caching
without depending on public internet access or introducing cache-poisoning
risks.

## Decision

- Default to **local Nx cache** stored at `.nx/cache`.
- Allow **remote cache** via:
  - Nx Cloud (optional, when `NX_CLOUD_ACCESS_TOKEN` is set), or
  - Self-hosted cache server via `NX_REMOTE_CACHE_URL`.

Cache mode is controlled by `NX_CACHE_MODE=local|remote`.

## Security Considerations

If using bucket-backed caches (S3/MinIO/GCS/Azure), we must:

- Use read-only credentials for PRs.
- Use read-write credentials only on trusted branches.
- Scope cache keys by branch and pipeline context.
- Rotate credentials and audit access.

Residual risk: a compromised trusted pipeline can still poison caches. Where
possible, gate cache writes behind review or signing.

## Consequences

**Pros**

- Works offline once caches are pre-seeded.
- Optional remote cache for faster CI.

**Cons**

- Extra operational overhead for a self-hosted cache server.
