import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "schedules", "sync", "index.sh");

// Stands in for the assistant CLI: records every invocation, reports whether an
// ingest was handed a staging directory of the expected shape, and answers an
// ingest with the same JSON summary the real command prints under --json. Any
// page named broken.md comes back as an invalid result, which is how the real
// command reports a page it cannot validate.
const FAKE_ASSISTANT = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SM_TEST_CALLS"

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

# With the daemon unreachable the real command still prints an error envelope
# on stdout under --json, and exits 10.
if [ -f "$SM_TEST_DEAD_INGEST" ]; then
  printf '{"ok":false,"error":"Could not connect to the assistant at /tmp/assistant.sock.\\\\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.","partial":{"results":[],"written":0,"skipped":0,"invalid":0,"dryRun":false}}\\n'
  exit 10
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
  deadFlag: string;
  garbageFlag: string;
}

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  // stderr is captured rather than inherited so the commands a test fails on
  // purpose do not print over the test output.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function identify(repo: string): void {
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}

function makeContentRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  identify(root);
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
    deadFlag: join(root, "dead-ingest"),
    garbageFlag: join(root, "garbage-ingest"),
  };
}

function clonePath(fixture: Fixture): string {
  return join(fixture.plugin, "data", "repo");
}

// Advances the content repo by one commit and reports the new sha.
function addOncallPage(fixture: Fixture): string {
  writeFile(join(fixture.content, "concepts", "oncall.md"), "---\ntitle: On-call\n---\n\nWho is on call.\n");
  return commit(fixture.content, "add the on-call page");
}

// Mirrors the engine: absolute script path, a cwd that is not the plugin
// directory, and a sanitized environment.
function runSync(fixture: Fixture): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", fixture.script], {
    cwd: fixture.workdir,
    env: {
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      SM_TEST_CALLS: fixture.calls,
      SM_TEST_STAGE_LOG: fixture.stageLog,
      SM_TEST_FAIL_INGEST: fixture.failFlag,
      SM_TEST_DEAD_INGEST: fixture.deadFlag,
      SM_TEST_GARBAGE_INGEST: fixture.garbageFlag,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
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
  const path = join(fixture.plugin, "data", "last-sha");
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

// Replaces the clone with what a clone killed by the schedule timeout leaves: a
// .git that knows the remote but has no commit at HEAD yet.
function makePartialClone(fixture: Fixture): string {
  const clone = clonePath(fixture);
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(clone, { recursive: true });
  git(clone, ["init", "-q", "-b", "main"]);
  git(clone, ["remote", "add", "origin", `file://${fixture.content}`]);
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
    seedSha = git(fixture.content, ["rev-parse", "HEAD"]).trim();
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
  expect(lastSha(fixture)).toBeNull();
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
    expect(() => git(clone, ["rebase", "--exec", "false", "HEAD~1"])).toThrow();
    expect(existsSync(join(clone, ".git", "rebase-merge"))).toBe(true);

    writeFile(join(fixture.content, "concepts", "rotation.md"), "---\ntitle: Rotation\n---\n\nThe rotation.\n");
    const sha = commit(fixture.content, "add the rotation page");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(clone, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(git(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a pull failure on a clone with nothing local re-clones and completes", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const marker = markClone(fixture);
    // A lock file left behind by a killed git process fails every later pull.
    writeFileSync(join(clone, ".git", "index.lock"), "");

    const sha = addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(clone, ".git", "index.lock"))).toBe(false);
    expect(git(clone, ["rev-parse", "HEAD"]).trim()).toBe(sha);
    expect(calls(fixture)[0]).toMatch(/^memory ingest --dir \S+ --overwrite --json$/);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a pull failure on a clone holding an unpushed commit preserves it", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    identify(clone);
    writeFile(join(clone, "concepts", "draft.md"), "---\ntitle: Draft\n---\n\nNot pushed yet.\n");
    const localSha = commit(clone, "outbound work that is not pushed");
    writeFileSync(join(clone, ".git", "index.lock"), "");

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("preserved");
    expect(calls(fixture)).toEqual([]);
    expect(git(clone, ["rev-parse", "HEAD"]).trim()).toBe(localSha);
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
    git(clone, ["checkout", "-q", "-b", "draft"]);
    writeFile(join(clone, "concepts", "draft.md"), "---\ntitle: Draft\n---\n\nNot pushed yet.\n");
    const draftSha = commit(clone, "outbound work parked on a side branch");
    git(clone, ["checkout", "-q", "main"]);
    writeFileSync(join(clone, ".git", "index.lock"), "");

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("preserved");
    expect(calls(fixture)).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    expect(git(clone, ["rev-parse", "draft"]).trim()).toBe(draftSha);
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
    git(clone, ["stash", "push", "-q", "-m", "autostash"]);
    expect(git(clone, ["status", "--porcelain"])).toBe("");
    writeFileSync(join(clone, ".git", "index.lock"), "");

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("preserved");
    expect(calls(fixture)).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    expect(git(clone, ["stash", "list"])).toContain("autostash");
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a pull failure on a clone with uncommitted work preserves it", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const seedSha = lastSha(fixture);
    writeFile(join(clone, "concepts", "wip.md"), "---\ntitle: WIP\n---\n\nStill being written.\n");
    writeFileSync(join(clone, ".git", "index.lock"), "");

    addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("preserved");
    expect(existsSync(join(clone, "concepts", "wip.md"))).toBe(true);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a clone that never finished is replaced", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);

    const clone = makePartialClone(fixture);
    // The state the script has to read: no commit at HEAD, nothing in the tree.
    expect(() => git(clone, ["rev-parse", "--verify", "HEAD^{commit}"])).toThrow();
    expect(() => git(clone, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toThrow();
    expect(git(clone, ["status", "--porcelain"])).toBe("");

    const sha = addOncallPage(fixture);
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(git(clone, ["rev-parse", "HEAD"]).trim()).toBe(sha);
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
    expect(result.stdout).toContain("preserved");
    expect(existsSync(join(clone, "concepts", "draft.md"))).toBe(true);
    expect(calls(fixture)).toEqual([]);
    expect(lastSha(fixture)).toBe(seedSha);
  });

  test("a branch change in config re-clones onto the new branch", () => {
    const fixture = makeFixture();
    git(fixture.content, ["checkout", "-q", "-b", "release"]);
    writeFile(join(fixture.content, "concepts", "release-notes.md"), "---\ntitle: Release notes\n---\n\nWhat shipped.\n");
    const releaseSha = commit(fixture.content, "add the release notes page");
    git(fixture.content, ["checkout", "-q", "main"]);

    expect(runSync(fixture).exitCode).toBe(0);

    const clone = clonePath(fixture);
    const marker = markClone(fixture);
    writeConfig(fixture.plugin, fixture.content, "release");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(git(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("release");
    expect(git(clone, ["rev-parse", "HEAD"]).trim()).toBe(releaseSha);
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

  test("an ingest that never reaches the daemon leaves the watermark behind", () => {
    const fixture = makeFixture();
    expect(runSync(fixture).exitCode).toBe(0);
    const before = lastSha(fixture);

    addOncallPage(fixture);
    writeFileSync(fixture.deadFlag, "");
    resetCalls(fixture);

    const result = runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Could not connect to the assistant");
    expect(lastSha(fixture)).toBe(before);

    rmSync(fixture.deadFlag);
    resetCalls(fixture);

    const retried = runSync(fixture);

    expect(retried.exitCode).toBe(0);
    expect(lastSha(fixture)).not.toBe(before);
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
