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
the clone repair described below, which discards a clone rather than rewriting
one.

The outbound half may create local commits in `data/repo` and push them, but it
must leave the clone checked out on the configured branch.

Because the pull rebases, unpushed local commits from the outbound half survive a
sync.

### Recovering a wedged clone

A rebase that an earlier run left half-finished blocks every pull after it, so
sync aborts an in-progress rebase before it pulls.

If the pull still fails, or the `branch` in `config.json` no longer matches the
branch the clone was made from, sync repairs the clone by deleting `data/repo`
and cloning again. It only does that when the clone holds nothing that would be
lost, which means no unpushed commits and no uncommitted changes.

If the clone does hold either, sync keeps it, reports that the state needs
manual resolution, and tries again on the next tick. The local work stays on
disk for someone to land or drop, and the assistant keeps running on the content
it already has.

A clone whose HEAD resolves to no commit never finished cloning and so cannot
hold outbound work, and sync deletes and re-clones that one too as long as it has
no uncommitted changes.

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

## Install

Concept-page memory has to be active on the assistant first. Both
`assistant memory ingest` and `assistant memory v2 reembed-skills` refuse to run
without it, and those are the two calls sync makes, so neither half of a sync
would do anything. It is on by default on current assistants. Check it:

```bash
assistant config get memory.v3.live
assistant config get memory.v2.enabled
```

At least one has to be on.

Then, for the proof of concept:

1. Clone or copy this repo into `$VELLUM_WORKSPACE_DIR/plugins/shared-memory/`.
2. `cp config.example.json config.json` and set `repoUrl` to your content repo,
   and `branch` if it is not `main`.
3. Enable the `plugin-schedules` feature flag on the assistant.
4. Restart the daemon.

[`docs/QA.md`](docs/QA.md) is the step-by-step runbook: it builds a throwaway
content repo, installs the plugin against it, and verifies the whole path end to
end. It also lists this version's known limitations.
