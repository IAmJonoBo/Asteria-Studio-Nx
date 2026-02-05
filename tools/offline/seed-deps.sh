#!/usr/bin/env bash
# shellcheck disable=SC2250
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCHIVE_PATH="${1:-$ROOT_DIR/artifacts/offline-deps.tgz}"
STORE_DIR="${PNPM_STORE_DIR:-$ROOT_DIR/.pnpm-store}"

if [[ $STORE_DIR != "$ROOT_DIR/"* ]]; then
  echo "PNPM_STORE_DIR must be inside the repo to package it: $STORE_DIR" >&2
  exit 1
fi

mkdir -p "$STORE_DIR" "$(dirname "$ARCHIVE_PATH")"

export PNPM_STORE_DIR="$STORE_DIR"

pnpm install --frozen-lockfile

tar -czf "$ARCHIVE_PATH" -C "$ROOT_DIR" \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  package.json \
  .node-version \
  .pnpm-store

echo "Offline dependency archive created at: $ARCHIVE_PATH"
