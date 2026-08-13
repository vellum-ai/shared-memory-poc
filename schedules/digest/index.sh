#!/usr/bin/env bash
set -euo pipefail

# Report what changed in the shared content repo since the last digest, and by
# whom. Reads the clone that sync maintains and never touches the network or
# git state; the only path it writes is its own watermark.
#
# Three invocations share this file:
#
#   index.sh                 the scheduled tick. In deterministic mode it
#                            formats the summary itself and sends the
#                            notification; in llm mode it stands down, because
#                            the digest-llm schedule owns the notification.
#   index.sh --collect       print the digest facts as one JSON document and
#                            send nothing. The digest-llm prompt reads this.
#   index.sh --advance <sha> move the digest watermark. The digest-llm prompt
#                            calls this after its notification lands.

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$PLUGIN_DIR/data"
REPO="$DATA/repo"
CONFIG="$PLUGIN_DIR/config.json"
WATERMARK="$DATA/digest-last-sha"
SYNC_WATERMARK="$DATA/last-sha"

COMMAND="${1:-tick}"

if [ "$COMMAND" = "--advance" ]; then
  SHA="${2:-}"
  if [ -z "$SHA" ]; then
    echo "shared-memory digest: --advance needs a commit sha" >&2
    exit 2
  fi
  mkdir -p "$DATA"
  printf '%s\n' "$SHA" > "$WATERMARK"
  echo "shared-memory digest: watermark advanced to $SHA"
  exit 0
fi

if [ "$COMMAND" != "tick" ] && [ "$COMMAND" != "--collect" ]; then
  echo "shared-memory digest: unknown argument $COMMAND" >&2
  exit 2
fi

# Every early exit reports one status. A tick prints a plain line the run log
# keeps; --collect prints a JSON document, because a prompt is reading it.
finish() {
  local status="$1"
  local line="$2"
  if [ "$COMMAND" = "--collect" ]; then
    jq -n --arg status "$status" --arg mode "${SUMMARY_MODE:-}" \
      '{status: $status} + (if $mode == "" then {} else {mode: $mode} end)'
  else
    echo "shared-memory digest: $line"
  fi
  exit 0
}

if [ ! -f "$CONFIG" ]; then
  finish unconfigured "unconfigured, skipping"
fi
REPO_URL="$(jq -r '.repoUrl // empty' "$CONFIG")"
if [ -z "$REPO_URL" ]; then
  finish unconfigured "unconfigured, skipping"
fi

SUMMARY_MODE="$(jq -r '.digest.summary // "deterministic"' "$CONFIG")"
if [ "$SUMMARY_MODE" != "deterministic" ] && [ "$SUMMARY_MODE" != "llm" ]; then
  echo "shared-memory digest: unknown digest.summary \"$SUMMARY_MODE\" in config.json, treating it as deterministic" >&2
  SUMMARY_MODE="deterministic"
fi

# Both digest schedules fire on the same cadence, so exactly one of them may
# notify. The mode decides which; the other exits here without looking at git.
if [ "$COMMAND" = "tick" ] && [ "$SUMMARY_MODE" = "llm" ]; then
  echo "shared-memory digest: llm mode is configured, so the digest-llm schedule handles notifications"
  exit 0
fi

# The digest reports the range between its own watermark and sync's. Sync's
# watermark only advances once content has landed in the assistant, so nothing
# is ever announced before it is actually available.
if [ ! -f "$SYNC_WATERMARK" ]; then
  finish no-sync "no completed sync yet, nothing to report"
fi
END="$(cat "$SYNC_WATERMARK")"
if [ ! -d "$REPO/.git" ] || ! git -C "$REPO" cat-file -e "$END^{commit}" 2>/dev/null; then
  finish no-sync "the clone does not hold the synced commit, so the digest waits for sync"
fi

START=""
if [ -f "$WATERMARK" ]; then
  START="$(cat "$WATERMARK")"
fi

# A first run, or a clone that was replaced and no longer holds the old
# watermark. Announcing the whole history would bury the user, so counting
# starts from the current synced commit instead.
if [ -z "$START" ] || ! git -C "$REPO" cat-file -e "$START^{commit}" 2>/dev/null; then
  printf '%s\n' "$END" > "$WATERMARK"
  finish baselined "baselined at $END, changes after this commit will be reported"
fi

if [ "$START" = "$END" ]; then
  finish no-changes "no shared knowledge changes since the last digest"
fi

# One author line per commit, then that commit's file statuses. Merge commits
# are skipped so a change is counted once, under the author who made it. A
# clone swap mid-read makes git fail, which fails the run; the next tick reads
# the settled clone.
RAW="$(git -C "$REPO" log --no-merges -M --format='>%aN' --name-status "$START..$END")"

# One line per (author, entity) the range touched: author, action, kind, name,
# tab-separated. A skill counts as added or removed only when its SKILL.md is;
# any other change to its directory is an update. A rename reports an update of
# the new name. An entity one author both added and removed nets out to nothing.
AGG="$(awk '
  BEGIN { FS = "\t" }
  /^>/ { author = substr($0, 2); next }
  /^$/ { next }
  {
    status = substr($1, 1, 1)
    path = $2
    if (status == "R" || status == "C") path = $3
    if (path ~ /^skills\/[^\/]+\/./) {
      kind = "skill"
      name = path
      sub(/^skills\//, "", name)
      sub(/\/.*$/, "", name)
      if (status == "A" && path == "skills/" name "/SKILL.md") action = "add"
      else if (status == "D" && path == "skills/" name "/SKILL.md") action = "remove"
      else action = "update"
    } else if (path ~ /^concepts\/..*\.md$/) {
      kind = "page"
      name = path
      sub(/^concepts\//, "", name)
      sub(/\.md$/, "", name)
      if (status == "A") action = "add"
      else if (status == "D") action = "remove"
      else action = "update"
    } else next
    flags[author FS kind FS name] = flags[author FS kind FS name] action ";"
  }
  END {
    for (k in flags) {
      f = flags[k]
      has_add = index(f, "add;") > 0
      has_remove = index(f, "remove;") > 0
      if (has_add && has_remove) continue
      if (has_add) action = "add"
      else if (has_remove) action = "remove"
      else action = "update"
      split(k, part, FS)
      print part[1] FS action FS part[2] FS part[3]
    }
  }
' <<<"$RAW" | sort)"

# Commits in range that touch neither skills nor pages are nothing to announce.
# The tick advances the watermark so the range stays short; --collect leaves it,
# because --collect mutates nothing past the baseline above, and a stale start
# only ever adds silent commits to a later range.
if [ -z "$AGG" ]; then
  if [ "$COMMAND" = "tick" ]; then
    printf '%s\n' "$END" > "$WATERMARK"
  fi
  finish no-changes "commits since the last digest touch no skills or pages"
fi

DEDUPE_KEY="shared-memory-digest:$START:$END"

if [ "$COMMAND" = "--collect" ]; then
  AUTHORS_JSON="$(jq -R -s '
    split("\n") | map(select(length > 0) | split("\t")) | group_by(.[0]) |
    map({
      author: .[0][0],
      skills: {
        added:   map(select(.[1] == "add" and .[2] == "skill") | .[3]),
        updated: map(select(.[1] == "update" and .[2] == "skill") | .[3]),
        removed: map(select(.[1] == "remove" and .[2] == "skill") | .[3])
      },
      pages: {
        added:   map(select(.[1] == "add" and .[2] == "page") | .[3]),
        updated: map(select(.[1] == "update" and .[2] == "page") | .[3]),
        removed: map(select(.[1] == "remove" and .[2] == "page") | .[3])
      }
    })' <<<"$AGG")"
  COMMITS_JSON="$(git -C "$REPO" log --no-merges --format='%aN%x1f%s' "$START..$END" \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\u001f") | {author: .[0], subject: .[1]})')"
  jq -n \
    --arg mode "$SUMMARY_MODE" \
    --arg start "$START" \
    --arg end "$END" \
    --arg dedupeKey "$DEDUPE_KEY" \
    --argjson authors "$AUTHORS_JSON" \
    --argjson commits "$COMMITS_JSON" \
    '{status: "changes", mode: $mode, range: {start: $start, end: $end},
      dedupeKey: $dedupeKey, authors: $authors, commits: $commits}'
  exit 0
fi

START7="$(printf '%.7s' "$START")"
END7="$(printf '%.7s' "$END")"

# The notification body, in the markdown the home feed renders: a bold headline
# count, then one bullet per author.
MESSAGE="$(awk -v start7="$START7" -v end7="$END7" '
  BEGIN { FS = "\t" }
  {
    if (!($1 in seen)) { seen[$1] = 1; order[++n] = $1 }
    key = $1 FS $2 FS $3
    if (list[key] != "") list[key] = list[key] ", "
    list[key] = list[key] "`" $4 "`"
    count[key]++
    total++
  }
  function group(a, action, kind, label,   key) {
    key = a FS action FS kind
    if (!(key in list)) return ""
    return label " " (count[key] == 1 ? kind : kind "s") " " list[key]
  }
  END {
    printf "**%d update%s** to the shared knowledge repo by %d author%s (%s..%s).\n\n", \
      total, (total == 1 ? "" : "s"), n, (n == 1 ? "" : "s"), start7, end7
    for (i = 1; i <= n; i++) {
      a = order[i]
      m = 0
      parts[++m] = group(a, "add", "skill", "added")
      parts[++m] = group(a, "add", "page", "added")
      parts[++m] = group(a, "update", "skill", "updated")
      parts[++m] = group(a, "update", "page", "updated")
      parts[++m] = group(a, "remove", "skill", "removed")
      parts[++m] = group(a, "remove", "page", "removed")
      line = ""
      for (j = 1; j <= m; j++) {
        if (parts[j] == "") continue
        if (line != "") line = line "; "
        line = line parts[j]
      }
      printf "- **%s**: %s\n", a, line
    }
  }
' <<<"$AGG")"

# The dedupe key covers the exact range, so a run that sent but was killed
# before the watermark write below cannot notify the user twice: the retry
# sends the same key and the router drops it.
if ! SEND_JSON="$(assistant notifications send \
  --source-channel scheduler \
  --source-event-name schedule.notify \
  --title "Shared knowledge updates" \
  --message "$MESSAGE" \
  --dedupe-key "$DEDUPE_KEY" \
  --json)"; then
  echo "shared-memory digest: the notification send failed, watermark unchanged so the next tick retries"
  exit 1
fi
if ! jq -e '.ok == true' >/dev/null 2>&1 <<<"$SEND_JSON"; then
  echo "shared-memory digest: the notification send reported failure, watermark unchanged so the next tick retries"
  exit 1
fi

UPDATES="$(grep -c . <<<"$AGG")"
printf '%s\n' "$END" > "$WATERMARK"
echo "shared-memory digest: notified $UPDATES update(s) ($START7..$END7)"
