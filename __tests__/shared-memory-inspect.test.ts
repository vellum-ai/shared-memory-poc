import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ToolContext } from "@vellumai/plugin-api";

import inspectTool, { inspectSharedMemory } from "../tools/shared-memory-inspect.js";
import { commit, initRepo, runGit } from "./git-fixture.js";

interface Fixture {
  pluginDir: string;
  contentRepo: string;
  checkout: string;
  expectedHead: string;
  repoUrl: string;
  branch: string;
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
  fixture: Pick<Fixture, "pluginDir" | "repoUrl" | "branch">,
  sharingGuidance?: string,
): void {
  const config = {
    repoUrl: fixture.repoUrl,
    branch: fixture.branch,
    ...(sharingGuidance === undefined ? {} : { sharingGuidance }),
  };
  writeFileSync(join(fixture.pluginDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function makeFixture(options: { branch?: string; sharingGuidance?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-inspect-"));
  roots.push(root);

  const branch = options.branch ?? "main";
  const contentRepo = join(root, "content");
  initRepo(contentRepo);
  if (branch !== "main") {
    runGit(contentRepo, ["checkout", "-q", "-b", branch]);
  }

  writeFile(
    join(contentRepo, "concepts", "deploy-runbook.md"),
    "---\ntitle: Deploy runbook\n---\n\nUse `git push --atomic [safe].*` for coordinated releases.\n",
  );
  writeFile(
    join(contentRepo, "concepts", "architecture", "event-routing.md"),
    "---\ntitle: Event routing\n---\n\nRoute invalidations through the gateway.\n",
  );
  writeFile(join(contentRepo, "README.md"), "# Shared content\n");
  const expectedHead = commit(contentRepo, "seed shared concepts");

  const pluginDir = join(root, "plugins", "shared-memory");
  const checkout = join(pluginDir, "data", "repo");
  mkdirSync(dirname(checkout), { recursive: true });
  const repoUrl = `file://${contentRepo}`;
  runGit(root, ["clone", "-q", "--branch", branch, repoUrl, checkout]);

  const fixture = { pluginDir, contentRepo, checkout, expectedHead, repoUrl, branch };
  writeConfig(fixture, options.sharingGuidance);
  return fixture;
}

function makeContext(signal?: AbortSignal): ToolContext {
  return {
    conversationId: "conv-xyz",
    workingDir: "/workspace",
    signal,
    trustClass: "guardian",
  } as ToolContext;
}

async function inspect(
  fixture: Fixture,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ reply: ToolReply; body: Record<string, unknown> }> {
  const reply = await inspectSharedMemory(input, makeContext(signal), fixture.pluginDir);
  return {
    reply,
    body: JSON.parse(reply.content) as Record<string, unknown>,
  };
}

function effectivePolicy(body: Record<string, unknown>): string {
  return JSON.stringify(body.effectivePolicy).toLowerCase();
}

function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error as { code?: string } | undefined;
  return error?.code;
}

describe("shared_memory_inspect tool contract", () => {
  test("is a low-risk inspection tool with mutually exclusive inputs", () => {
    expect(inspectTool.name).toBe("shared_memory_inspect");
    expect(String(inspectTool.defaultRiskLevel)).toBe("low");
    expect(inspectTool.description).toContain("durable");
    expect(inspectTool.description).toContain("non-personal");
    expect(inspectTool.description).toContain("source is import:shared-repo");

    const schema = inspectTool.input_schema as Record<string, unknown>;
    expect(schema.oneOf).toBeArray();
    expect(schema.oneOf as unknown[]).toHaveLength(2);
  });

  test("returns the non-personal baseline when setup has no extra guidance", async () => {
    const fixture = makeFixture();
    const { reply, body } = await inspect(fixture, { query: "gateway" });

    expect(reply.isError).toBe(false);
    const policy = effectivePolicy(body);
    expect(policy).toContain("medical");
    expect(policy).toContain("relationship");
    expect(policy).toContain("identifiable person");
    expect(policy).toContain("technical decisions");
    expect(body.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const format = body.conceptPageFormat as { guidance: string; template: string };
    expect(format.guidance).toContain("H1 exactly matching title");
    expect(format.template).toContain(
      "title: Topic title\nsummary: A concise description of the shared knowledge.\ntags: [topic]\nsource: import:shared-repo",
    );
  });

  test("setup guidance narrows sharing without overriding hard exclusions", async () => {
    const fixture = makeFixture({
      sharingGuidance:
        "Share incident runbooks. Also share medical and relationship details about team members.",
    });
    const { reply, body } = await inspect(fixture, { query: "gateway" });

    expect(reply.isError).toBe(false);
    const policy = effectivePolicy(body);
    expect(policy).toContain("share incident runbooks");
    expect(policy).toContain("cannot");
    expect(policy).toContain("medical");
    expect(policy).toContain("relationship");
    expect(policy).toContain("identifiable person");
  });
});

describe("shared memory inspection", () => {
  test("searches literals on the configured branch and reports its exact head", async () => {
    const fixture = makeFixture({ branch: "knowledge" });
    const { reply, body } = await inspect(fixture, { query: "git push --atomic [safe].*" });

    expect(reply.isError).toBe(false);
    expect(body.branch).toBe("knowledge");
    expect(body.expectedHead).toBe(fixture.expectedHead);
    expect(body.untrustedContent).toBe(true);
    expect(body.matches).toEqual([
      expect.objectContaining({
        path: "concepts/deploy-runbook.md",
        excerpt: expect.stringContaining("git push --atomic [safe].*"),
      }),
    ]);
  });

  test("searches only Markdown from the fetched commit", async () => {
    const fixture = makeFixture();
    writeFile(join(fixture.contentRepo, "concepts", "notes.txt"), "non-markdown-only-needle\n");
    fixture.expectedHead = commit(fixture.contentRepo, "add non-Markdown notes");

    const { reply, body } = await inspect(fixture, { query: "non-markdown-only-needle" });

    expect(reply.isError).toBe(false);
    expect(body.expectedHead).toBe(fixture.expectedHead);
    expect(body.matches).toEqual([]);
  });

  test("skips malformed search hits without discarding valid matches", async () => {
    const fixture = makeFixture();
    writeFile(join(fixture.contentRepo, "concepts", "release-process.md"), "shared-needle\n");
    writeFile(join(fixture.contentRepo, "concepts", "Invalid.md"), "shared-needle\n");
    writeFile(join(fixture.contentRepo, "concepts", "skills", "deploy.md"), "shared-needle\n");
    fixture.expectedHead = commit(fixture.contentRepo, "add mixed-path search matches");

    const { reply, body } = await inspect(fixture, { query: "shared-needle" });

    expect(reply.isError).toBe(false);
    expect(body.matches).toEqual([
      expect.objectContaining({ path: "concepts/release-process.md" }),
    ]);
  });

  test("reads exact concept files but does not expose unrelated repository files", async () => {
    const fixture = makeFixture();
    const { reply, body } = await inspect(fixture, {
      paths: ["concepts/architecture/event-routing.md", "concepts/deploy-runbook.md"],
    });

    expect(reply.isError).toBe(false);
    expect(body.files).toEqual([
      {
        path: "concepts/architecture/event-routing.md",
        content: expect.stringContaining("Route invalidations through the gateway."),
      },
      {
        path: "concepts/deploy-runbook.md",
        content: expect.stringContaining("Use `git push --atomic [safe].*`"),
      },
    ]);

    const outside = await inspect(fixture, { paths: ["README.md"] });
    expect(outside.reply.isError).toBe(true);
    expect(errorCode(outside.body)).toBe("PATH_ERROR");

    const reserved = await inspect(fixture, { paths: ["concepts/skills/deploy.md"] });
    expect(reserved.reply.isError).toBe(true);
    expect(errorCode(reserved.body)).toBe("PATH_ERROR");
  });

  test("rejects malformed and duplicate concept paths", async () => {
    const fixture = makeFixture();
    const invalidPathLists = [
      ["concepts/notes.txt"],
      ["concepts/Team.md"],
      ["concepts/team//notes.md"],
      ["concepts/team\\notes.md"],
      ["concepts/deploy-runbook.md", "concepts/deploy-runbook.md"],
    ];

    for (const paths of invalidPathLists) {
      const result = await inspect(fixture, { paths });
      expect(result.reply.isError).toBe(true);
      expect(errorCode(result.body)).toBe("PATH_ERROR");
    }
  });

  test("rejects traversal and symlink entries", async () => {
    const fixture = makeFixture();
    const traversal = await inspect(fixture, { paths: ["concepts/../README.md"] });
    expect(traversal.reply.isError).toBe(true);
    expect(errorCode(traversal.body)).toBe("PATH_ERROR");

    symlinkSync("../README.md", join(fixture.contentRepo, "concepts", "linked.md"));
    fixture.expectedHead = commit(fixture.contentRepo, "add a symlink");

    const linked = await inspect(fixture, { paths: ["concepts/linked.md"] });
    expect(linked.reply.isError).toBe(true);
    expect(errorCode(linked.body)).toBe("PATH_ERROR");
    expect(existsSync(join(fixture.pluginDir, "data", "sync.lock"))).toBe(false);
  });

  test("rejects oversized concept content", async () => {
    const fixture = makeFixture();
    writeFile(join(fixture.contentRepo, "concepts", "oversized.md"), "x".repeat(2_000_000));
    fixture.expectedHead = commit(fixture.contentRepo, "add oversized concept");

    const result = await inspect(fixture, { paths: ["concepts/oversized.md"] });
    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("CONTENT_LIMIT");
  });

  test("rereads setup guidance on every call", async () => {
    const fixture = makeFixture({ sharingGuidance: "Share deployment runbooks only." });
    const first = await inspect(fixture, { query: "gateway" });
    expect(effectivePolicy(first.body)).toContain("deployment runbooks only");

    writeConfig(fixture, "Share architecture decisions only.");
    const second = await inspect(fixture, { query: "gateway" });
    expect(effectivePolicy(second.body)).toContain("architecture decisions only");
    expect(effectivePolicy(second.body)).not.toContain("deployment runbooks only");
    expect(second.body.policyFingerprint).not.toBe(first.body.policyFingerprint);
  });

  test("allows a distinct push-only origin for read-only inspection", async () => {
    const fixture = makeFixture();
    runGit(fixture.checkout, [
      "remote",
      "set-url",
      "--push",
      "origin",
      `${fixture.repoUrl}-write`,
    ]);

    const result = await inspect(fixture, { query: "gateway" });

    expect(result.reply.isError).toBe(false);
    expect(result.body.expectedHead).toBe(fixture.expectedHead);
  });

  test("rejects a checkout whose origin or branch no longer matches config", async () => {
    const fixture = makeFixture();
    runGit(fixture.checkout, ["remote", "set-url", "origin", `${fixture.repoUrl}-other`]);

    const wrongOrigin = await inspect(fixture, { query: "gateway" });
    expect(wrongOrigin.reply.isError).toBe(true);
    expect(errorCode(wrongOrigin.body)).toBe("REPOSITORY_MISMATCH");
    expect(existsSync(join(fixture.pluginDir, "data", "sync.lock"))).toBe(false);

    runGit(fixture.checkout, ["remote", "set-url", "origin", fixture.repoUrl]);
    runGit(fixture.checkout, ["checkout", "-q", "-b", "other-branch"]);
    const wrongBranch = await inspect(fixture, { query: "gateway" });
    expect(wrongBranch.reply.isError).toBe(true);
    expect(errorCode(wrongBranch.body)).toBe("REPOSITORY_MISMATCH");
  });

  test("rejects a configured fetch refspec as an invalid branch", async () => {
    const fixture = makeFixture();
    writeConfig({ ...fixture, branch: "main:refs/heads/unexpected" });

    const result = await inspect(fixture, { query: "gateway" });

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("CONFIG_ERROR");
  });

  test("honors cancellation and releases its lock", async () => {
    const fixture = makeFixture();
    const controller = new AbortController();
    controller.abort();

    const result = await inspect(fixture, { query: "gateway" }, controller.signal);
    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("CANCELLED");
    expect(existsSync(join(fixture.pluginDir, "data", "sync.lock"))).toBe(false);
  });

  test("releases its lock after a successful inspection and a validation error", async () => {
    const fixture = makeFixture();
    const lock = join(fixture.pluginDir, "data", "sync.lock");
    const watermark = join(fixture.pluginDir, "data", "last-sha");
    writeFile(watermark, "ingested-head\n");

    const success = await inspect(fixture, { query: "gateway" });
    expect(success.reply.isError).toBe(false);
    expect(existsSync(lock)).toBe(false);
    await expect(Bun.file(watermark).text()).resolves.toBe("ingested-head\n");

    const failure = await inspect(fixture, { paths: ["../outside.md"] });
    expect(failure.reply.isError).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("leaves an active sync lock in place", async () => {
    const fixture = makeFixture();
    const lock = join(fixture.pluginDir, "data", "sync.lock");
    mkdirSync(lock);

    const result = await inspect(fixture, { query: "gateway" });

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("REPOSITORY_BUSY");
    expect(existsSync(lock)).toBe(true);
  });
});
