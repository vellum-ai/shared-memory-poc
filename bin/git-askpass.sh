#!/usr/bin/env bash
#
# Credential helper for git over HTTPS, pointed at by GIT_ASKPASS.
#
# git runs this once per prompt with the prompt text as $1 and reads the answer
# from stdout. That keeps the token out of the remote URL and out of every
# process argument list, which is where it would land if the URL carried it.
#
# The token is read back from the assistant's encrypted vault, where the setup
# flow stored it as github/shared-memory. Nothing here writes it anywhere.
#
# The JSON form is deliberate: the human form of `credentials reveal` prints a
# bare value on success but a diagnostic on failure, and git cannot tell the two
# apart — a daemon that is down would otherwise be handed to GitHub as if it
# were a password. Parsing the envelope means a failure produces empty output,
# and git reports an authentication failure rather than a confusing one.

set -euo pipefail

CREDENTIAL_SERVICE="github"
CREDENTIAL_FIELD="shared-memory"

case "${1-}" in
  Username*|username*)
    # GitHub ignores the username when the password is a token, but git still
    # asks for one, and a prompt left unanswered fails the whole exchange.
    printf 'x-access-token\n'
    ;;
  Password*|password*)
    assistant credentials reveal \
      --service "$CREDENTIAL_SERVICE" \
      --field "$CREDENTIAL_FIELD" \
      --json 2>/dev/null \
      | jq -r 'if .ok == true and (.value | type) == "string" then .value else empty end'
    ;;
  *)
    # An unrecognized prompt gets no answer rather than a guess: answering the
    # wrong prompt with a token would leak it into whatever asked.
    exit 1
    ;;
esac
