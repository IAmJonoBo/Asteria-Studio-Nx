# Dead-Code Quarantine Policy

Asteria Studio treats dead code as a release risk. We use Knip to detect unused files/exports and enforce removal via CI.

## Default rule

- If Knip flags code as unused, remove it in the same PR.
- Do not silence the warning without a plan and a tracking owner.

## Quarantine (exception path)

Use quarantine only when deletion would break an active release or an in-flight migration.

**Required steps:**

1. Move the code behind a clear, disabled-by-default path (feature flag or build exclusion).
2. Add a tracking issue with a target removal date.
3. Add an entry to the **Quarantine Register** below.
4. Update Knip configuration only if the quarantined code is intentionally kept and documented.

## Quarantine Register

Add one entry per exception. Entries must be removed within the target removal date.

| Item                           | Location                                         | Reason                             | Tracking Issue | Target Removal | Owner  |
| ------------------------------ | ------------------------------------------------ | ---------------------------------- | -------------- | -------------- | ------ |
| _Example: Deprecated exporter_ | apps/asteria-desktop/src/main/exporter-legacy.ts | Needed for rollback during release | GH-1234        | 2026-03-15     | @owner |

## Review cadence

- Review the register during preflight.
- Reject new releases if the register has expired entries.
