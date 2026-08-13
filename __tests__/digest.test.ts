import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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

import { initRepo, runGit } from "./git-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "schedules", "digest", "index.sh");

// Stands in for the assistant CLI: records every invocation on one line (the
// notification body spans several, so its newlines are flattened), keeps the
// last body and dedupe key where a test can read them, and answers a send with
// the same JSON summary the real command prints under --json. While the fail
// flag exists, a send reports failure the way the real router does.
const FAKE_ASSISTANT = `#!/usr/bin/env bash
{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> "$SM_TEST_CALLS"

prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ]; then
    printf '%s' "$arg" > "$SM_TEST_MESSAGE"
  fi
  if [ "$prev" = "--dedupe-key" ]; then
    printf '%s' "$arg" > "$SM_TEST_DEDUPE"
  fi
  prev="$arg"
done

if [ -f "\${SM_TEST_FAIL_SEND:-}" ]; then
  printf '{"ok":false,"error":"notification router unavailable"}\\n'
  exit 1
fi
printf '{"ok":true,"signalId":"sig-1","dispatched":true}\\n'
`;

interface Fixture {
  content: string;
  plugin: string;
  script: string;
  bin: string;
  workdir: string;
  calls: string;
  message: string;
  dedupe: string;
  failFlag: string;
}

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Commits everything in the content repo under the given author's name. */
function commitAs(repo: string, author: string, message: string): string {
  runGit(repo, ["add", "-A"]);
  runGit(repo, [
    "-c",
    `user.name=${author}`,
    "-c",
    `user.email=${author.toLowerCase().replace(/ /g, ".")}@example.com`,
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return runGit(repo, ["rev-parse", "HEAD"]).trim();
}

function makeFixture(options: { config?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-digest-"));
  roots.push(root);

  const content = join(root, "content");
  initRepo(content);
  writeFile(join(content, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n\nA demo skill.\n");
  writeFile(join(content, "concepts", "deploy-runbook.md"), "---\ntitle: Deploys\n---\n\nHow we deploy.\n");
  commitAs(content, "Seeder", "seed shared content");

  const plugin = join(root, "plugins", "shared-memory");
  const script = join(plugin, "schedules", "digest", "index.sh");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(plugin, "data"), { recursive: true });
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);

  if (options.config !== false) {
    writeConfig(plugin, { repoUrl: `file://${content}`, branch: "main" });
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
    message: join(root, "message.txt"),
    dedupe: join(root, "dedupe.txt"),
    failFlag: join(root, "fail-send"),
  };
}

function writeConfig(plugin: string, config: Record<string, unknown>): void {
  writeFileSync(join(plugin, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function dataPath(fixture: Fixture, ...parts: string[]): string {
  return join(fixture.plugin, "data", ...parts);
}

/**
 * What a completed sync leaves behind: the clone pulled up to the content
 * repo's head, and the sync watermark pointing at that commit.
 */
function syncClone(fixture: Fixture): string {
  const clone = dataPath(fixture, "repo");
  if (existsSync(join(clone, ".git"))) {
    runGit(clone, ["pull", "-q"]);
  } else {
    runGit(dirname(clone), ["clone", "-q", `file://${fixture.content}`, clone]);
  }
  const head = runGit(clone, ["rev-parse", "HEAD"]).trim();
  writeFileSync(dataPath(fixture, "last-sha"), `${head}\n`);
  return head;
}

function digestSha(fixture: Fixture): string | null {
  const path = dataPath(fixture, "digest-last-sha");
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").trim();
}

function calls(fixture: Fixture): string[] {
  if (!existsSync(fixture.calls)) {
    return [];
  }
  return readFileSync(fixture.calls, "utf8").split("\n").filter(Boolean);
}

function message(fixture: Fixture): string {
  return readFileSync(fixture.message, "utf8");
}

// Mirrors the engine: absolute script path, a cwd that is not the plugin
// directory, and a sanitized environment.
function runDigest(
  fixture: Fixture,
  ...args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", fixture.script, ...args], {
    cwd: fixture.workdir,
    env: {
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      SM_TEST_CALLS: fixture.calls,
      SM_TEST_MESSAGE: fixture.message,
      SM_TEST_DEDUPE: fixture.dedupe,
      SM_TEST_FAIL_SEND: fixture.failFlag,
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

describe("digest schedule", () => {
  test("an unconfigured install is a quiet no-op", () => {
    const fixture = makeFixture({ config: false });

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unconfigured, skipping");
    expect(calls(fixture)).toHaveLength(0);
  });

  test("nothing is reported before the first completed sync", () => {
    const fixture = makeFixture();

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no completed sync yet");
    expect(calls(fixture)).toHaveLength(0);
    expect(digestSha(fixture)).toBeNull();
  });

  test("a sync watermark the clone does not hold makes the digest wait", () => {
    const fixture = makeFixture();
    syncClone(fixture);
    writeFileSync(dataPath(fixture, "last-sha"), `${"f".repeat(40)}\n`);

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("waits for sync");
    expect(calls(fixture)).toHaveLength(0);
  });

  test("the first run baselines silently instead of announcing all history", () => {
    const fixture = makeFixture();
    const head = syncClone(fixture);

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("baselined");
    expect(calls(fixture)).toHaveLength(0);
    expect(digestSha(fixture)).toBe(head);
  });

  test("changes are notified once, grouped by author, and advance the watermark", () => {
    const fixture = makeFixture();
    syncClone(fixture);
    const start = syncClone(fixture);
    writeFileSync(dataPath(fixture, "digest-last-sha"), `${start}\n`);

    writeFile(join(fixture.content, "skills", "rollback", "SKILL.md"), "---\nname: rollback\n---\n\nHow to roll back.\n");
    writeFile(join(fixture.content, "concepts", "team", "oncall.md"), "---\ntitle: On-call\n---\n\nWho is on call.\n");
    commitAs(fixture.content, "Alice", "add the rollback skill and the on-call page");

    writeFile(join(fixture.content, "skills", "oncall-tools", "SKILL.md"), "---\nname: oncall-tools\n---\n\nPager tooling.\n");
    writeFile(join(fixture.content, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n\nA sharper demo skill.\n");
    commitAs(fixture.content, "Bob", "add oncall-tools, sharpen demo");

    rmSync(join(fixture.content, "concepts", "deploy-runbook.md"));
    commitAs(fixture.content, "Alice", "retire the deploy runbook");

    const end = syncClone(fixture);
    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    const recorded = calls(fixture);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("notifications send");
    expect(recorded[0]).toContain("--source-channel scheduler");
    expect(recorded[0]).toContain("--title Shared knowledge updates");
    // Without this hint the home feed never mirrors the send, so the Vellum
    // app shows nothing and the notification reaches connected clients only.
    expect(recorded[0]).toContain("--is-async-background");

    const body = message(fixture);
    expect(body).toContain("**5 updates** to the shared knowledge repo by 2 authors");
    // Shas are plumbing: they stay in the run log and out of the notification.
    expect(body).not.toContain(start.slice(0, 7));
    expect(body).not.toContain(end.slice(0, 7));
    expect(body).toContain("- **Alice**: added skill `rollback`; added page `team/oncall`; removed page `deploy-runbook`");
    expect(body).toContain("- **Bob**: added skill `oncall-tools`; updated skill `demo`");

    expect(readFileSync(fixture.dedupe, "utf8")).toBe(`shared-memory-digest:${start}:${end}`);
    expect(digestSha(fixture)).toBe(end);
  });

  test("a range with no changes stays silent and leaves the watermark", () => {
    const fixture = makeFixture();
    const head = syncClone(fixture);
    writeFileSync(dataPath(fixture, "digest-last-sha"), `${head}\n`);

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no shared knowledge changes");
    expect(calls(fixture)).toHaveLength(0);
    expect(digestSha(fixture)).toBe(head);
  });

  test("commits that touch neither skills nor pages advance the watermark silently", () => {
    const fixture = makeFixture();
    const start = syncClone(fixture);
    writeFileSync(dataPath(fixture, "digest-last-sha"), `${start}\n`);

    writeFile(join(fixture.content, "README.md"), "About this content repo.\n");
    commitAs(fixture.content, "Alice", "describe the repo");
    const end = syncClone(fixture);

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("touch no skills or pages");
    expect(calls(fixture)).toHaveLength(0);
    expect(digestSha(fixture)).toBe(end);
  });

  test("a digest watermark the clone does not hold re-baselines silently", () => {
    const fixture = makeFixture();
    const head = syncClone(fixture);
    writeFileSync(dataPath(fixture, "digest-last-sha"), `${"a".repeat(40)}\n`);

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("baselined");
    expect(calls(fixture)).toHaveLength(0);
    expect(digestSha(fixture)).toBe(head);
  });

  test("a failed send keeps the watermark so the next tick retries", () => {
    const fixture = makeFixture();
    const start = syncClone(fixture);
    writeFileSync(dataPath(fixture, "digest-last-sha"), `${start}\n`);
    writeFile(join(fixture.content, "skills", "extra", "SKILL.md"), "---\nname: extra\n---\n\nExtra.\n");
    commitAs(fixture.content, "Alice", "add the extra skill");
    syncClone(fixture);

    writeFileSync(fixture.failFlag, "");
    const result = runDigest(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("watermark unchanged");
    expect(digestSha(fixture)).toBe(start);
  });

  test("a renamed page is reported as an update of the new name", () => {
    const fixture = makeFixture();
    const start = syncClone(fixture);
    writeFileSync(dataPath(fixture, "digest-last-sha"), `${start}\n`);

    runGit(fixture.content, ["mv", "concepts/deploy-runbook.md", "concepts/release-runbook.md"]);
    commitAs(fixture.content, "Alice", "rename the deploy runbook");
    syncClone(fixture);

    const result = runDigest(fixture);

    expect(result.exitCode).toBe(0);
    expect(message(fixture)).toContain("- **Alice**: updated page `release-runbook`");
  });

  describe("llm mode", () => {
    let fixture: Fixture;
    let start: string;
    let end: string;

    beforeEach(() => {
      fixture = makeFixture();
      start = syncClone(fixture);
      writeConfig(fixture.plugin, {
        repoUrl: `file://${fixture.content}`,
        branch: "main",
        digest: { summary: "llm" },
      });
      writeFileSync(dataPath(fixture, "digest-last-sha"), `${start}\n`);
      writeFile(join(fixture.content, "skills", "triage", "SKILL.md"), "---\nname: triage\n---\n\nTriage.\n");
      commitAs(fixture.content, "Alice", "add the triage skill");
      end = syncClone(fixture);
    });

    test("the scripted tick stands down", () => {
      const result = runDigest(fixture);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("digest-llm schedule handles notifications");
      expect(calls(fixture)).toHaveLength(0);
      expect(digestSha(fixture)).toBe(start);
    });

    test("--collect prints the facts and mutates nothing", () => {
      const result = runDigest(fixture, "--collect");

      expect(result.exitCode).toBe(0);
      const facts = JSON.parse(result.stdout);
      expect(facts.status).toBe("changes");
      expect(facts.mode).toBe("llm");
      expect(facts.range).toEqual({ start, end });
      expect(facts.dedupeKey).toBe(`shared-memory-digest:${start}:${end}`);
      expect(facts.authors).toEqual([
        {
          author: "Alice",
          skills: { added: ["triage"], updated: [], removed: [] },
          pages: { added: [], updated: [], removed: [] },
        },
      ]);
      expect(facts.commits).toEqual([{ author: "Alice", subject: "add the triage skill" }]);
      expect(calls(fixture)).toHaveLength(0);
      expect(digestSha(fixture)).toBe(start);
    });

    test("--advance moves the watermark", () => {
      const result = runDigest(fixture, "--advance", end);

      expect(result.exitCode).toBe(0);
      expect(digestSha(fixture)).toBe(end);
    });
  });
});
