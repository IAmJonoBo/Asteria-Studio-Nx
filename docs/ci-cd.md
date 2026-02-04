# CI/CD

This repo supports two CI modes:

- **Cloud CI** (GitHub Actions runners with internet access)
- **Air-gapped CI** (self-hosted runners without public internet)

## Cloud CI (GitHub Actions)

Use Nx affected targets to keep CI fast:

```bash
pnpm ci:lint
pnpm ci:test
pnpm ci:build
```

The default workflow uses `NX_CACHE_MODE=local` and caches:

- `PNPM_STORE_DIR` (`.pnpm-store/`)
- Nx local cache (`.nx/cache`)

## Air-Gapped CI

Air-gapped jobs must avoid network downloads at runtime. This requires:

1. Node.js and pnpm installed on the runner image.
2. A pre-seeded pnpm store archive.

### Seed Dependencies (Connected Environment)

```bash
PNPM_STORE_DIR=.pnpm-store ./tools/offline/seed-deps.sh
```

This creates `artifacts/offline-deps.tgz`. Publish the archive to your internal
artefact store.

### Offline Install (Air-Gapped Runner)

```bash
PNPM_STORE_DIR=.pnpm-store ./tools/offline/restore-deps.sh /path/to/offline-deps.tgz
```

Then run Nx:

```bash
pnpm ci:lint
pnpm ci:test
pnpm ci:build
```

If your runner cannot fetch GitHub Actions from the public marketplace, mirror
required actions internally or convert the workflow steps into local scripts.

See `.github/workflows/air-gapped-ci.yml` for a ready-to-use example.

## Remote Caching

### Modes

- `NX_CACHE_MODE=local` (default): local cache only
- `NX_CACHE_MODE=remote`: enable remote cache (Nx Cloud or self-hosted)

### Self-Hosted Remote Cache (Preferred for Air-Gapped)

Nx supports a self-hosted remote cache server (OpenAPI, Nx >= 20.8). Configure:

```bash
export NX_CACHE_MODE=remote
export NX_REMOTE_CACHE_URL="https://cache.internal.example"
export NX_REMOTE_CACHE_ACCESS_TOKEN="redacted"
```

The wrapper script `tools/nx/run.mjs` maps these to Nx's self-hosted remote cache
environment variables.

### Nx Cloud (Optional)

If you use Nx Cloud, set `NX_CLOUD_ACCESS_TOKEN` in CI. No configuration is
required when `NX_CACHE_MODE=local`.

### Bucket-Based Caches (S3/MinIO/GCS/Azure)

Bucket-based caches are fast but can be vulnerable to cache poisoning if write
access is not tightly controlled (see CVE-2025-36852). If you choose a
bucket-backed cache:

- Use **read-only** credentials for PRs and forks.
- Use **read-write** credentials only on trusted branches (e.g. `main`).
- Scope cache keys by branch and pipeline context.
- Rotate credentials regularly and limit IAM permissions.

Residual risk remains: a compromised trusted pipeline could still poison cache
entries. Consider signing artefacts or tightening review gates for cache writes.

## Dependency Updates

Renovate is configured in `renovate.json`. In restricted environments, run it
only from a trusted, connected environment or disable it by setting
`RENOVATE_DISABLED=true` in the Renovate runtime.
