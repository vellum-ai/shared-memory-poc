#!/usr/bin/env bash
set -euo pipefail

# Git invokes credential helpers with a small key/value protocol on stdin. The
# token is fetched for this operation only and is never written to disk.
OPERATION="${1:-get}"
if [ "$OPERATION" != "get" ]; then
  exit 0
fi

PROTOCOL=""
HOST=""
PATH_VALUE=""
while IFS='=' read -r KEY VALUE; do
  case "$KEY" in
    protocol) PROTOCOL="$VALUE" ;;
    host) HOST="$VALUE" ;;
    path) PATH_VALUE="$VALUE" ;;
  esac
done

if [ "$PROTOCOL" != "https" ] || [ "$HOST" != "github.com" ]; then
  exit 0
fi

REPO_PATH="${PATH_VALUE%.git}"
if [[ ! "$REPO_PATH" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  exit 0
fi

ASSISTANT_BIN="${SHARED_MEMORY_ASSISTANT_BIN:-assistant}"
JQ_BIN="${SHARED_MEMORY_JQ_BIN:-jq}"
if ! command -v "$ASSISTANT_BIN" >/dev/null 2>&1 || ! command -v "$JQ_BIN" >/dev/null 2>&1; then
  exit 0
fi

RESPONSE="$("$ASSISTANT_BIN" oauth request --silent --json --provider github "/repos/${REPO_PATH}")"
TOKEN="$(printf '%s' "$RESPONSE" | "$JQ_BIN" -r '.body.temp_clone_token // empty')"
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  exit 0
fi

printf 'username=x-access-token\npassword=%s\n\n' "$TOKEN"
