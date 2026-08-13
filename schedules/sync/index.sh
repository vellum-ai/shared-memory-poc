#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$PLUGIN_DIR/data"
REPO="$DATA/repo"
CONFIG="$PLUGIN_DIR/config.json"

mkdir -p "$DATA"

if [ ! -f "$CONFIG" ]; then
  echo "shared-memory: unconfigured, skipping"
  exit 0
fi

REPO_URL="$(jq -r '.repoUrl // empty' "$CONFIG")"
if [ -z "$REPO_URL" ]; then
  echo "shared-memory: unconfigured, skipping"
  exit 0
fi

BRANCH="$(jq -r '.branch // "main"' "$CONFIG")"

if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --rebase --autostash
else
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO"
fi

HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
LAST_SHA="$(cat "$DATA/last-sha" 2>/dev/null || true)"

if [ "$HEAD_SHA" = "$LAST_SHA" ]; then
  echo "shared-memory: already synced at $HEAD_SHA"
  exit 0
fi

# With no usable watermark this is a first run, so both halves run over the
# whole repo. Otherwise only the halves whose content changed run.
sync_skills=1
sync_pages=1
if [ -n "$LAST_SHA" ] && git -C "$REPO" cat-file -e "$LAST_SHA^{commit}" 2>/dev/null; then
  CHANGED="$(git -C "$REPO" diff --name-only "$LAST_SHA" "$HEAD_SHA")"
  if ! grep -q '^skills/' <<<"$CHANGED"; then
    sync_skills=0
  fi
  if ! grep -q '^concepts/' <<<"$CHANGED"; then
    sync_pages=0
  fi
fi

skills_result="skipped"
pages_result="skipped"

if [ "$sync_skills" = "1" ]; then
  assistant memory v2 reembed-skills
  skills_result="reembedded"
fi

if [ "$sync_pages" = "1" ] && [ -d "$REPO/concepts" ] && [ -n "$(find "$REPO/concepts" -type f)" ]; then
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  # Pages are ingested under the shared/ slug prefix, so the staging directory
  # nests the repo's concepts under a shared/ directory.
  mkdir -p "$STAGE/shared"
  cp -R "$REPO/concepts/." "$STAGE/shared/"
  assistant memory ingest --dir "$STAGE" --overwrite
  pages_result="ingested"
fi

# The watermark advances only once every half that ran has succeeded. A failure
# above exits before this line, so the next tick reprocesses the whole delta.
printf '%s\n' "$HEAD_SHA" > "$DATA/last-sha"
echo "shared-memory: synced $HEAD_SHA (skills $skills_result, pages $pages_result)"
