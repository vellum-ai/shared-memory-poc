import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ToolContext } from "@vellumai/plugin-api";

import publishTool, { executeSharedMemoryPublish } from "../tools/shared-memory-publish.js";
import { commit, identify, initRepo, runGit } from "./git-fixture.js";

const DEPLOY_CONTENT = "---\ntitle: Deploy runbook\n---\n\nUse the release checklist.\n";

interface Fixture {
  root: string;
  remote: string;
  pluginDir: string;
  checkout: string;
  repoUrl: string;
  branch: string;
  expectedHead: string;
  watermark: string;
}

interface ToolReply {
  content: string;
  isError: boolean;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeConfig(
  pluginDir: string,
  repoUrl: string,
  branch: string,
  sharingGuidance?: string,
): void {
  writeFile(
    join(pluginDir, "config.json"),
    `${JSON.stringify(
      {
        repoUrl,
        branch,
        ...(sharingGuidance === undefined ? {} : { sharingGuidance }),
      },
      null,
      2,
    )}\n`,
  );
}

function cloneInstall(
  fixture: Pick<Fixture, "root" | "remote" | "repoUrl" | "branch">,
  name: string,
  sharingGuidance?: string,
): Pick<Fixture, "pluginDir" | "checkout" | "watermark"> {
  const pluginDir = join(fixture.root, "plugins", name);
  const checkout = join(pluginDir, "data", "repo");
  mkdirSync(dirname(checkout), { recursive: true });
  runGit(fixture.root, [
    "clone",
    "-q",
    "--branch",
    fixture.branch,
    fixture.repoUrl,
    checkout,
  ]);
  identify(checkout);
  writeConfig(pluginDir, fixture.repoUrl, fixture.branch, sharingGuidance);
  const watermark = join(pluginDir, "data", "last-sha");
  writeFile(watermark, "ingested-head\n");
  return { pluginDir, checkout, watermark };
}

function makeFixture(options: { branch?: string; sharingGuidance?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-publish-"));
  roots.push(root);
  const branch = options.branch ?? "main";

  const seed = join(root, "seed");
  initRepo(seed);
  if (branch !== "main") {
    runGit(seed, ["checkout", "-q", "-b", branch]);
  }
  writeFile(join(seed, "concepts", "deploy-runbook.md"), DEPLOY_CONTENT);
  writeFile(join(seed, "README.md"), "# Shared content\n");
  const expectedHead = commit(seed, "seed shared concepts");

  const remote = join(root, "remote.git");
  runGit(root, ["clone", "-q", "--bare", seed, remote]);
  const repoUrl = `file://${remote}`;
  const install = cloneInstall({ root, remote, repoUrl, branch }, "shared-memory", options.sharingGuidance);
  return {
    root,
    remote,
    repoUrl,
    branch,
    expectedHead,
    ...install,
  };
}

function makeContext(signal?: AbortSignal): ToolContext {
  return {
    conversationId: "conv-xyz",
    workingDir: "/workspace",
    signal,
    trustClass: "guardian",
  } as ToolContext;
}

async function publish(
  fixture: Pick<Fixture, "pluginDir">,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ reply: ToolReply; body: Record<string, unknown> }> {
  const reply = await executeSharedMemoryPublish(input, makeContext(signal), fixture.pluginDir);
  return { reply, body: JSON.parse(reply.content) as Record<string, unknown> };
}

function proposal(
  expectedHead: string,
  upserts: Array<{ path: string; content: string }>,
): Record<string, unknown> {
  return {
    expectedHead,
    commitMessage: "Document shared release knowledge",
    upserts,
  };
}

function remoteHead(fixture: Fixture): string {
  return runGit(fixture.root, [
    "--git-dir",
    fixture.remote,
    "rev-parse",
    `refs/heads/${fixture.branch}`,
  ]).trim();
}

function remoteFile(fixture: Fixture, path: string): string {
  return runGit(fixture.root, [
    "--git-dir",
    fixture.remote,
    "show",
    `${fixture.branch}:${path}`,
  ]);
}

function errorCode(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

function writePrePushHook(checkout: string, script: string): void {
  const hook = join(checkout, ".git", "hooks", "pre-push");
  writeFile(hook, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
  chmodSync(hook, 0o755);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function advanceFromClone(
  fixture: Fixture,
  name: string,
  path: string,
  content: string,
): { clone: string; sha: string } {
  const clone = join(fixture.root, name);
  runGit(fixture.root, ["clone", "-q", "--branch", fixture.branch, fixture.repoUrl, clone]);
  identify(clone);
  writeFile(join(clone, path), content);
  const sha = commit(clone, `advance ${name}`);
  runGit(clone, ["push", "-q", "origin", `HEAD:${fixture.branch}`]);
  return { clone, sha };
}

describe("shared_memory_publish tool contract", () => {
  test("is an exclusive medium-risk publisher with the non-personal policy", () => {
    expect(publishTool.name).toBe("shared_memory_publish");
    expect(String(publishTool.defaultRiskLevel)).toBe("medium");
    expect(publishTool.exclusive).toBe(true);
    expect(publishTool.description).toContain("shared_memory_inspect");
    expect(publishTool.description).toContain("medical");
    expect(publishTool.description).toContain("relationship");
    expect(publishTool.description).toContain("identifiable person");
    expect(publishTool.description).toContain("Deletions are not supported");
  });
});

describe("atomic shared memory publishing", () => {
  test("publishes multiple upserts as one commit and leaves the watermark unchanged", async () => {
    const fixture = makeFixture({ branch: "knowledge" });
    const updatedDeploy = `${DEPLOY_CONTENT}\nRollback through the same checklist.\n`;
    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: updatedDeploy },
        {
          path: "concepts/architecture/event-routing.md",
          content: "---\ntitle: Event routing\n---\n\nRoute invalidations through the gateway.\n",
        },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(result.body).toEqual(
      expect.objectContaining({
        branch: "knowledge",
        previousHead: fixture.expectedHead,
        changedPaths: [
          "concepts/architecture/event-routing.md",
          "concepts/deploy-runbook.md",
        ],
        noop: false,
        checkoutUpdated: true,
      }),
    );
    const commitSha = result.body.commitSha as string;
    expect(remoteHead(fixture)).toBe(commitSha);
    expect(
      runGit(fixture.root, ["--git-dir", fixture.remote, "rev-parse", `${commitSha}^`]).trim(),
    ).toBe(fixture.expectedHead);
    expect(
      runGit(fixture.root, [
        "--git-dir",
        fixture.remote,
        "rev-list",
        "--count",
        `${fixture.expectedHead}..${commitSha}`,
      ]).trim(),
    ).toBe("1");
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toBe(updatedDeploy);
    expect(remoteFile(fixture, "concepts/architecture/event-routing.md")).toContain(
      "Route invalidations through the gateway.",
    );
    expect(runGit(fixture.checkout, ["rev-parse", "HEAD"]).trim()).toBe(commitSha);
    await expect(Bun.file(fixture.watermark).text()).resolves.toBe("ingested-head\n");
    expect(readdirSync(join(fixture.pluginDir, "data")).some((name) => name.startsWith("publish-index."))).toBe(false);
  });

  test("returns a no-op without creating a commit when content already matches", async () => {
    const fixture = makeFixture();
    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: DEPLOY_CONTENT },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(result.body).toEqual(
      expect.objectContaining({
        previousHead: fixture.expectedHead,
        changedPaths: [],
        noop: true,
      }),
    );
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
    expect(result.body.commitSha).toBeUndefined();
  });

  test("prevents two assistants inspected at the same head from overwriting each other", async () => {
    const fixture = makeFixture({ sharingGuidance: "Share release runbooks only." });
    const second = cloneInstall(fixture, "shared-memory-second", "Share release runbooks only.");
    const firstContent = `${DEPLOY_CONTENT}\nFirst assistant update.\n`;
    const secondContent = `${DEPLOY_CONTENT}\nSecond assistant update.\n`;

    const first = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: firstContent },
      ]),
    );
    const secondResult = await publish(
      second,
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: secondContent },
      ]),
    );

    expect(first.reply.isError).toBe(false);
    expect(secondResult.reply.isError).toBe(true);
    expect(errorCode(secondResult.body)).toBe("STALE_HEAD");
    expect(secondResult.body.observedHead).toBe(first.body.commitSha);
    expect(JSON.stringify(secondResult.body.effectivePolicy)).toContain("Share release runbooks only.");
    expect(JSON.stringify(secondResult.body.effectivePolicy)).toContain("medical");
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toBe(firstContent);
    expect(runGit(second.checkout, ["rev-parse", "HEAD"]).trim()).toBe(fixture.expectedHead);
  });

  test("a writer that loses after the final head check receives a stale-head result", async () => {
    const fixture = makeFixture();
    const racer = advanceFromClone(
      fixture,
      "racer",
      "concepts/deploy-runbook.md",
      `${DEPLOY_CONTENT}\nRacer update.\n`,
    );
    runGit(fixture.root, [
      "--git-dir",
      fixture.remote,
      "update-ref",
      `refs/heads/${fixture.branch}`,
      fixture.expectedHead,
      racer.sha,
    ]);
    writePrePushHook(
      fixture.checkout,
      `git --git-dir="${fixture.remote}" update-ref "refs/heads/${fixture.branch}" "${racer.sha}" "${fixture.expectedHead}"`,
    );

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: `${DEPLOY_CONTENT}\nLate update.\n` },
      ]),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("STALE_HEAD");
    expect(result.body.observedHead).toBe(racer.sha);
    expect(result.body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(remoteHead(fixture)).toBe(racer.sha);
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toContain("Racer update.");
  });

  test("verifies an ambiguous failed push when the remote contains the commit", async () => {
    const fixture = makeFixture();
    writePrePushHook(
      fixture.checkout,
      `read -r _ local_sha _ _\ngit push --no-verify -q "${fixture.repoUrl}" "${"$"}{local_sha}:refs/heads/${fixture.branch}"\nexit 1`,
    );

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nAmbiguous push update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(result.body.noop).toBe(false);
    expect(remoteHead(fixture)).toBe(result.body.commitSha as string);
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toContain(
      "Ambiguous push update.",
    );
  });

  test("verifies an interrupted push that reached the remote", async () => {
    const fixture = makeFixture();
    const pushed = join(fixture.root, "push-complete");
    const release = join(fixture.root, "release-hook");
    writePrePushHook(
      fixture.checkout,
      `read -r _ local_sha _ _\ngit push --no-verify -q "${fixture.repoUrl}" "${"$"}{local_sha}:refs/heads/${fixture.branch}"\ntouch "${pushed}"\nwhile [[ ! -f "${release}" ]]; do sleep 0.05; done\nexit 1`,
    );
    const controller = new AbortController();
    const pending = publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nInterrupted push update.\n`,
        },
      ]),
      controller.signal,
    );

    await waitForFile(pushed);
    controller.abort();
    writeFile(release, "release\n");
    const result = await pending;

    expect(result.reply.isError).toBe(false);
    expect(remoteHead(fixture)).toBe(result.body.commitSha as string);
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toContain(
      "Interrupted push update.",
    );
  });

  test("reports an interrupted push with an unknown outcome and commit SHA", async () => {
    const fixture = makeFixture();
    const started = join(fixture.root, "push-started");
    const release = join(fixture.root, "release-hook");
    writePrePushHook(
      fixture.checkout,
      `touch "${started}"\nwhile [[ ! -f "${release}" ]]; do sleep 0.05; done\nexit 1`,
    );
    const controller = new AbortController();
    const pending = publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nCancelled push update.\n`,
        },
      ]),
      controller.signal,
    );

    await waitForFile(started);
    controller.abort();
    writeFile(release, "release\n");
    const result = await pending;

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("PUSH_UNKNOWN");
    expect(result.body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.body.observedHead).toBe(fixture.expectedHead);
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("rejects invalid paths, duplicates, and oversized content before publication", async () => {
    const fixture = makeFixture();
    const attempts = [
      proposal(fixture.expectedHead, [{ path: "README.md", content: "# No\n" }]),
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: "# One\n" },
        { path: "concepts/deploy-runbook.md", content: "# Two\n" },
      ]),
      proposal(fixture.expectedHead, [
        { path: "concepts/oversized.md", content: "x".repeat(70_000) },
      ]),
    ];

    for (const attempt of attempts) {
      const result = await publish(fixture, attempt);
      expect(result.reply.isError).toBe(true);
    }
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("rejects an existing symlink path", async () => {
    const fixture = makeFixture();
    const writer = join(fixture.root, "symlink-writer");
    runGit(fixture.root, ["clone", "-q", fixture.repoUrl, writer]);
    identify(writer);
    symlinkSync("../README.md", join(writer, "concepts", "linked.md"));
    const symlinkHead = commit(writer, "add shared symlink");
    runGit(writer, ["push", "-q", "origin", `HEAD:${fixture.branch}`]);

    const result = await publish(
      fixture,
      proposal(symlinkHead, [{ path: "concepts/linked.md", content: "# Replacement\n" }]),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("PATH_ERROR");
    expect(remoteHead(fixture)).toBe(symlinkHead);
  });

  test("fails closed for dirty state, origin mismatches, and an active lock", async () => {
    const dirty = makeFixture();
    writeFile(join(dirty.checkout, "local-note.txt"), "local work\n");
    const dirtyResult = await publish(
      dirty,
      proposal(dirty.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: `${DEPLOY_CONTENT}\nUpdate.\n` },
      ]),
    );
    expect(errorCode(dirtyResult.body)).toBe("REPOSITORY_DIRTY");
    expect(existsSync(join(dirty.pluginDir, "data", "sync.lock"))).toBe(false);

    const mismatch = makeFixture();
    runGit(mismatch.checkout, ["remote", "set-url", "origin", `${mismatch.repoUrl}-other`]);
    const mismatchResult = await publish(
      mismatch,
      proposal(mismatch.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: `${DEPLOY_CONTENT}\nUpdate.\n` },
      ]),
    );
    expect(errorCode(mismatchResult.body)).toBe("REPOSITORY_MISMATCH");

    const pushMismatch = makeFixture();
    runGit(pushMismatch.checkout, [
      "remote",
      "set-url",
      "--push",
      "origin",
      `${pushMismatch.repoUrl}-other`,
    ]);
    const pushMismatchResult = await publish(
      pushMismatch,
      proposal(pushMismatch.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: `${DEPLOY_CONTENT}\nUpdate.\n` },
      ]),
    );
    expect(errorCode(pushMismatchResult.body)).toBe("REPOSITORY_MISMATCH");

    const pushRewrite = makeFixture();
    runGit(pushRewrite.checkout, [
      "config",
      `url.${pushRewrite.repoUrl}-other.pushInsteadOf`,
      pushRewrite.repoUrl,
    ]);
    const pushRewriteResult = await publish(
      pushRewrite,
      proposal(pushRewrite.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: `${DEPLOY_CONTENT}\nUpdate.\n` },
      ]),
    );
    expect(errorCode(pushRewriteResult.body)).toBe("REPOSITORY_MISMATCH");

    const busy = makeFixture();
    const lock = join(busy.pluginDir, "data", "sync.lock");
    mkdirSync(lock);
    const busyResult = await publish(
      busy,
      proposal(busy.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: `${DEPLOY_CONTENT}\nUpdate.\n` },
      ]),
    );
    expect(errorCode(busyResult.body)).toBe("REPOSITORY_BUSY");
    expect(existsSync(lock)).toBe(true);
  });
});
