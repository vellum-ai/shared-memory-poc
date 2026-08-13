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
// ingest was handed a staging directory of the expected shape, and fails when
// the failure flag file exists.
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

if [ "$mode" = "ingest" ]; then
  if [ -f "$dir/shared/deploy-runbook.md" ]; then
    printf 'staged\\n' >> "$SM_TEST_STAGE_LOG"
  else
    printf 'missing\\n' >> "$SM_TEST_STAGE_LOG"
  fi
  if [ -f "$SM_TEST_FAIL_INGEST" ]; then
    exit 3
  fi
fi

exit 0
`;

interface Fixture {
  root: string;
  content: string;
  plugin: string;
  script: string;
  bin: string;
  workdir: string;
  calls: string;
  stageLog: string;
  failFlag: string;
}

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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

function makeContentRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n\nA demo skill.\n");
  writeFile(
    join(root, "concepts", "deploy-runbook.md"),
    "---\ntitle: Deploy runbook\n---\n\nHow the team deploys.\n",
  );
  commit(root, "seed shared content");
}

function makeFixture(options: { config?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-sync-"));
  roots.push(root);

  const content = join(root, "content");
  makeContentRepo(content);

  const plugin = join(root, "plugins", "shared-memory");
  const script = join(plugin, "schedules", "sync", "index.sh");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(plugin, "data"), { recursive: true });
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);

  if (options.config !== false) {
    writeFileSync(
      join(plugin, "config.json"),
      `${JSON.stringify({ repoUrl: `file://${content}`, branch: "main" }, null, 2)}\n`,
    );
  }

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "assistant"), FAKE_ASSISTANT);
  chmodSync(join(bin, "assistant"), 0o755);

  const workdir = join(root, "workspace");
  mkdirSync(workdir);

  return {
    root,
    content,
    plugin,
    script,
    bin,
    workdir,
    calls: join(root, "calls.log"),
    stageLog: join(root, "stage.log"),
    failFlag: join(root, "fail-ingest"),
  };
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
    expect(existsSync(join(fixture.plugin, "data", "repo", ".git"))).toBe(true);

    const recorded = calls(fixture);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toBe("memory v2 reembed-skills");
    expect(recorded[1]).toMatch(/^memory ingest --dir \S+ --overwrite$/);
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
    expect(recorded[0]).toMatch(/^memory ingest --dir \S+ --overwrite$/);
    expect(lastSha(fixture)).toBe(sha);
  });

  test("a failed ingest leaves the watermark behind and the next run retries", () => {
    const before = lastSha(fixture);
    writeFile(join(fixture.content, "concepts", "oncall.md"), "---\ntitle: On-call\n---\n\nWho is on call.\n");
    const sha = commit(fixture.content, "add the on-call page");
    writeFileSync(fixture.failFlag, "");
    resetCalls(fixture);

    const failed = runSync(fixture);

    expect(failed.exitCode).not.toBe(0);
    expect(calls(fixture)).toHaveLength(1);
    expect(lastSha(fixture)).toBe(before);

    rmSync(fixture.failFlag);
    resetCalls(fixture);

    const retried = runSync(fixture);

    expect(retried.exitCode).toBe(0);
    const recorded = calls(fixture);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/^memory ingest --dir \S+ --overwrite$/);
    expect(lastSha(fixture)).toBe(sha);
  });
});

test("an unconfigured plugin exits quietly without cloning", () => {
  const fixture = makeFixture({ config: false });

  const result = runSync(fixture);

  expect(result.exitCode).toBe(0);
  expect(calls(fixture)).toEqual([]);
  expect(existsSync(join(fixture.plugin, "data", "repo"))).toBe(false);
  expect(lastSha(fixture)).toBeNull();
});

test("ingest is handed the concept pages nested under shared/", () => {
  const fixture = makeFixture();

  const result = runSync(fixture);

  expect(result.exitCode).toBe(0);
  expect(readLines(fixture.stageLog)).toEqual(["staged"]);
});
