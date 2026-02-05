# How We Work

## Values

- Build offline-first, deterministic workflows.
- Optimise for clarity, reproducibility, and testing rigour.
- Prefer small changes that are easy to review.

## Decision-Making

- Significant changes require an ADR in `docs/adr/`.
- Favour explicit trade-offs and non-obvious risks.

## Delivery

- Keep PRs scoped to a single theme.
- Update documentation with behaviour changes.
- Avoid breaking `main`; use feature flags where appropriate.

## Quality Bar

- Lint, test, and build must pass before merge.
- CI should use Nx affected targets for faster feedback.
- Desktop gates workflow is authoritative for branch protection.
- Air-gapped CI mirrors the same invariants; E2E is explicitly skipped offline and documented in the workflow logs.
- Dead code is removed immediately; quarantine requires a tracked exception entry in [docs/dead_code_quarantine.md](docs/dead_code_quarantine.md).
