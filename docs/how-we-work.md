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
