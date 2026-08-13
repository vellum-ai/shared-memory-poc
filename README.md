# shared-memory

A Vellum assistant plugin that keeps an assistant in sync with a team's shared
content repository. It pulls the repo from git, registers the skills it contains
with the assistant's skill catalog, and ingests the memory concept pages into the
assistant's memory. Everything the team writes in one place becomes available to
every assistant that installs this plugin.

## Content repo layout

The content repo has two top-level directories.

### `skills/<name>/`

Standard SKILL.md bundles, following the Agent Skills specification at
<https://agentskills.io/specification>. Each skill is its own directory with a
`SKILL.md` at its root, plus any supporting files it references.

### `concepts/**.md`

Memory concept pages. Each file is optional YAML frontmatter followed by a
markdown body. The file path with the `.md` extension removed becomes the page
slug, and pages are ingested under the `shared/` slug prefix. So
`concepts/team/oncall.md` becomes the page `shared/team/oncall`.

The path becomes the slug, so the path has to be shaped like one. Every segment
of it, meaning every directory name and the filename with `.md` removed, must
match `[a-z0-9][a-z0-9-]*`. That is lowercase letters, digits and hyphens, with
a letter or a digit first. Underscores and uppercase are not allowed. A file
named `concepts/Team_Oncall.md` is rejected as invalid every time the pages half
runs, and the
only sign of it is a warning naming the slug. The other pages import as usual,
so a file named this way can sit there being skipped indefinitely. Name it
`concepts/team-oncall.md` instead.

Recommended frontmatter:

```yaml
---
source: import:shared-repo
title: On-call rotation
summary: Who is on call and how to reach them.
tags: [ops, team]
---
```

`source: import:shared-repo` marks the page as imported content. `title`,
`summary`, and `tags` are optional.

### Names to avoid

Keep directories named `skills/` and `cli-commands/` out of the top level of
`concepts/`. Both names are reserved at the top of the assistant's own memory
slug space.

Shared pages are ingested under `shared/`, so `concepts/skills/foo.md` becomes
the slug `shared/skills/foo` and imports fine today. The `shared/` prefix is
what holds such a page clear of the reserved names. Avoiding the two names is a
portability convention, then, not a rule the substrate enforces on shared pages.
Following it keeps the layout valid if that nesting ever changes. Uses of either
name further down a path are fine.

## Runtime layout

A deployed install lives at `$VELLUM_WORKSPACE_DIR/plugins/shared-memory/` and
grows these paths at runtime:

- `data/repo/` — the clone of the content repo. This is the single working copy,
  shared with the outbound (authoring and push) half.
- `data/last-sha` — the last commit that was fully processed. Sync compares
  against this to decide what changed.
- `data/digest-last-sha` — the last commit the digest reported on. The digest
  compares against this to decide what to announce.
- `data/sync.lock` — held for the length of a run, so two syncs cannot work on
  the clone at once.
- `skills` — a symlink to `data/repo/skills`, created by the init hook. The
  assistant's skill catalog reads the skills in place through this link, so no
  copying is involved.

None of these are committed to the plugin repo, and neither is the `config.json`
you write at install time. The plugin's `.gitignore` covers all of them, so a
deployed clone's own `git status` stays clean.

## Clone contract

The clone at `data/repo` is shared, so both halves have to respect the same
rules.

This plugin pulls with `git pull --rebase --autostash` on the configured branch.
It never commits and never pushes. The only other way it touches git history is
the clone replacement described below, which throws a whole clone away rather
than rewriting one.

The outbound half may create local commits in `data/repo` and push them, but it
must leave the clone checked out on the configured branch.

Because the pull rebases, unpushed local commits from the outbound half survive a
sync.

### One sync at a time

Sync takes a lock before it touches git, and releases it when it finishes. The
lock is the directory `data/sync.lock`.

Two runs can be in flight at once. The schedule fires on its own cadence, and
`assistant schedules execute` runs a tick inline without checking for one
already going. A run that finds the lock held prints this and exits 0:

```
shared-memory: another sync appears to be running, skipping this tick
```

Exiting 0 is the right answer, not a failure. The run holding the lock is doing
the work, and whatever it does not reach the next tick picks up.

A run killed by the schedule timeout is killed outright, so it never releases
its lock. A lock more than 35 minutes old is therefore taken as abandoned: the
next run deletes it and takes it. A schedule's timeout can be set no higher than
30 minutes, so no live run can own a lock that old.

### Recovering a wedged clone

A rebase that an earlier run left half-finished blocks every pull after it, so
sync aborts an in-progress rebase before it pulls.

A leftover `.git/index.lock` blocks git the same way. Before it attempts any
recovery, sync deletes that lock if it is more than 30 minutes old. No real git
operation holds the lock that long, and the sync lock keeps a second sync off
the clone, so a lock that old belongs to a run that was killed.

A lock younger than that may still belong to a git process that is running,
most likely the outbound half part way through a write. If the pull then fails,
sync leaves the clone alone and tries again on the next tick. It does not
attempt the replacement below on that tick, because replacing the clone would
destroy whatever that process is doing. The run exits nonzero and says so:

```
shared-memory: <repo path>/.git/index.lock is too new to clear, so a git process may still be writing to the clone; it is left alone and the next tick tries again
```

If the pull still fails, or the `branch` in `config.json` no longer matches the
branch the clone is on, sync replaces the clone. It clones fresh into
`data/repo.new.<pid>` and swaps that clone into place only once it has
succeeded. If the fresh clone fails, the old clone is left exactly as it was and
sync tries again on the next tick. A network outage cannot leave the install
without its skills.

The swap is two renames inside `data/`. The old clone is renamed to
`data/repo.old.<pid>`, the new clone is renamed to `data/repo`, and the old one
is deleted after that. Renames are atomic, so `data/repo` is always either the
clone you had or a complete new one, never a directory being emptied.

A run killed mid-swap can still leave a `data/repo.new.<pid>` or
`data/repo.old.<pid>` directory behind, because it never gets to clean up after
itself. Those are inert copies of a clone. The next run deletes any it finds
before it starts work, and says so:

```
shared-memory: removed <path>, left behind by an interrupted run
```

Two more things a killed run can leave. Between the two renames there is no
`data/repo` at all, and the next run clones one. A `data/repo` with no `.git` in
it is what a killed first clone leaves; sync renames that directory away and
clones fresh, because git will not clone into a directory that has files in it.

Sync replaces a clone only when it can prove the clone holds no local work.
Local work is any of three things:

- a commit on any local branch that is not on the remote, including one parked
  on a side branch that is not checked out;
- a stash entry;
- an uncommitted change, staged or not.

Proving all three absent takes a clone sync can read that way, and some clones
cannot be read that way at all. A detached HEAD is on no branch. A checked-out
branch with no upstream has no remote counterpart to compare against. In both
cases sync cannot tell an unpushed commit from a pushed one, so it preserves the
clone. Preservation means the clone was not proven free of local work, not that
it is known to hold some: a detached HEAD with a clean tree holds nothing and is
still preserved.

A preserved clone is left untouched and sync says so:

```
shared-memory: cannot refresh <repo path>, so it is preserved untouched; it may hold local work or be in a state sync cannot judge, so inspect it with git status and resolve by hand
```

Whatever is on disk stays on disk for someone to land, drop or check out, and
the assistant keeps running on the content it already has. Sync retries on every
tick until the state resolves.

A clone whose HEAD resolves to no commit never finished cloning, and a repo with
no commits cannot be holding an unpushed one. Sync replaces that clone too, on
the same conjuncts as the main rule minus the upstream check, which such a clone
can never satisfy: no commit the remote does not have, no stash entry, and a
clean tree.

### Failure semantics

The watermark at `data/last-sha` advances once the halves that ran have
succeeded.

A page that fails validation does not hold the watermark back. Ingest reports it
as a warning and names the slug, and the pages that are valid still import. The
watermark advances, so one malformed page cannot stall every commit behind it.
Fix the page in the content repo and the next sync picks it up.

Transport-level failures are the case that does hold the watermark back. If the
daemon is down, or the memory consolidation lock is held by another writer,
nothing is imported and the watermark stays where it was. The next tick retries
the same delta.

## Digest

Every six hours the plugin tells the user what changed in the shared knowledge
store since the last report, and who changed it. A notification lands in the
assistant's home feed, shaped like this:

> **Shared knowledge updates**
>
> **5 updates** to the shared knowledge repo by 2 authors (a7b06cc..2a770b1).
>
> - **Alice**: added skill `rollback`; added page `team/oncall`
> - **Bob**: added skill `oncall-tools`; updated skill `demo`

When nothing changed, nothing is sent. Silence means silence, not a heartbeat.

The digest reports the range between its own watermark at
`data/digest-last-sha` and sync's at `data/last-sha`. Sync's watermark only
advances once content has landed in the assistant, so the digest never
announces a commit whose skills or pages are not yet live. It follows that the
digest never needs the network, never pulls, and never takes the sync lock: it
reads history the clone already has. Its first run after install writes the
current synced commit to its watermark and says nothing, so a fresh install is
not greeted with the repo's whole history. The same reset happens if the clone
was replaced and no longer holds the old watermark.

Attribution comes from the commits in the range, skipping merge commits, so a
change is counted once under the person who made it. A skill counts as added or
removed only when its `SKILL.md` is; any other change under its directory is an
update. A rename is reported as an update of the new name. An entity the same
author both added and removed inside one range nets out to nothing; the same
sequence split across two authors shows one line for each, which overstates
what happened but never hides it.

Two schedules back this, and the optional `digest` block in `config.json`
decides which one speaks:

```json
{ "digest": { "summary": "deterministic" } }
```

- `deterministic` (the default, also when the block is absent): the `digest`
  schedule formats the summary itself, from git data alone. No model involved.
- `llm`: the `digest-llm` schedule has the assistant write the summary in
  prose. Same facts, gathered by the same script; the model only does the
  wording, under instructions to name every author and invent nothing.

Both schedules fire on the same cadence and check the mode first, so exactly
one of them notifies. The change takes effect on the next tick; nothing
re-arms. In deterministic mode the `digest-llm` schedule still spends a small
model turn each tick finding out it has nothing to do. If that bothers you,
`assistant schedules disable <id>` on the `digest-llm` row turns it off, and
the override sticks across plugin upgrades.

A digest run that sends but is killed before it can advance the watermark
retries the same range on the next tick. The notification carries a dedupe key
made from that range, so the router drops the duplicate and the user is
notified once.

## Install

### Concept-page memory

Concept-page memory has to be active on the assistant first. Both
`assistant memory ingest` and `assistant memory v2 reembed-skills` refuse to run
without it, and those are the two calls sync makes, so neither half of a sync
would do anything. It is on by default. Check it:

```bash
assistant config get memory.enabled
assistant config get memory.v2.enabled
assistant config get memory.v3.live
```

`(not set)` counts as on. `memory.v2.enabled` defaults to true, and the gate
reads the defaulted config, so a stock assistant prints `(not set)` for all
three keys and still has concept-page memory active. Two settings turn it off.
`memory.enabled` set to `false` is the master Memory opt-out and stops ingest
and the reseed whatever the tier keys say. `memory.v2.enabled` set to `false`
turns it off too, unless `memory.v3.live` is `true`.

### Steps

For the proof of concept:

1. Enable the `plugin-schedules` feature flag on the assistant. This talks to
   the running daemon, so do it before the next step.
2. Stop the daemon: `vellum sleep --wait 60s`.
3. Clone or copy this repo into `$VELLUM_WORKSPACE_DIR/plugins/shared-memory/`.
4. `cp config.example.json config.json` and set `repoUrl` to your content repo,
   and `branch` if it is not `main`.
5. Start the daemon: `vellum wake`.

[`docs/QA.md`](docs/QA.md) is the step-by-step runbook: it builds a throwaway
content repo, installs the plugin against it, and verifies the whole path end to
end. It also lists this version's known limitations.

### Why the daemon goes down first

The daemon is down for the clone on purpose. A running assistant commits its
workspace by itself, on a heartbeat and again on shutdown, and the exclude line
that keeps the plugin out of that history is written by the plugin's init hook,
which does not run until the next boot. Clone into a live workspace and the
commit can land first, recording `plugins/shared-memory` as a nested-repo entry.

An install done in the other order heals itself. On the next boot the init hook
writes the exclude line and then untracks the path with `git rm --cached`, so
the workspace stops recording changes under it. The commits already made keep
their entry, which is harmless.

## Working on the plugin

The repo commits `bun.lock`, and `.gitignore` covers `node_modules/`, so the
development loop leaves the checkout clean:

```bash
bun install
bunx tsc --noEmit
```

A `git status` that is dirty after those two commands means a dependency
changed, not that the loop is untidy.
