#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$ROOT_DIR/release_review"
SRC_DIR="$OUT_DIR/01-src"
FIX_DIR="$OUT_DIR/02-fixtures"
REPRO_DIR="$OUT_DIR/03-repro"
MAX_ZIP_BYTES=$((150 * 1024 * 1024))
LARGE_FILE_BYTES=$((10 * 1024 * 1024))

REPRO_CORPUS=""
REPRO_RUN=""
REPRO_EXPORT=""
REPRO_LOGS=""
FIX_CORPUS=""
FIX_RUN=""
FIX_EXPORT=""
FIX_LOGS=""

print_usage() {
  cat <<'EOF'
Usage: ./create-release-zips.sh [options]

Options:
  --fixtures-corpus <path>  Path to minimal failing corpus (3–15 pages)
  --fixtures-run <path>     Path to run directory for that corpus
  --fixtures-export <path>  Path to export bundle produced by the app
  --fixtures-logs <path>    Path to logs directory or files
  --repro-corpus <path>   Path to minimal failing corpus (3–15 pages)
  --repro-run <path>      Path to run directory for that corpus
  --repro-export <path>   Path to export bundle produced by the app
  --repro-logs <path>     Path to logs directory or files
  --help                  Show this help

Examples:
  ./create-release-zips.sh
  ./create-release-zips.sh --fixtures-corpus ./tmp/min-corpus \
    --fixtures-run ./pipeline-results/runs/run-123 \
    --fixtures-export ./exports/run-123 \
    --fixtures-logs ./apps/asteria-desktop/logs
  ./create-release-zips.sh --repro-corpus ./tmp/min-corpus \
    --repro-run ./pipeline-results/runs/run-123 \
    --repro-export ./exports/run-123 \
    --repro-logs ./apps/asteria-desktop/logs
EOF
}

get_file_size_bytes() {
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

check_zip_size() {
  local zip_path="$1"
  local size_bytes
  size_bytes=$(get_file_size_bytes "$zip_path")
  if (( size_bytes > MAX_ZIP_BYTES )); then
    echo "ERROR: $zip_path exceeds 150MB (size=$size_bytes bytes)." >&2
    echo "Hint: move large binaries (fonts/scans/test artefacts) to fixtures or repro ZIPs." >&2
    exit 1
  fi
}

write_large_files_report() {
  local report_path="$OUT_DIR/large-files.md"
  mkdir -p "$OUT_DIR"
  {
    echo "# Large Files Report"
    echo
    echo "Files larger than $((LARGE_FILE_BYTES / 1024 / 1024))MB (review and move to fixtures/repro if needed):"
    echo
    echo "| Size (MB) | Path |"
    echo "| --- | --- |"
    find "$ROOT_DIR" -type f -size "+${LARGE_FILE_BYTES}c" \
      -not -path "$ROOT_DIR/node_modules/*" \
      -not -path "$ROOT_DIR/.git/*" \
      -not -path "$ROOT_DIR/pipeline-results/*" \
      -not -path "$ROOT_DIR/artifacts/*" \
      -not -path "$ROOT_DIR/.venv/*" \
      -not -path "$ROOT_DIR/release_review/*" \
      -print0 \
      | while IFS= read -r -d '' file; do
          local size_bytes
          size_bytes=$(get_file_size_bytes "$file")
          printf "| %.1f | %s |\n" "$(awk "BEGIN {print $size_bytes/1024/1024}")" "${file#$ROOT_DIR/}"
        done \
      | sort -nr
  } > "$report_path"
}

build_file_list() {
  local list_path="$1"
  shift
  : > "$list_path"
  find "$@" -type f -size "-${LARGE_FILE_BYTES}c" -print0 \
    | while IFS= read -r -d '' file; do
        printf "%s\n" "${file#$ROOT_DIR/}" >> "$list_path"
      done
}

build_allowlist_paths() {
  local -a paths=()
  shopt -s nullglob

  for d in "$ROOT_DIR"/apps/*/src "$ROOT_DIR"/apps/*/scripts "$ROOT_DIR"/apps/*/resources; do
    [[ -e "$d" ]] && paths+=("$d")
  done
  for f in "$ROOT_DIR"/apps/*/package.json "$ROOT_DIR"/apps/*/project.json "$ROOT_DIR"/apps/*/tsconfig*.json; do
    [[ -e "$f" ]] && paths+=("$f")
  done
  for f in "$ROOT_DIR"/apps/*/*config.* "$ROOT_DIR"/apps/*/README.md; do
    [[ -e "$f" ]] && paths+=("$f")
  done

  for d in "$ROOT_DIR"/packages/*/src; do
    [[ -e "$d" ]] && paths+=("$d")
  done
  for f in "$ROOT_DIR"/packages/*/package.json "$ROOT_DIR"/packages/*/project.json "$ROOT_DIR"/packages/*/tsconfig*.json "$ROOT_DIR"/packages/*/Cargo.toml; do
    [[ -e "$f" ]] && paths+=("$f")
  done

  paths+=("$ROOT_DIR/tools" "$ROOT_DIR/docs" "$ROOT_DIR/spec" "$ROOT_DIR/.github")
  for f in "$ROOT_DIR"/package.json "$ROOT_DIR"/pnpm-lock.yaml "$ROOT_DIR"/pnpm-workspace.yaml "$ROOT_DIR"/nx.json; do
    [[ -e "$f" ]] && paths+=("$f")
  done
  for f in "$ROOT_DIR"/tsconfig*.json "$ROOT_DIR"/eslint.config.js "$ROOT_DIR"/.eslintrc.json "$ROOT_DIR"/.prettierrc.json; do
    [[ -e "$f" ]] && paths+=("$f")
  done
  for f in "$ROOT_DIR"/README.md "$ROOT_DIR"/CODE_OF_CONDUCT.md "$ROOT_DIR"/CONTRIBUTING.md "$ROOT_DIR"/LICENSE "$ROOT_DIR"/SECURITY.md "$ROOT_DIR"/SUPPORT.md "$ROOT_DIR"/PREFLIGHT_TASK_SPEC.md "$ROOT_DIR"/PRELAUNCH_CHECKLIST.md "$ROOT_DIR"/REPRO.md; do
    [[ -e "$f" ]] && paths+=("$f")
  done

  shopt -u nullglob
  printf "%s\n" "${paths[@]}"
}

fail_if_large_in_list() {
  local list_path="$1"
  local violations
  violations=$(while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    local abs="$ROOT_DIR/$rel"
    [[ -f "$abs" ]] || continue
    local size_bytes
    size_bytes=$(get_file_size_bytes "$abs")
    if (( size_bytes > LARGE_FILE_BYTES )); then
      printf "%s\t%d\n" "$rel" "$size_bytes"
    fi
  done < "$list_path")

  if [[ -n "$violations" ]]; then
    echo "ERROR: Large files found in 01-src (>${LARGE_FILE_BYTES} bytes):" >&2
    echo "$violations" | while IFS=$'\t' read -r rel size; do
      echo "- $rel ($size bytes)" >&2
    done
    echo "Move these to fixtures/repro or reduce size before packaging." >&2
    exit 1
  fi
}

write_top20_report() {
  local list_path="$1"
  local report_path="$OUT_DIR/src-top20.md"
  {
    echo "# Top 20 Largest Files in 01-src"
    echo
    echo "| Size (MB) | Path |"
    echo "| --- | --- |"
    while IFS= read -r rel; do
      [[ -z "$rel" ]] && continue
      local abs="$ROOT_DIR/$rel"
      [[ -f "$abs" ]] || continue
      local size_bytes
      size_bytes=$(get_file_size_bytes "$abs")
      printf "%.1f\t%s\n" "$(awk "BEGIN {print $size_bytes/1024/1024}")" "$rel"
    done < "$list_path" \
      | sort -nr \
      | head -20 \
      | while IFS=$'\t' read -r size rel; do
          printf "| %s | %s |\n" "$size" "$rel"
        done
  } > "$report_path"
}

print_zip_size() {
  local zip_path="$1"
  local size_bytes
  size_bytes=$(get_file_size_bytes "$zip_path")
  echo "- $zip_path (${size_bytes} bytes)"
}

zip_from_list() {
  local zip_path="$1"
  local list_path="$2"
  (cd "$ROOT_DIR" && zip -r "$zip_path" -@ < "$list_path")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixtures-corpus)
      FIX_CORPUS="$2"; shift 2 ;;
    --fixtures-run)
      FIX_RUN="$2"; shift 2 ;;
    --fixtures-export)
      FIX_EXPORT="$2"; shift 2 ;;
    --fixtures-logs)
      FIX_LOGS="$2"; shift 2 ;;
    --repro-corpus)
      REPRO_CORPUS="$2"; shift 2 ;;
    --repro-run)
      REPRO_RUN="$2"; shift 2 ;;
    --repro-export)
      REPRO_EXPORT="$2"; shift 2 ;;
    --repro-logs)
      REPRO_LOGS="$2"; shift 2 ;;
    --help)
      print_usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

mkdir -p "$SRC_DIR" "$FIX_DIR"
write_large_files_report

SRC_ZIP="$SRC_DIR/asteria-src.zip"
FIX_ZIP="$FIX_DIR/asteria-fixtures.zip"
REPRO_ZIP="$REPRO_DIR/asteria-repro-bundle.zip"

rm -f "$SRC_ZIP" "$FIX_ZIP" "$REPRO_ZIP"

cd "$ROOT_DIR"

SRC_LIST="$OUT_DIR/src-files.txt"
mapfile -t SRC_PATHS < <(build_allowlist_paths)
build_file_list "$SRC_LIST" "${SRC_PATHS[@]}"

grep -v -E "(^|/)node_modules/|(^|/)\.git/|(^|/)dist/|(^|/)out/|(^|/)\.next/|(^|/)build/|(^|/)coverage/|(^|/)pipeline-results/|(^|/)runs/|(^|/)exports/|(^|/)logs/|(^|/)artifacts/|(^|/)\.venv/|(^|/)\.mypy_cache/|(^|/)\.pytest_cache/|(^|/)__pycache__/|(^|/)tests/fixtures/golden_corpus/|(^|/)dist-app/|(^|/)playwright-report/|(^|/)test-results/|(^|/)\.cache/|(^|/)packages/pipeline-core/target/|(^|/)apps/asteria-desktop/benchmark-results/|(^|/)apps/asteria-desktop/\.vite/|\.DS_Store$|Thumbs\.db$" \
  "$SRC_LIST" > "$SRC_LIST.tmp" && mv "$SRC_LIST.tmp" "$SRC_LIST"

fail_if_large_in_list "$SRC_LIST"
write_top20_report "$SRC_LIST"

zip_from_list "$SRC_ZIP" "$SRC_LIST"

  check_zip_size "$SRC_ZIP"

FIX_LIST="$OUT_DIR/fixtures-files.txt"
build_file_list "$FIX_LIST" \
  "$ROOT_DIR/tests/fixtures/golden_corpus/v1" \
  "$ROOT_DIR/tools/golden_corpus"

grep -v -E "\.DS_Store$|Thumbs\.db$" "$FIX_LIST" > "$FIX_LIST.tmp" && mv "$FIX_LIST.tmp" "$FIX_LIST"

zip_from_list "$FIX_ZIP" "$FIX_LIST"

  check_zip_size "$FIX_ZIP"

if [[ -n "$FIX_CORPUS" || -n "$FIX_RUN" || -n "$FIX_EXPORT" || -n "$FIX_LOGS" ]]; then
  FIX_ITEMS=()
  [[ -n "$FIX_CORPUS" ]] && FIX_ITEMS+=("$FIX_CORPUS")
  [[ -n "$FIX_RUN" ]] && FIX_ITEMS+=("$FIX_RUN")
  [[ -n "$FIX_EXPORT" ]] && FIX_ITEMS+=("$FIX_EXPORT")
  [[ -n "$FIX_LOGS" ]] && FIX_ITEMS+=("$FIX_LOGS")

  zip -r "$FIX_ZIP" "${FIX_ITEMS[@]}" \
    -x "**/.DS_Store" \
       "**/Thumbs.db"
fi

if [[ -n "$REPRO_CORPUS" || -n "$REPRO_RUN" || -n "$REPRO_EXPORT" || -n "$REPRO_LOGS" ]]; then
  mkdir -p "$REPRO_DIR"

  REPRO_ITEMS=()
  [[ -n "$REPRO_CORPUS" ]] && REPRO_ITEMS+=("$REPRO_CORPUS")
  [[ -n "$REPRO_RUN" ]] && REPRO_ITEMS+=("$REPRO_RUN")
  [[ -n "$REPRO_EXPORT" ]] && REPRO_ITEMS+=("$REPRO_EXPORT")
  [[ -n "$REPRO_LOGS" ]] && REPRO_ITEMS+=("$REPRO_LOGS")

  REPRO_LIST="$OUT_DIR/repro-files.txt"
  build_file_list "$REPRO_LIST" "${REPRO_ITEMS[@]}"
  grep -v -E "\.DS_Store$|Thumbs\.db$" "$REPRO_LIST" > "$REPRO_LIST.tmp" && mv "$REPRO_LIST.tmp" "$REPRO_LIST"

  zip_from_list "$REPRO_ZIP" "$REPRO_LIST"

  check_zip_size "$REPRO_ZIP"
fi

cat > "$OUT_DIR/README.md" <<'EOF'
# Release Review Bundles

- 01-src/asteria-src.zip — source, configs, tests, schemas, and docs
- 02-fixtures/asteria-fixtures.zip — deterministic fixtures + golden corpus
- 03-repro/asteria-repro-bundle.zip — optional repro bundle (only when provided)

Run:
  ./create-release-zips.sh

Optional repro:
  ./create-release-zips.sh --repro-corpus <path> --repro-run <path> \
    --repro-export <path> --repro-logs <path>

Optional failing corpus in fixtures:
  ./create-release-zips.sh --fixtures-corpus <path> --fixtures-run <path> \
    --fixtures-export <path> --fixtures-logs <path>
EOF

echo "Created:"
print_zip_size "$SRC_ZIP"
print_zip_size "$FIX_ZIP"
if [[ -f "$REPRO_ZIP" ]]; then
  print_zip_size "$REPRO_ZIP"
fi
