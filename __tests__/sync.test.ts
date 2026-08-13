import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILLS_LINK_TARGET } from "../src/workspace-setup.js";
import { commit, identify, initRepo, runGit } from "./git-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "schedules", "sync", "index.sh");

// What the gate prints when it will not touch the clone, minus the path.
const PRESERVE_MESSAGE =
  "so it is preserved untouched; it may hold local work or be in a state sync cannot judge, so inspect it with git status and resolve by hand";

// Stands in for the assistant CLI: records every invocation, reports whether an
// ingest was handed a staging directory of the expected shape, and answers an
// ingest with the same JSON summary the real command prints under --json. Any
// page named broken.md comes back as an invalid result, which is how the real
// command reports a page it cannot validate. While the gate file exists the
// call blocks, which holds a run inside the sync for as long as a test needs.
const FAKE_ASSISTANT = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SM_TEST_CALLS"

waited=0
while [ -f "\${SM_TEST_GATE:-}" ] && [ "$waited" -lt 200 ]; do
  sleep 0.1
  waited=$((waited + 1))
done

mode=""
dir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--dir" ]; then
    dir="$arg"
  fi
  if [ "$arg" = "ingest" ]; then
    mode="ingest"
  fi
  prev="$arg"
done

if [ "$mode" != "ingest" ]; then
  exit 0
fi

if [ -f "$dir/shared/deploy-runbook.md" ]; then
  printf 'staged\\n' >> "$SM_TEST_STAGE_LOG"
else
  printf 'missing\\n' >> "$SM_TEST_STAGE_LOG"
fi

# Output the script cannot read as a summary at all.
if [ -f "$SM_TEST_GARBAGE_INGEST" ]; then
  printf 'Error: assistant daemon is not running\\n' >&2
  exit 10
fi

# A batch that aborted part way through, as --json reports it.
if [ -f "$SM_TEST_FAIL_INGEST" ]; then
  printf '{"ok":false,"error":"consolidation lock held by memory-worker","partial":{"results":[],"written":0,"skipped":0,"invalid":0,"dryRun":false}}\\n'
  exit 3
fi

results=""
written=0
invalid=0
while IFS= read -r page; do
  if [ -z "$page" ]; then
    continue
  fi
  slug=$(printf '%s' "$page" | sed -e "s#^$dir/##" -e 's#\\.md$##')
  case "$page" in
    *broken.md)
      entry=$(printf '{"slug":"%s","action":"invalid","warnings":[],"error":"frontmatter is not valid YAML"}' "$slug")
      invalid=$((invalid + 1))
      ;;
    *)
      entry=$(printf '{"slug":"%s","action":"written","warnings":[]}' "$slug")
      written=$((written + 1))
      ;;
  esac
  if [ -n "$results" ]; then
    results="$results,"
  fi
  results="$results$entry"
done <<<"$(find "$dir" -type f -name '*.md' | sort)"

printf '{"results":[%s],"written":%d,"skipped":0,"invalid":%d,"dryRun":false}\\n' "$results" "$written" "$invalid"

if [ "$invalid" -gt 0 ]; then
  exit 1
fi
exit 0
`;

interface Fixture {
  content: string;
  plugin: string;
  script: string;
  bin: string;
  workdir: string;
  calls: string;
  stageLog: string;
  failFlag: string;
  garbageFlag: string;
  gateFlag: string;
}

const roots: string[] = [];

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function makeContentRepo(root: string): void {
  initRepo(root);
  writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n\nA demo skill.\n");
  writeFile(
    join(root, "concepts", "deploy-runbook.md"),
    "---\ntitle: Deploy runbook\n---\n\nHow the team deploys.\n",
  );
  commit(root, "seed shared content");
}

function writeConfig(plugin: string, content: string, branch: string): void {
  writeFileSync(
    join(plugin, "config.json"),
    `${JSON.stringify({ repoUrl: `file://${content}`, branch }, null, 2)}\n`,
  );
}

function makeFixture(options: { config?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-sync-"));
  roots.push(root);

  const configured = options.config !== false;
  const content = join(root, "content");
  if (configured) {
    makeContentRepo(content);
  }

  const plugin = join(root, "plugins", "shared-memory");
  const script = join(plugin, "schedules", "sync", "index.sh");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(plugin, "data"), { recursive: true });
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);

  if (configured) {
    writeConfig(plugin, content, "main");
  }

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "assistant"), FAKE_ASSISTANT);
  chmodSync(join(bin, "assistant"), 0o755);

  const workdir = join(root, "workspace");
  mkdirSync(workdir);

  return {
    content,
    plugin,
    script,
    bin,
    workdir,
    calls: join(root, "calls.log"),
    stageLog: join(root, "stage.log"),
    failFlag: join(root, "fail-ingest"),
    garbageFlag: join(root, "garbage-ingest"),
    gateFlag: join(root, "gate-assistant"),
  };
}

function dataPath(fixture: Fixture, ...parts: string[]): string {
  return join(fixture.plugin, "data", ...parts);
}

function clonePath(fixture: Fixture): string {
  return dataPath(fixture, "repo");
}

function lockPath(fixture: Fixture): string {
  return dataPath(fixture, "sync.lock");
}

// Advances the content repo by one commit and reports the new sha.
function addOncallPage(fixture: Fixture): string {
  writeFile(join(fixture.content, "concepts", "oncall.md"), "---\ntitle: On-call\n---\n\nWho is on call.\n");
  return commit(fixture.content, "add the on-call page");
}

// Points the clone at a remote that is not there, so its next pull fails the
// way one against an unreachable remote does. The repoUrl in config still
// resolves, so a replacement clone would succeed.
function breakRemote(fixture: Fixture): void {
  runGit(clonePath(fixture), ["remote", "set-url", "origin", `file://${fixture.content}-gone`]);
}

// Mirrors the engine: absolute script path, a cwd that is not the plugin
// directory, and a sanitized environment.
function syncEnv(fixture: Fixture): Record<string, string> {
  return {
    PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "",
    SM_TEST_CALLS: fixture.calls,
    SM_TEST_STAGE_LOG: fixture.stageLog,
    SM_TEST_FAIL_INGEST: fixture.failFlag,
    SM_TEST_GARBAGE_INGEST: fixture.garbageFlag,
    SM_TEST_GATE: fixture.gateFlag,
  };
}

function runSync(fixture: Fixture): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", fixture.script], {
    cwd: fixture.workdir,
    env: syncEnv(fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Starts a sync that keeps running, for the tests about two runs at once. */
function startSync(fixture: Fixture) {
  return Bun.spawn(["bash", fixture.script], {
    cwd: fixture.workdir,
    env: syncEnv(fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(25);
  }
}

function readLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function calls(fixture: Fixture): string[] {
  return readLines(fixture.calls);
}

function resetCalls(fixture: Fixture): void {
  writeFileSync(fixture.calls, "");
}

function lastSha(fixture: Fixture): string | null {
  const path = dataPath(fixture, "last-sha");
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").trim();
}

// A file inside .git that only survives if the clone was recovered in place.
function markClone(fixture: Fixture): string {
  const marker = join(clonePath(fixture), ".git", "sync-test-marker");
  writeFileSync(marker, "original clone\n");
  return marker;
}

// The symlink the init hook lays down. Every shared skill reaches the assistant
// through it, so it stops resolving the moment the clone is gone.
function linkSkills(fixture: Fixture): string {
  const linkPath = join(fixture.plugin, "skills");
  symlinkSync(SKILLS_LINK_TARGET, linkPath);
  return linkPath;
}

// Ages a file so the script reads it as left behind by a process that is gone.
function backdate(path: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000);
  utimesSync(path, when, when);
}

// The clones the swap builds and retires under data/, which no run may leave.
function leftoverClones(fixture: Fixture): string[] {
  return readdirSync(dataPath(fixture)).filter(
    (entry) => entry.startsWith("repo.new.") || entry.startsWith("repo.old."),
  );
}

// Replaces the clone with what a clone killed by the schedule timeout leaves: a
// .git that knows the remote but has no commit at HEAD yet.
function makePartialClone(fixture: Fixture): string {
  const clone = clonePath(fixture);
  rmSync(clone, { recursive: true, force: true });
  initRepo(clone);
  runGit(clone, ["remote", "add", "origin", `file://${fixture.content}`]);
  return clone;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sync schedule", () => {
  let fixture: Fixture;
  let seedSha: string;

  beforeAll(() => {
    fixture = makeFixture();
    seedSha = runGit(fixture.content, ["rev-parse", "HEAD"]).trim();
  });

  test("first run clones the repo and syncs both halves", () => {
    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(clonePath(fixture), ".git"))).toBe(true);

    const recorded = calls(fixture);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toBe("memory v2 reembed-skills");
    expect(recorded[1]).toMatch(/^memory ingest --dir \S+ --overwrite --json$/);
    // Ingest is handed the concept pages nested under shared/.
    expect(readLines(fixture.stageLog)).toEqual(["staged"]);
    expect(lastSha(fixture)).toBe(seedSha);
    // The lock the run took is released.
    expect(existsSync(lockPath(fixture))).toBe(false);
  });

  test("re-running with no new commits does nothing", () => {
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a skills-only commit reembeds skills without ingesting pages", () => {
    writeFile(join(fixture.content, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n\nEdited.\n");
    const sha = commit(fixture.content, "edit the demo skill");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(calls(fixture)).toEqual(["memory v2 reembed-skills"]);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a concepts-only commit ingests pages without reembedding skills", () => {
    writeFile(join(fixture.content, "concepts", "deploy-runbook.md"), "---\ntitle: Deploy runbook\n---\n\nEdited.\n");
    const sha = commit(fixture.content, "edit the deploy runbook");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    const recorded = calls(fixture);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/^memory ingest --dir \S+ --overwrite --json$/);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a failed ingest leaves the watermark behind and the next run retries", () => {
    const before = lastSha(fixture);
    const sha = addOncallPage(fixture);
    writeFileSync(fixture.failFlag, "");
    resetCalls(fixture);

    const failed = runSync(fixture);

    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toContain("consolidation lock");
    expect(calls(fixture)).toHaveLength(1);
    expect(lastSha(fixture)).toBe(before);

    rmSync(fixture.failFlag);
    resetCalls(fixture);

    const retried = runSync(fixture);

    expect(retried.exitCode).toBe(0);
    const recorded = calls(fixture);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/^memory ingest --dir \S+ --overwrite --json$/);
    expect(lastSha(fixture)).toBe(sha);
  });
});

test("an unconfigured plugin exits quietly without cloning", () => {
  const fixture = makeFixture({ config: false });

  const result = runSync(fixture);

  expect(result.exitCode).toBe(0);
  expect(calls(fixture)).toEqual([]);
  expect(existsSync(clonePath(fixture))).toBe(false);
  expect(existsSync(lockPath(fixture))).toBe(false);
  expect(lastSha(fixture)).toBeNull();
});

describe("one sync at a time", () => {
  test(
    "a run started while another holds the lock exits without touching the clone",
    async () => {
      const fixture = makeFixture();
      const seedSha = runGit(fixture.content, ["rev-parse", "HEAD"]).trim();
      // Holds the first run inside its reembed call, so the second run starts
      // while the first is part way through a sync.
      writeFileSync(fixture.gateFlag, "");
      const first = startSync(fixture);

      try {
        await waitFor(() => calls(fixture).length > 0, "the first run to start syncing");

        const second = runSync(fixture);

        expect(second.exitCode).toBe(0);
        expect(second.stdout).toContain("another sync appears to be running, skipping this tick");
        // Nothing of the first run's work was touched or repeated.
        expect(calls(fixture)).toHaveLength(1);
        expect(lastSha(fixture)).toBeNull();
      } finally {
        rmSync(fixture.gateFlag, { force: true });
      }

      expect(await first.exited).toBe(0);
      expect(calls(fixture)).toHaveLength(2);
      expect(lastSha(fixture)).toBe(seedSha);
      expect(existsSync(lockPath(fixture))).toBe(false);
    },
    30_000,
  );

  test("a lock older than the schedule timeout ceiling is reclaimed", () => {
    const fixture = makeFixture();
    const seedSha = runGit(fixture.content, ["rev-parse", "HEAD"]).trim();
    // A run the timeout killed never reached its own cleanup, so its lock is
    // still on disk with nothing behind it.
    const lock = lockPath(fixture);
    mkdirSync(lock);
    backdate(lock, 40);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(calls(fixture)).toHaveLength(2);
    expect(lastSha(fixture)).toBe(seedSha);
    expect(existsSync(lock)).toBe(false);
  });

  test("clones left behind by an interrupted run are swept before any git work", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);
    const seedSha = lastSha(fixture);

    const leftovers = [dataPath(fixture, "repo.new.4242"), dataPath(fixture, "repo.old.4242")];
    for (const leftover of leftovers) {
      writeFile(join(leftover, "concepts", "stale.md"), "---\ntitle: Stale\n---\n\nFrom a killed run.\n");
    }
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("left behind by an interrupted run");
    expect(leftoverClones(fixture)).toEqual([]);
    // The sweep is the only thing that ran; the clone itself was already synced.
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });
});

describe("clone recovery", () => {
  test("a rebase left half-applied is aborted and the pull carries on", () => {
    const fixture = makeFixture();
    addOncallPage(fixture);

    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    identify(clone);
    const marker = markClone(fixture);
    // Stops part way through with the rebase state still on disk, the way a
    // tick killed by the schedule timeout leaves it.
    expect(() => runGit(clone, ["rebase", "--exec", "false", "HEAD~1"])).toThrow();
    expect(existsSync(join(clone, ".git", "rebase-merge"))).toBe(true);

    writeFile(join(fixture.content, "concepts", "rotation.md"), "---\ntitle: Rotation\n---\n\nThe rotation.\n");
    const sha = commit(fixture.content, "add the rotation page");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(clone, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(runGit(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(lastSha(fixture)).toBe(sha);
  });

  test("an index.lock older than half an hour is cleared and the clone recovers in place", () => {
    const fixture = makeFixture();
    addOncallPage(fixture);
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    identify(clone);
    const marker = markClone(fixture);
    // What a tick killed by the timeout leaves behind: rebase state plus the
    // index lock, which the abort itself then fails on.
    expect(() => runGit(clone, ["rebase", "--exec", "false", "HEAD~1"])).toThrow();
    const lock = join(clone, ".git", "index.lock");
    writeFileSync(lock, "");
    backdate(lock, 45);
    expect(() => runGit(clone, ["rebase", "--abort"])).toThrow();

    writeFile(join(fixture.content, "concepts", "rotation.md"), "---\ntitle: Rotation\n---\n\nThe rotation.\n");
    const sha = commit(fixture.content, "add the rotation page");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(join(clone, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(runGit(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(sha);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("an index.lock too new to clear defers the tick and touches nothing", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);
    const seedSha = lastSha(fixture);

    const clone = clonePath(fixture);
    const marker = markClone(fixture);
    // A lock this young may belong to a git process that is still running, so
    // the clone is left alone even though nothing else about it says so.
    const lock = join(clone, ".git", "index.lock");
    writeFileSync(lock, "");

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("too new to clear");
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    // The replacement gate was never reached.
    expect(result.stdout).not.toContain(PRESERVE_MESSAGE);
    expect(leftoverClones(fixture)).toEqual([]);
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a pull failure on a clone with nothing local is replaced by a fresh clone", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const marker = markClone(fixture);
    breakRemote(fixture);

    const sha = addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(sha);
    // The swap left neither of its two staging paths behind.
    expect(leftoverClones(fixture)).toEqual([]);
    expect(calls(fixture)[0]).toMatch(/^memory ingest --dir \S+ --overwrite --json$/);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a clone with no .git left in it is moved aside and cloned fresh", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    // What a run killed mid-swap can leave: a directory at the clone's path
    // with files in it and no repository, which git clone refuses to write to.
    rmSync(join(clone, ".git"), { recursive: true, force: true });
    writeFile(join(clone, "concepts", "half-written.md"), "---\ntitle: Half\n---\n\nHalf a clone.\n");

    const sha = addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(clone, ".git"))).toBe(true);
    expect(existsSync(join(clone, "concepts", "half-written.md"))).toBe(false);
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(sha);
    expect(leftoverClones(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a pull failure the replacement clone cannot fix keeps the old clone serving skills", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = runGit(fixture.content, ["rev-parse", "HEAD"]).trim();
    const marker = markClone(fixture);
    const link = linkSkills(fixture);
    // A healthy clone the gate rules safe to replace, and a remote that has
    // gone away, so the replacement cannot be fetched either.
    rmSync(fixture.content, { recursive: true, force: true });
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("the old one is kept");
    expect(existsSync(marker)).toBe(true);
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(seedSha);
    // The shared skills are still reachable through the link for the outage.
    expect(existsSync(link)).toBe(true);
    expect(existsSync(join(link, "demo", "SKILL.md"))).toBe(true);
    expect(leftoverClones(fixture)).toEqual([]);
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a pull failure on a clone holding an unpushed commit preserves it", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    identify(clone);
    writeFile(join(clone, "concepts", "draft.md"), "---\ntitle: Draft\n---\n\nNot pushed yet.\n");
    const localSha = commit(clone, "outbound work that is not pushed");
    breakRemote(fixture);

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(PRESERVE_MESSAGE);
    expect(calls(fixture)).toEqual([]);
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(localSha);
    expect(existsSync(join(clone, "concepts", "draft.md"))).toBe(true);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a pull failure on a clone holding an unpushed commit on another branch preserves it", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    identify(clone);
    const marker = markClone(fixture);
    // The work is parked on a branch that is not checked out, and the clone is
    // left on the configured branch with a clean tree, so nothing about the
    // checked out branch reveals this commit.
    runGit(clone, ["checkout", "-q", "-b", "draft"]);
    writeFile(join(clone, "concepts", "draft.md"), "---\ntitle: Draft\n---\n\nNot pushed yet.\n");
    const draftSha = commit(clone, "outbound work parked on a side branch");
    runGit(clone, ["checkout", "-q", "main"]);
    breakRemote(fixture);

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(PRESERVE_MESSAGE);
    expect(calls(fixture)).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    expect(runGit(clone, ["rev-parse", "draft"]).trim()).toBe(draftSha);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a pull failure on a clone holding a stash entry preserves it", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    identify(clone);
    const marker = markClone(fixture);
    // A pull that stashed and then failed leaves the tree clean on the
    // configured branch with the work held only in the stash.
    writeFile(join(clone, "concepts", "deploy-runbook.md"), "---\ntitle: Deploy runbook\n---\n\nStashed edit.\n");
    runGit(clone, ["stash", "push", "-q", "-m", "autostash"]);
    expect(runGit(clone, ["status", "--porcelain"])).toBe("");
    breakRemote(fixture);

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(PRESERVE_MESSAGE);
    expect(calls(fixture)).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    expect(runGit(clone, ["stash", "list"])).toContain("autostash");
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a pull failure on a clone with uncommitted work preserves it", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    writeFile(join(clone, "concepts", "wip.md"), "---\ntitle: WIP\n---\n\nStill being written.\n");
    breakRemote(fixture);

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(PRESERVE_MESSAGE);
    expect(existsSync(join(clone, "concepts", "wip.md"))).toBe(true);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a clone that never finished is replaced", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = makePartialClone(fixture);
    // The state the script has to read: no commit at HEAD, nothing in the tree.
    expect(() => runGit(clone, ["rev-parse", "--verify", "HEAD^{commit}"])).toThrow();
    expect(() => runGit(clone, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toThrow();
    expect(runGit(clone, ["status", "--porcelain"])).toBe("");

    const sha = addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(sha);
    expect(leftoverClones(fixture)).toEqual([]);
    expect(calls(fixture)[0]).toMatch(/^memory ingest --dir \S+ --overwrite --json$/);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a clone that never finished but has files in it is preserved", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);
    const seedSha = lastSha(fixture);

    const clone = makePartialClone(fixture);
    writeFile(join(clone, "concepts", "draft.md"), "---\ntitle: Draft\n---\n\nNot pushed yet.\n");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(PRESERVE_MESSAGE);
    expect(existsSync(join(clone, "concepts", "draft.md"))).toBe(true);
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a clone parked on an orphan branch with work on another branch is preserved", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    identify(clone);
    const marker = markClone(fixture);
    runGit(clone, ["checkout", "-q", "-b", "draft"]);
    writeFile(join(clone, "concepts", "draft.md"), "---\ntitle: Draft\n---\n\nNot pushed yet.\n");
    const draftSha = commit(clone, "outbound work parked on a side branch");
    // An orphan checkout emptied out reads like a clone that never finished:
    // no commit at HEAD and a clean tree, while the draft branch holds work.
    runGit(clone, ["checkout", "-q", "--orphan", "blank"]);
    runGit(clone, ["rm", "-r", "-q", "-f", "."]);
    expect(() => runGit(clone, ["rev-parse", "--verify", "HEAD^{commit}"])).toThrow();
    expect(runGit(clone, ["status", "--porcelain"])).toBe("");

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(PRESERVE_MESSAGE);
    expect(existsSync(marker)).toBe(true);
    expect(runGit(clone, ["rev-parse", "draft"]).trim()).toBe(draftSha);
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a branch change in config re-clones onto the new branch", () => {
    const fixture = makeFixture();
    runGit(fixture.content, ["checkout", "-q", "-b", "release"]);
    writeFile(join(fixture.content, "concepts", "release-notes.md"), "---\ntitle: Release notes\n---\n\nWhat shipped.\n");
    const releaseSha = commit(fixture.content, "add the release notes page");
    runGit(fixture.content, ["checkout", "-q", "main"]);

    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const marker = markClone(fixture);
    writeConfig(fixture.plugin, fixture.content, "release");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(runGit(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("release");
    expect(runGit(clone, ["rev-parse", "HEAD"]).trim()).toBe(releaseSha);
    expect(leftoverClones(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(releaseSha);
  });
});

describe("ingest outcomes", () => {
  test("a page the assistant rejects is reported and the watermark still advances", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    writeFile(join(fixture.content, "concepts", "broken.md"), "---\ntitle: [\n---\n\nBroken frontmatter.\n");
    const sha = commit(fixture.content, "add a page that cannot be validated");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shared/broken");
    expect(calls(fixture)).toHaveLength(1);
    expect(lastSha(fixture)).toBe(sha);

    // The page stays rejected, but the tree is not re-ingested for it.
    resetCalls(fixture);
    const settled = runSync(fixture);
    expect(settled.exitCode).toBe(0);
    expect(calls(fixture)).toEqual([]);
  });

  test("an ingest that prints no summary at all leaves the watermark behind", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);
    const before = lastSha(fixture);

    addOncallPage(fixture);
    writeFileSync(fixture.garbageFlag, "");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("no JSON summary");
    expect(lastSha(fixture)).toBe(before);

    rmSync(fixture.garbageFlag);
    resetCalls(fixture);

    const retried = runSync(fixture);

    expect(retried.exitCode).toBe(0);
    expect(lastSha(fixture)).not.toBe(before);
  });
});
