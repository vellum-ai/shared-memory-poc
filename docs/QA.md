# QA runbook

A manual end-to-end pass over the shared-memory plugin. Start from a test
assistant with the plugin not installed, and finish with a skill and a memory
page from a content repo live in that assistant. Every step has a command to run
and something concrete to look at.

Use a test assistant. The sync overwrites memory pages under the `shared/` slug
prefix, so do not point this at an assistant you care about.

## Before you start

**A running assistant.** Check it is up:

```bash
vellum ps
```

**The `plugin-schedules` feature flag on.** It is assistant-scoped and off by
default. It gates the schedule this plugin declares.

```bash
vellum flags set plugin-schedules true
vellum flags get plugin-schedules
```

If you cannot turn the flag on, the runbook still works. Step 7 has a fallback
that runs the sync script by hand.

**`jq` and `git` on your PATH.** The sync script calls `jq` to read
`config.json` and `git` to pull the content repo.

**Concept-page memory active.** Ingest and the skill reseed both need it. It is
on by default.

```bash
assistant config get memory.enabled
assistant config get memory.v2.enabled
assistant config get memory.v3.live
```

If the gate is off, steps 7 and 9 fail. For what the three keys mean, why a
stock assistant prints `(not set)` for all of them and is fine, and which
settings turn the gate off, see
[Concept-page memory](../README.md#concept-page-memory) in the README.

## Step 1 — Find the workspace

Every path below hangs off the workspace directory. `assistant status` prints it
with the home directory abbreviated to `~`, so expand it before using it.

```bash
WS=$(assistant status --json | jq -r .workspace)
WS="${WS/#\~/$HOME}"
echo "$WS"
```

## Step 2 — Build a fixture content repo

A local repo on disk is enough. The plugin clones over `file://` the same way it
clones over SSH.

```bash
FIXTURE=/tmp/shared-content-fixture
rm -rf "$FIXTURE"
mkdir -p "$FIXTURE/skills/demo" "$FIXTURE/concepts"
```

One skill. The frontmatter needs `name` and `description`; a skill missing
either is skipped by the catalog.

```bash
cat > "$FIXTURE/skills/demo/SKILL.md" <<'EOF'
---
name: demo
description: Fixture skill from the shared content repo. Use it when someone asks for the shared-memory demo handshake.
---

When someone asks for the shared-memory demo handshake, reply with exactly:

`shared-memory fixture v1`
EOF
```

One concept page.

```bash
cat > "$FIXTURE/concepts/deploy-runbook.md" <<'EOF'
---
source: import:shared-repo
title: Deploy runbook
summary: How the team ships a release.
tags: [ops]
---

Releases go out on Tuesdays. The release captain cuts the tag, waits for the
staging bake to finish, then dispatches the production run.
EOF
```

Commit it on `main`, which is the branch the plugin defaults to.

```bash
git -C "$FIXTURE" init -q -b main
git -C "$FIXTURE" add -A
git -C "$FIXTURE" -c user.email=qa@example.com -c user.name=QA \
  commit -qm "Seed the fixture content repo"
git -C "$FIXTURE" log --oneline
```

## Step 3 — Stop the daemon

Install with the daemon down.

```bash
vellum sleep --wait 60s
```

`--wait` lets in-flight background work drain first, so you do not stop the
daemon mid-job. Without a duration it waits as long as it takes.

Installing into a live workspace can get the plugin directory recorded in the
workspace's own git history. Stopping first closes that window, and step 12
checks that it stayed closed. See
[Why the daemon goes down first](../README.md#why-the-daemon-goes-down-first) in
the README.

## Step 4 — Install the plugin and start the daemon

Clone this repo into the workspace's plugins directory. The directory name is
what the assistant uses as the plugin name, so it has to be `shared-memory`.

```bash
git clone <this-repo-url> "$WS/plugins/shared-memory"
```

Write `config.json` pointing at the fixture.

```bash
jq --arg url "file://$FIXTURE" '.repoUrl = $url | .branch = "main"' \
  "$WS/plugins/shared-memory/config.example.json" \
  > "$WS/plugins/shared-memory/config.json"

cat "$WS/plugins/shared-memory/config.json"
```

Expect:

```json
{
  "repoUrl": "file:///tmp/shared-content-fixture",
  "branch": "main"
}
```

Now start the daemon. The init hook runs once per boot, and the schedule
reconciler picks up new plugins on startup, so both land on this boot.

```bash
vellum wake
vellum ps
```

## Step 5 — Verify the plugin loaded

```bash
assistant plugins list
```

Expect a `shared-memory` row with status `ok`. Column widths shift with the
other plugins installed:

```
NAME           VERSION  STATUS
shared-memory  0.0.1    ok
```

The JSON output has no status field, so check `issues` instead:

```bash
assistant plugins list --json | jq '.[] | select(.name=="shared-memory") | .issues'
```

Expect `[]`.

A status other than `ok` names the problem directly. `missing package.json` means
you cloned into the wrong place, or cloned only part of the repo. The
`package.json` has to sit at `plugins/shared-memory/package.json`. A directory
without one is not treated as a plugin at all, so the runtime skips it and its
skills never load.

## Step 6 — Verify the init hook

Two effects, both idempotent.

**The workspace git exclude carries the plugin directory, exactly once.**

```bash
grep -c '^/plugins/shared-memory/$' "$WS/.git/info/exclude"
```

Expect `1`. Restart the daemon and re-check; it should still be `1`.

```bash
vellum sleep --wait 60s && vellum wake
```

The line covers the whole plugin directory, not just `data/`. You installed by
cloning, so `plugins/shared-memory` carries its own `.git` and the workspace
would otherwise record it as a gitlink.

If the workspace is not a git repo there is no `.git` directory and this file
does not exist. That is a supported install. The hook reports `no-repo` and
writes nothing.

**The skills symlink points into the clone.**

```bash
readlink "$WS/plugins/shared-memory/skills"
```

Expect `data/repo/skills`. It dangles until the first sync, because
`data/repo` does not exist yet. That is expected and harmless.

## Step 7 — Run the sync

Find the schedule. The row's name is just `sync`, so match on the source key
instead, which is unambiguous.

```bash
assistant schedules list --json \
  | jq -r '.schedules[] | select(.sourceKey=="plugin:shared-memory/sync")
           | "\(.id)\t\(.name)\t\(.mode)"'
```

Expect one row: a UUID, the name `sync`, and the mode `script`. In the plain
`assistant schedules list` table the same row shows `sync` under NAME and
`shared-memory` under SOURCE.

Run it now:

```bash
SCHED=$(assistant schedules list --json \
  | jq -r '.schedules[] | select(.sourceKey=="plugin:shared-memory/sync") | .id')

assistant schedules execute "$SCHED"
```

The schedule may fire on its own cadence while you do this. Overlapping runs are
safe: sync takes a lock, and whichever run reaches it second prints
`shared-memory: another sync appears to be running, skipping this tick` and
exits 0 without touching anything. If that is what your run says, read the other
run's output instead. See
[One sync at a time](../README.md#one-sync-at-a-time) in the README.

Read the run:

```bash
assistant schedules runs "$SCHED" --limit 1
assistant schedules runs "$SCHED" --limit 1 --json | jq -r '.runs[0].output'
```

The run status should be `ok`, and the stored output should end like this on a
first sync:

```
Skill re-seed complete.
shared-memory: synced 4f9c1ab… (skills reembedded, pages ingested)
```

The last line is the script's own summary, and it is the one to check.
`Skill re-seed complete.` above it comes from the reseed call. Ingest prints
nothing here, even though it ran: the script calls it with `--json` and captures
its stdout to read the summary, so only the reseed's line reaches the run.

The scheduler stores stdout in `output` and stderr in `error`, so a run that
succeeded can still have text in `error`. Git writes its clone banner to stderr,
which is where the first sync's `Cloning into '…'` shows up:

```bash
assistant schedules runs "$SCHED" --limit 1 --json | jq -r '.runs[0].error'
```

The run row keeps the first 10,000 bytes of `output` and the first 2,000 bytes
of `error`, and drops the rest. A first sync over a large content repo can lose
the tail that way, summary line included. Run the script by hand, as below, if
you need to see it.

### If the flag is off

Run the script directly. It needs `VELLUM_WORKSPACE_DIR` set and the `assistant`
binary on PATH.

```bash
VELLUM_WORKSPACE_DIR="$WS" bash "$WS/plugins/shared-memory/schedules/sync/index.sh"
```

The output is the same as above, straight to your terminal, with the stderr
lines interleaved rather than split into a second field. You can also create
an ordinary user schedule that invokes the script, if you want it to run on a
cadence without the flag:

```bash
assistant schedules create shared-memory-sync \
  --expression '*/30 * * * *' \
  --mode script \
  --script "bash $WS/plugins/shared-memory/schedules/sync/index.sh" \
  --timeout-ms 300000 \
  --description "Pull the shared content repo"
```

## Step 8 — Verify the skill

The symlink resolves now, so the skill is visible on disk through it:

```bash
ls "$WS/plugins/shared-memory/skills/"
cat "$WS/plugins/shared-memory/skills/demo/SKILL.md"
```

And in the catalog:

```bash
assistant skills list | grep -A1 'demo'
assistant skills list --json | jq '.skills[] | select(.id=="demo")'
```

Expect the id `demo`, the source `plugin:shared-memory`, and the state
`enabled`:

```
  demo  plugin:shared-memory  enabled
    demo — Fixture skill from the shared content repo. …
```

The catalog re-walks the filesystem on every call, so this does not need another
restart. That is true of skills only. The plugin's hooks are loaded once per
boot, so a change to one needs a restart. Its schedule declaration does not: the
reconciler sweeps every 60 seconds and picks the change up while the daemon
runs.

Now check the assistant actually uses it. Stream events in the background, send
a message that matches the skill's description, then stop the stream.

```bash
( vellum events > /tmp/qa-events.log 2>&1 & )
vellum message "Give me the shared-memory demo handshake."
# wait for the reply, then:
pkill -f "vellum events"
grep -i "shared-memory fixture v1" /tmp/qa-events.log
```

Expect the reply to contain `shared-memory fixture v1`. The desktop or web app
works just as well for this. Ask the same question there.

## Step 9 — Verify the memory page

On disk, under the `shared/` prefix:

```bash
cat "$WS/memory/concepts/shared/deploy-runbook.md"
```

Expect the frontmatter and body from the fixture. A quick structural check of
the page tree:

```bash
assistant memory v2 validate
```

Then check retrieval. Ask about the topic, not the filename:

```bash
( vellum events > /tmp/qa-events.log 2>&1 & )
vellum message "What day do we ship releases, and who cuts the tag?"
# wait for the reply, then:
pkill -f "vellum events"
```

Expect Tuesdays and the release captain. Ingest queues background embed jobs, so
give it a minute or two after the sync before deciding retrieval is broken. The
Memory tab in the app shows the same page and is a good cross-check.

## Step 10 — Verify the update flow

Change the page in the fixture repo and commit.

```bash
cat > "$FIXTURE/concepts/deploy-runbook.md" <<'EOF'
---
source: import:shared-repo
title: Deploy runbook
summary: How the team ships a release.
tags: [ops]
---

Releases go out on Thursdays. The release captain cuts the tag, waits for the
staging bake to finish, then dispatches the production run.
EOF

git -C "$FIXTURE" -c user.email=qa@example.com -c user.name=QA \
  commit -aqm "Move releases to Thursday"
```

Re-run the sync (step 7). Expect:

```
shared-memory: synced 9a1b2cd… (skills skipped, pages ingested)
```

`skills skipped` is the interesting part. Only `concepts/` changed between the
last watermark and HEAD, so the script does not re-run the skill reseed.

Confirm the change landed:

```bash
grep Thursday "$WS/memory/concepts/shared/deploy-runbook.md"
```

Now do the same for a skill.

```bash
cat >> "$FIXTURE/skills/demo/SKILL.md" <<'EOF'

If asked for the fixture version, say `v2`.
EOF

git -C "$FIXTURE" -c user.email=qa@example.com -c user.name=QA \
  commit -aqm "Bump the demo skill"
```

Re-run the sync. Expect the mirror image:

```
shared-memory: synced 7d4e8fa… (skills reembedded, pages skipped)
```

And the edit visible through the symlink:

```bash
grep 'fixture version' "$WS/plugins/shared-memory/skills/demo/SKILL.md"
```

## Step 11 — Verify the no-op

Run the sync again immediately. Expect it to finish fast and call nothing:

```
Already up to date.
shared-memory: already synced at 7d4e8fa…
```

The script stops at the watermark check, before it calls the assistant at all.
So there should be no `Skill re-seed complete.` line. That line is the only
assistant output a run ever shows, so its absence is the proof the reseed did
not run. For ingest, the pages half is covered by the summary above: a run that
had called it would end in `pages ingested`.

The watermark is what makes this happen. It should match the fixture's HEAD:

```bash
cat "$WS/plugins/shared-memory/data/last-sha"
git -C "$FIXTURE" rev-parse HEAD
```

## Step 12 — Verify workspace hygiene

The plugin, the clone and the watermark all live in the workspace, but none of
them may show up as workspace changes.

```bash
git -C "$WS" status --short | grep 'plugins/shared-memory' || echo "no plugin noise"
```

Expect `no plugin noise`. That is the exclude line from step 6 doing its job.
It covers the whole plugin directory, so the nested clone you made in step 4
never reaches the workspace's index as a gitlink.

The path must also be untracked right now:

```bash
git -C "$WS" ls-files -- plugins/shared-memory
```

Expect no output. Then look at the history:

```bash
git -C "$WS" log --oneline -- plugins/shared-memory
```

Expect no output on a fresh install done in this runbook's order. Commits here
mean the path was recorded before the init hook first ran, which is what step 3
avoids and which the next boot heals; see
[Why the daemon goes down first](../README.md#why-the-daemon-goes-down-first) in
the README. What matters is that the `ls-files` check above is empty now. If it
is not, restart the daemon and re-check.

The plugin's own checkout should be clean too. Its `.gitignore` covers `data/`,
the `skills` symlink, `config.json` and `node_modules/`:

```bash
git -C "$WS/plugins/shared-memory" status --short
```

Expect no output at all. The config you wrote in step 4 is local to this install
and ignored, and nothing from `data/` or the `skills` link should appear either.
Installing dev dependencies does not change this: `bun.lock` is committed and
`node_modules/` is ignored.

## Troubleshooting

### The schedule never appears

Check the flag first. It is a live kill switch, not just a launch gate. Turning
it off disarms the row again on the next reconcile.

```bash
vellum flags get plugin-schedules
```

The reconciler also runs a sweep every 60 seconds, so give it a minute after
flipping the flag or restarting.

If the flag is on and the row still does not exist, the declaration may have
failed to parse. The daemon raises a notification for that:

```bash
assistant notifications list
```

Look for `Plugin schedule error: sync`. The body names the reason. Two things to
know about it. The notification is deduplicated per schedule per UTC day, so a
second bad reconcile on the same day is silent. And
`assistant plugins inspect shared-memory` cannot stand in for it. Inspect reads
the `schedules/` directory itself and only checks its shape, so what it shows
depends on how the declaration broke. A structural break, such as malformed JSON
in `schedules/sync/config.json` or a missing `expression`, drops the row from
the `schedules` block entirely. A declaration that is valid JSON but that the
daemon rejects, such as a bad cron expression, an unknown key, or a `timeout_ms`
outside the allowed range, still lists there and looks exactly like a working
one. Inspect never names the error in either case. The notification and the
daemon log are the only places it surfaces.

Finally, confirm the plugin itself loaded at all with `assistant plugins list`.

### The sync exits nonzero

Which stream carries the reason depends on what failed. Git, `jq` and PATH
problems land in stderr:

```bash
assistant schedules runs "$SCHED" --limit 1 --json | jq -r '.runs[0].error'
```

An ingest failure lands in stdout instead. The script calls ingest with
`--json`, the CLI prints its failure summary to stdout, and the script echoes
the reason in a line of its own:

```bash
assistant schedules runs "$SCHED" --limit 1 --json | jq -r '.runs[0].output'
```

Look for `shared-memory: ingest did not complete (<reason>), watermark
unchanged`.

**Git auth.** A schedule run inherits `HOME`, `PATH` and `SSH_AUTH_SOCK` from the
daemon's environment, so a key already loaded in your agent works. A key that
needs a passphrase does not, because the run has no terminal to prompt on. Use
an unlocked agent or a key without a passphrase. Run
`git ls-remote <repoUrl>` by hand to separate an auth problem from a plugin
problem.

**Consolidation lock.** The reason in stdout reads
`Memory ingest rejected: consolidation lock held by <holder>. Retry after the
current writer finishes.` Ingest holds that lock while it writes, so a
concurrent consolidation pass locks it out. This is expected contention, not a
bug. Wait and re-run.

**A `.git/index.lock` sync will not clear.** The line names the lock and ends
`the next tick tries again`. Something was writing to the clone when the pull
ran, so sync deferred instead of risking that work. It resolves once the writer
finishes, and a lock still there after 30 minutes is deleted on the next tick.
See [Recovering a wedged clone](../README.md#recovering-a-wedged-clone) in the
README.

**`jq: command not found`.** Install `jq`.

**`assistant: command not found`.** Only happens when you run the script by
hand. Put the assistant binary on your PATH.

For what advances the watermark and what does not, see
[Failure semantics](../README.md#failure-semantics) in the README.

### The sync keeps reporting the same clone problem

The run exits nonzero and ends with this line:

```
shared-memory: cannot refresh <repo path>, so it is preserved untouched; it may hold local work or be in a state sync cannot judge, so inspect it with git status and resolve by hand
```

Sync preserves any clone it cannot prove free of local work, which is a wider
net than holding some. For what that covers, see
[Recovering a wedged clone](../README.md#recovering-a-wedged-clone) in the
README.

Start with `status`. It names both kinds of cause:

```bash
REPO="$WS/plugins/shared-memory/data/repo"
git -C "$REPO" status
```

`HEAD detached at …`, or a branch with no `Your branch is up to date with …`
line, is the second kind. Nothing is in the way; sync just will not judge that
state. Put the clone back on the branch from `config.json`, `main` here:

```bash
git -C "$REPO" checkout main
```

For real local work, one command per kind. Uncommitted changes are in the
`status` above:

```bash
git -C "$REPO" log --oneline --branches --not --remotes
git -C "$REPO" stash list
```

The `log` line lists unpushed commits on every local branch, not just the
checked-out one, so a commit parked on a side branch shows up here.

Land or drop what you find. The next tick recovers on its own.

### The skill is not there, or is not recalled

Check the symlink resolves:

```bash
readlink "$WS/plugins/shared-memory/skills"
ls "$WS/plugins/shared-memory/skills/demo/SKILL.md"
```

A dangling symlink is skipped by the catalog silently, with no log line. So if
the clone never landed, the skill just quietly does not exist. Run the sync.

If `plugins/shared-memory/skills` is a real directory rather than a symlink, the
init hook leaves it alone and logs a warning. Delete it and restart the daemon.

If the file is there but the catalog does not list it, check the frontmatter.
Both `name` and `description` are required, and the block must be `---`-delimited
at the very top of the file.

If the catalog lists it but the assistant never reaches for it, the reseed is
what makes a skill recallable. Run it by hand:

```bash
assistant memory v2 reembed-skills
```

Expect `Skill re-seed complete.` The sync script runs this itself, but only when
`skills/` changed since the last watermark. So a skill added out of band, or a
first run that failed midway, can leave the embeddings stale.

### The page is on disk but never comes back in a conversation

Ingest writes the file synchronously and queues the embed work in the
background, so retrieval lags the file. Give it a minute or two.

Check the page parses:

```bash
assistant memory v2 validate
```

The slug is not the problem. Shared pages are ingested under `shared/`, so
nothing in the content repo lands on a reserved slug. See
[Names to avoid](../README.md#names-to-avoid) in the README.

Both `assistant memory ingest` and `assistant memory v2 reembed-skills` need
concept-page memory active. See the prerequisites.

### A page never reaches disk at all

Ingest rejected it. The run names the rejected slugs:

```bash
assistant schedules runs "$SCHED" --limit 1 --json | jq -r '.runs[0].output'
```

Look for `shared-memory: warning: rejected pages were skipped: <slugs>`.

The run does not carry the per-page reason, because the script reads the ingest
JSON and prints only the slugs. To see the reason, stage the clone's pages the
way the script does and dry-run ingest over them:

```bash
STAGE=$(mktemp -d)
mkdir -p "$STAGE/shared"
cp -R "$WS/plugins/shared-memory/data/repo/concepts/." "$STAGE/shared/"
assistant memory ingest --dir "$STAGE" --dry-run --json \
  | jq '.results[] | select(.action == "invalid")'
```

A dry run validates without writing anything, so it is safe to repeat while you
fix the page.

Fix the page in the content repo and commit. The next sync picks the fix up like
any other change; a rejected page does not hold the watermark back. See
[Failure semantics](../README.md#failure-semantics) in the README.

### The sync says "unconfigured, skipping"

The script found no `config.json`, or found one with no `repoUrl`. It exits 0,
because an unconfigured install is a deliberate no-op rather than a failure.

```bash
jq -r .repoUrl "$WS/plugins/shared-memory/config.json"
```

## Limitations

These are known and deliberate in this version, not defects to file.

- **Deleted pages are not removed.** Deleting a page from the content repo does
  not delete it from the assistant's memory. Skills are different: they are
  reconciled through the reseed, so deleting a skill from the repo does remove
  it.
- **Local edits to shared pages are lost.** Anything you change under
  `memory/concepts/shared/` is overwritten the next time the content repo has a
  new commit. The repo is the source of truth.
- **No provenance for a manual install.** Because you cloned the plugin by hand
  rather than installing it through the plugin system,
  `assistant plugins inspect shared-memory` reports:

  ```
  status      installed (not in marketplace)
  drift       unknown (no recorded baseline; reinstall to record one)
  ```

  Both lines are cosmetic here. If the marketplace cannot be reached at all the
  status line reads `installed (marketplace unavailable)` instead.
- **No permissioning.** Everything in the content repo reaches every assistant
  that installs the plugin. There is no way to scope a skill or a page to a
  subset of people.
