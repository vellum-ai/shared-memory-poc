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

**Reserved names.** Do not create directories named `skills/` or `cli-commands/`
directly under `concepts/`. Both are reserved slug prefixes in the assistant's
memory substrate, and pages underneath them would be rejected or left
unreachable. Nested uses further down a path are fine; only the top level
directly under `concepts/` is reserved.

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

None of these are committed to the plugin repo.

## Clone contract

The clone at `data/repo` is shared, so both halves have to respect the same
rules.

This plugin only ever runs `git pull --rebase --autostash` on the configured
branch. It never commits and never pushes.

The outbound half may create local commits in `data/repo` and push them, but it
must leave the clone checked out on the configured branch.

Because the pull rebases, unpushed local commits from the outbound half survive a
sync. If any git command fails, sync gives up for that tick and retries on the
next one. No partial state is written.

## Install

For the proof of concept:

1. Clone or copy this repo into `$VELLUM_WORKSPACE_DIR/plugins/shared-memory/`.
2. `cp config.example.json config.json` and set `repoUrl` to your content repo,
   and `branch` if it is not `main`.
3. Enable the `plugin-schedules` feature flag on the assistant.
4. Restart the daemon.

[`docs/QA.md`](docs/QA.md) is the step-by-step runbook: it builds a throwaway
content repo, installs the plugin against it, and verifies the whole path end to
end. It also lists this version's known limitations.
