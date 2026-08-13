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
  # A tick killed by the schedule timeout, or a pull that stopped on a conflict,
  # leaves rebase state behind that every later pull refuses to run over.
  if [ -d "$REPO/.git/rebase-merge" ] || [ -d "$REPO/.git/rebase-apply" ]; then
    git -C "$REPO" rebase --abort || true
  fi

  repo_ok=1
  if ! git -C "$REPO" pull --rebase --autostash; then
    repo_ok=0
  fi

  # A branch change in config lands on a clone that is still on the old branch,
  # which no pull can fix.
  CURRENT_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    repo_ok=0
  fi

  if [ "$repo_ok" = "0" ]; then
    # The clone is shared with the outbound half, so throwing it away is gated on
    # everything in it already being on the remote. Every check has to answer
    # yes, and a check that cannot answer counts as a no.
    safe=0
    if git -C "$REPO" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 &&
      UNPUSHED="$(git -C "$REPO" rev-list '@{upstream}..HEAD')" &&
      DIRTY="$(git -C "$REPO" status --porcelain)" &&
      [ -z "$UNPUSHED" ] && [ -z "$DIRTY" ]; then
      safe=1
    fi

    if [ "$safe" = "0" ]; then
      echo "shared-memory: cannot refresh $REPO, and it holds local work, so it is preserved untouched; resolve it by hand"
      exit 1
    fi

    rm -rf "$REPO"
  fi
fi

if [ ! -d "$REPO/.git" ]; then
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

  # Ingest exits non-zero both when the batch never ran and when it ran and
  # rejected some pages, so the outcome is read from the --json summary rather
  # than from the exit code. A page that can never validate would otherwise pin
  # the watermark and re-ingest the whole tree on every tick, forever.
  INGEST_JSON="$(assistant memory ingest --dir "$STAGE" --overwrite --json || true)"

  if ! jq -e '(.ok != false) and ((.written | type) == "number")' >/dev/null 2>&1 <<<"$INGEST_JSON"; then
    INGEST_ERROR="$(jq -r '.error // empty' <<<"$INGEST_JSON" 2>/dev/null || true)"
    echo "shared-memory: ingest did not complete (${INGEST_ERROR:-no JSON summary}), watermark unchanged"
    exit 1
  fi

  INVALID_SLUGS="$(jq -r '[.results[]? | select(.action == "invalid") | .slug] | join(", ")' <<<"$INGEST_JSON")"
  if [ -n "$INVALID_SLUGS" ]; then
    echo "shared-memory: warning: rejected pages were skipped: $INVALID_SLUGS"
  fi

  pages_result="ingested"
fi

# The watermark advances only once every half that ran has succeeded. A failure
# above exits before this line, so the next tick reprocesses the whole delta.
printf '%s\n' "$HEAD_SHA" > "$DATA/last-sha"
echo "shared-memory: synced $HEAD_SHA (skills $skills_result, pages $pages_result)"
