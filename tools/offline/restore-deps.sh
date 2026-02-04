#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCHIVE_PATH="${1:-$ROOT_DIR/artifacts/offline-deps.tgz}"
STORE_DIR="${PNPM_STORE_DIR:-$ROOT_DIR/.pnpm-store}"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Offline dependency archive not found: $ARCHIVE_PATH" >&2
  echo "Run tools/offline/seed-deps.sh in a connected environment first." >&2
  exit 1
fi

mkdir -p "$STORE_DIR"
export PNPM_STORE_DIR="$STORE_DIR"

tar -xzf "$ARCHIVE_PATH" -C "$ROOT_DIR"

pnpm install --frozen-lockfile --offline

echo "Offline install complete using store: $STORE_DIR"
