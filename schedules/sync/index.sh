#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$PLUGIN_DIR/data"
REPO="$DATA/repo"
CONFIG="$PLUGIN_DIR/config.json"
LOCK="$DATA/sync.lock"

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

# The staging directory the pages are ingested from, the replacement clone and
# the lock, none of which may outlive the run.
STAGE=""
REPO_NEW=""
LOCK_HELD=0
cleanup() {
  if [ -n "$STAGE" ]; then
    rm -rf "$STAGE"
  fi
  if [ -n "$REPO_NEW" ]; then
    rm -rf "$REPO_NEW"
  fi
  if [ "$LOCK_HELD" = "1" ]; then
    rm -rf "$LOCK"
  fi
}
trap cleanup EXIT

mkdir -p "$DATA"

# Two syncs can be in flight at once: the schedule fires on its own cadence and
# a manual run executes inline without checking for one already going. mkdir is
# the atomic primitive every filesystem has, so the lock is a directory.
if ! mkdir "$LOCK" 2>/dev/null; then
  # The schedule timeout kills the run outright, so the trap above does not run
  # and the lock stays behind. That timeout can be set no higher than 30
  # minutes, so a lock older than 35 belongs to a run that is gone.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +35 2>/dev/null)" ]; then
    rm -rf "$LOCK"
  fi
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "shared-memory: another sync appears to be running, skipping this tick"
    exit 0
  fi
fi
LOCK_HELD=1

# A killed run leaves its replacement clone, or the clone it was replacing, on
# disk. Both are inert copies, and the lock above means no other run is using
# them.
for leftover in "$DATA"/repo.new.* "$DATA"/repo.old.*; do
  if [ -e "$leftover" ]; then
    rm -rf "$leftover"
    echo "shared-memory: removed $leftover, left behind by an interrupted run"
  fi
done

if [ -d "$REPO/.git" ]; then
  # A tick killed by the schedule timeout leaves the index lock behind, and
  # every later git write fails on it, including the rebase abort below. No real
  # git operation holds the lock for half an hour, and the sync lock keeps a
  # second sync off the clone, so a lock that old belongs to a process that is
  # gone.
  if [ -n "$(find "$REPO/.git" -maxdepth 1 -name index.lock -mmin +30 2>/dev/null)" ]; then
    rm -f "$REPO/.git/index.lock"
  fi

  # A tick killed by the schedule timeout, or a pull that stopped on a conflict,
  # leaves rebase state behind that every later pull refuses to run over.
  if [ -d "$REPO/.git/rebase-merge" ] || [ -d "$REPO/.git/rebase-apply" ]; then
    git -C "$REPO" rebase --abort || true
  fi

  repo_ok=1
  if ! git -C "$REPO" pull --quiet --rebase --autostash; then
    repo_ok=0
    # A lock too young to clear may belong to a git process that is still
    # running, most likely the outbound half part way through a write.
    # Replacing the clone would destroy that work, so the run stops here
    # instead of reaching the replacement below.
    if [ -e "$REPO/.git/index.lock" ]; then
      echo "shared-memory: $REPO/.git/index.lock is too new to clear, so a git process may still be writing to the clone; it is left alone and the next tick tries again"
      exit 1
    fi
  fi

  # A branch change in config lands on a clone that is still on the old branch,
  # which no pull can fix.
  CURRENT_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    repo_ok=0
  fi

  # A repoUrl change in config likewise: the clone keeps pulling its old
  # origin, and only replacement moves it to the new one.
  ORIGIN_URL="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
  if [ "$ORIGIN_URL" != "$REPO_URL" ]; then
    repo_ok=0
  fi

  if [ "$repo_ok" = "0" ]; then
    # The clone is shared with the outbound half, so throwing it away is gated
    # on local work being absent. Local work is a commit no remote has, a stash
    # entry, or anything in the tree. Every check has to answer yes, and a check
    # that cannot answer counts as a no.
    work_free=0
    if LOCAL_ONLY="$(git -C "$REPO" log --branches --not --remotes --format=%H)" &&
      STASHED="$(git -C "$REPO" stash list)" &&
      DIRTY="$(git -C "$REPO" status --porcelain)" &&
      [ -z "$LOCAL_ONLY" ] && [ -z "$STASHED" ] && [ -z "$DIRTY" ]; then
      work_free=1
    fi

    # The checked out branch tracks an upstream and is not ahead of it.
    safe=0
    if [ "$work_free" = "1" ] &&
      git -C "$REPO" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 &&
      UNPUSHED="$(git -C "$REPO" rev-list '@{upstream}..HEAD')" &&
      [ -z "$UNPUSHED" ]; then
      safe=1
    fi

    # A clone the timeout killed part way through has no commit at HEAD, so it
    # has no upstream to compare against and can hold no unpushed commit. The
    # other checks still apply: another branch, the stash and the tree can all
    # hold work.
    if [ "$safe" = "0" ] && [ "$work_free" = "1" ] &&
      ! git -C "$REPO" rev-parse --verify 'HEAD^{commit}' >/dev/null 2>&1; then
      safe=1
    fi

    if [ "$safe" = "0" ]; then
      echo "shared-memory: cannot refresh $REPO, so it is preserved untouched; it may hold local work or be in a state sync cannot judge, so inspect it with git status and resolve by hand"
      exit 1
    fi

    # The clone is the only copy of the shared skills on disk, so it is replaced
    # rather than deleted: a clone that fails here leaves the old one serving
    # them until a later tick succeeds.
    REPO_NEW="$DATA/repo.new.$$"
    if ! git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO_NEW"; then
      echo "shared-memory: cannot refresh $REPO and the replacement clone failed too, so the old one is kept for now"
      exit 1
    fi

    # Two renames inside data/, which are atomic, so the path at data/repo holds
    # either the old clone or the new one and never a directory being emptied.
    REPO_OLD="$DATA/repo.old.$$"
    mv "$REPO" "$REPO_OLD"
    mv "$REPO_NEW" "$REPO"
    REPO_NEW=""
    rm -rf "$REPO_OLD"
  fi
fi

if [ ! -d "$REPO/.git" ]; then
  # A run killed during the swap above, or during its own first clone, can leave
  # a directory here with no .git in it at all, and git clone refuses a
  # destination that holds files. Renaming it away empties the path in one step.
  if [ -e "$REPO" ] && [ ! -e "$REPO/.git" ]; then
    mv "$REPO" "$DATA/repo.old.$$"
    rm -rf "$DATA/repo.old.$$"
  fi
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO"
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
  # Pages are ingested under the shared/ slug prefix, so the staging directory
  # nests the repo's concepts under a shared/ directory.
  mkdir -p "$STAGE/shared"
  cp -R "$REPO/concepts/." "$STAGE/shared/"

  # Ingest exits non-zero both when the batch never ran and when it ran and
  # rejected some pages, so the outcome is read from the --json summary rather
  # than from the exit code. A page that can never validate would otherwise pin
  # the watermark and re-ingest the whole tree on every tick, forever.
  INGEST_JSON="$(assistant memory ingest --dir "$STAGE" --overwrite --json || true)"

  if [ -z "$INGEST_JSON" ] || ! jq -e '(.ok != false) and ((.written | type) == "number")' >/dev/null 2>&1 <<<"$INGEST_JSON"; then
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
