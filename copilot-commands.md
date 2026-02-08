# Copilot Commands

## Setup

- pnpm install
- pnpm hooks:setup

## Nx (preferred)

- pnpm nx run-many -t lint,test,build
- pnpm nx run asteria-desktop:<target>
- pnpm nx run @asteria/ui-kit:<target>

## App workflows

- pnpm -C apps/asteria-desktop dev
- pnpm -C apps/asteria-desktop build
- pnpm -C apps/asteria-desktop test
- pnpm -C apps/asteria-desktop test:e2e
- pnpm -C apps/asteria-desktop typecheck
- pnpm -C apps/asteria-desktop pipeline:run [projectRoot] [sampleCount]
- pnpm -C apps/asteria-desktop pipeline:export [projectRoot] [count]
