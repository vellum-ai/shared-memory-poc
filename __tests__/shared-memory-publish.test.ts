import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
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
import { dirname, join, resolve } from "node:path";

import type { ToolContext } from "@vellumai/plugin-api";

import {
  createPolicyFingerprint,
  HARD_NON_PERSONAL_BASELINE,
  SHARING_GUIDANCE_RULE,
} from "../src/shared-memory-repository.js";
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
  author?: { name: string; email: string },
): void {
  writeFile(
    join(pluginDir, "config.json"),
    `${JSON.stringify(
      {
        repoUrl,
        branch,
        ...(sharingGuidance === undefined ? {} : { sharingGuidance }),
        ...(author === undefined ? {} : { author }),
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

function makeFixture(
  options: {
    branch?: string;
    objectFormat?: "sha1" | "sha256";
    sharingGuidance?: string;
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-publish-"));
  roots.push(root);
  const branch = options.branch ?? "main";

  const seed = join(root, "seed");
  initRepo(seed, options.objectFormat);
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
  expectedPolicyFingerprint = policyFingerprint(),
): Record<string, unknown> {
  return {
    expectedHead,
    expectedPolicyFingerprint,
    commitMessage: "Document shared release knowledge",
    upserts,
  };
}

function policyFingerprint(sharingGuidance: string | null = null): string {
  return createPolicyFingerprint({
    hardBaseline: HARD_NON_PERSONAL_BASELINE,
    sharingGuidance,
    guidanceRule: SHARING_GUIDANCE_RULE,
  });
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

function writePostIndexChangeHook(checkout: string, script: string): void {
  const hook = join(checkout, ".git", "hooks", "post-index-change");
  writeFile(hook, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
  chmodSync(hook, 0o755);
}

function configureCleanFilter(fixture: Fixture, name: string, script: string): void {
  const filter = join(fixture.root, `${name}-filter.sh`);
  writeFile(filter, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
  chmodSync(filter, 0o755);
  runGit(fixture.checkout, ["config", `filter.${name}.clean`, filter]);
  runGit(fixture.checkout, ["config", `filter.${name}.required`, "true"]);
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
    expect(publishTool.description).toContain("policyFingerprint");
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
        policyFingerprint: policyFingerprint(),
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
    expect(
      runGit(fixture.root, [
        "--git-dir",
        fixture.remote,
        "show",
        "-s",
        "--format=%an%n%ae%n%cn%n%ce",
        commitSha,
      ]).trim(),
    ).toBe("Fixture\nfixture@example.com\nVellum Assistant\nassistant@vellum.ai");
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toBe(updatedDeploy);
    expect(remoteFile(fixture, "concepts/architecture/event-routing.md")).toContain(
      "Route invalidations through the gateway.",
    );
    expect(runGit(fixture.checkout, ["rev-parse", "HEAD"]).trim()).toBe(commitSha);
    await expect(Bun.file(fixture.watermark).text()).resolves.toBe("ingested-head\n");
    expect(readdirSync(join(fixture.pluginDir, "data")).some((name) => name.startsWith("publish-index."))).toBe(false);
  });

  test("publishes from a SHA-256 repository using the inspected object ID", async () => {
    const fixture = makeFixture({ objectFormat: "sha256" });
    expect(fixture.expectedHead).toMatch(/^[0-9a-f]{64}$/);

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nSHA-256 update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(result.body.previousHead).toBe(fixture.expectedHead);
    expect(result.body.commitSha).toMatch(/^[0-9a-f]{64}$/);
    expect(remoteHead(fixture)).toBe(result.body.commitSha as string);
  });

  test("applies repository text normalization to published Markdown", async () => {
    const fixture = makeFixture();
    const attributes = advanceFromClone(
      fixture,
      "attribute-writer",
      ".gitattributes",
      "*.md text eol=lf\n",
    );
    const normalized = `${DEPLOY_CONTENT}\nNormalized update.\n`;
    const crlf = normalized.replaceAll("\n", "\r\n");

    const result = await publish(
      fixture,
      proposal(attributes.sha, [
        { path: "concepts/deploy-runbook.md", content: crlf },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(remoteFile(fixture, "concepts/deploy-runbook.md")).toBe(normalized);
    expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
  });

  test("ignores non-versioned global attributes while publishing", async () => {
    const fixture = makeFixture();
    const attributes = join(fixture.root, "global-attributes");
    writeFile(attributes, "concepts/global.md filter=global-override\n");
    configureCleanFilter(fixture, "global-override", "printf 'overridden\\n'");
    runGit(fixture.checkout, ["config", "core.attributesFile", attributes]);
    const content = `${DEPLOY_CONTENT}\nRepository content.\n`;

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        { path: "concepts/global.md", content },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(remoteFile(fixture, "concepts/global.md")).toBe(content);
  });

  test("ignores inherited command-scope attributes while publishing", async () => {
    const fixture = makeFixture();
    const attributes = join(fixture.root, "command-attributes");
    writeFile(attributes, "concepts/inherited.md filter=command-override\n");
    configureCleanFilter(fixture, "command-override", "printf 'overridden\\n'");
    const previousParameters = process.env.GIT_CONFIG_PARAMETERS;
    process.env.GIT_CONFIG_PARAMETERS = `'core.attributesFile'='${attributes}'`;
    const content = `${DEPLOY_CONTENT}\nRepository content.\n`;

    try {
      const result = await publish(
        fixture,
        proposal(fixture.expectedHead, [
          { path: "concepts/inherited.md", content },
        ]),
      );

      expect(result.reply.isError).toBe(false);
      expect(remoteFile(fixture, "concepts/inherited.md")).toBe(content);
    } finally {
      if (previousParameters === undefined) {
        delete process.env.GIT_CONFIG_PARAMETERS;
      } else {
        process.env.GIT_CONFIG_PARAMETERS = previousParameters;
      }
    }
  });

  test("rejects repository-local info attributes", async () => {
    const fixture = makeFixture();
    const infoAttributes = runGit(fixture.checkout, [
      "rev-parse",
      "--git-path",
      "info/attributes",
    ]).trim();
    writeFile(resolve(fixture.checkout, infoAttributes), "*.md -text\n");

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nRejected update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("REPOSITORY_MISMATCH");
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("rejects invalid Markdown produced by repository clean filters", async () => {
    const cases = [
      {
        name: "oversized",
        output: Buffer.alloc(70_000, "x"),
        script: "head -c 70000 /dev/zero | tr '\\000' x",
      },
      { name: "invalid-utf8", output: Buffer.from([0xff]), script: "printf '\\377'" },
      {
        name: "nul",
        output: Buffer.from("valid\0invalid\n"),
        script: "printf 'valid\\000invalid\\n'",
      },
      { name: "blank", output: Buffer.from("   \n"), script: "printf '   \\n'" },
    ];

    for (const testCase of cases) {
      const fixture = makeFixture();
      const attributes = advanceFromClone(
        fixture,
        `${testCase.name}-attribute-writer`,
        ".gitattributes",
        `*.md filter=${testCase.name}\n`,
      );
      configureCleanFilter(fixture, testCase.name, testCase.script);

      const result = await publish(
        fixture,
        proposal(attributes.sha, [
          {
            path: "concepts/deploy-runbook.md",
            content: `${DEPLOY_CONTENT}\nFiltered update.\n`,
          },
        ]),
      );

      expect(result.reply.isError).toBe(true);
      expect(errorCode(result.body)).toBe("CONTENT_LIMIT");
      expect(remoteHead(fixture)).toBe(attributes.sha);
      const rejected = join(fixture.root, `${testCase.name}-filtered.bin`);
      writeFileSync(rejected, testCase.output);
      const rejectedOid = runGit(fixture.checkout, [
        "hash-object",
        "--no-filters",
        rejected,
      ]).trim();
      expect(() => runGit(fixture.checkout, ["cat-file", "-e", rejectedOid])).toThrow();
      expect(
        readdirSync(join(fixture.pluginDir, "data")).some((name) =>
          name.startsWith("publish-objects."),
        ),
      ).toBe(false);
    }
  }, 15_000);

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

  test("rejects publication when the checkout has no configured Git author", async () => {
    const fixture = makeFixture();
    runGit(fixture.checkout, ["config", "user.name", ""]);
    runGit(fixture.checkout, ["config", "user.email", ""]);

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nMissing identity update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("GIT_IDENTITY_MISSING");
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("prefers the author block in config.json over Git config", async () => {
    const fixture = makeFixture();
    // The checkout carries a Git identity too; the config block must win, so
    // an inherited identity can never misattribute a publication.
    runGit(fixture.checkout, ["config", "user.name", "Wrong Identity"]);
    runGit(fixture.checkout, ["config", "user.email", "wrong@example.com"]);
    writeConfig(fixture.pluginDir, fixture.repoUrl, fixture.branch, undefined, {
      name: "Aaron Levin",
      email: "aaron@vellum.ai",
    });

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nConfig author update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(
      runGit(fixture.root, [
        "--git-dir",
        fixture.remote,
        "show",
        "-s",
        "--format=%an%n%ae%n%cn%n%ce",
        result.body.commitSha as string,
      ]).trim(),
    ).toBe("Aaron Levin\naaron@vellum.ai\nVellum Assistant\nassistant@vellum.ai");
  });

  test("rejects an author block that is not a plain identity", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.pluginDir, fixture.repoUrl, fixture.branch, undefined, {
      name: "Aaron <script>",
      email: "aaron@vellum.ai",
    });

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nInvalid author update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("CONFIG_ERROR");
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("honors author identity overrides from Git config", async () => {
    const fixture = makeFixture();
    runGit(fixture.checkout, ["config", "author.name", "Example User"]);
    runGit(fixture.checkout, ["config", "author.email", "user@example.com"]);

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nAuthor override update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(false);
    expect(
      runGit(fixture.root, [
        "--git-dir",
        fixture.remote,
        "show",
        "-s",
        "--format=%an%n%ae",
        result.body.commitSha as string,
      ]).trim(),
    ).toBe("Example User\nuser@example.com");
  });

  test("rejects a proposal when sharing guidance changed after inspection", async () => {
    const originalGuidance = "Share release runbooks only.";
    const fixture = makeFixture({ sharingGuidance: originalGuidance });
    writeConfig(
      fixture.pluginDir,
      fixture.repoUrl,
      fixture.branch,
      "Share architecture decisions only.",
    );

    const result = await publish(
      fixture,
      proposal(
        fixture.expectedHead,
        [
          {
            path: "concepts/deploy-runbook.md",
            content: `${DEPLOY_CONTENT}\nPolicy-stale update.\n`,
          },
        ],
        policyFingerprint(originalGuidance),
      ),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("STALE_POLICY");
    expect(JSON.stringify(result.body.effectivePolicy)).toContain(
      "Share architecture decisions only.",
    );
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("revalidates sharing guidance immediately before pushing", async () => {
    const originalGuidance = "Share release runbooks only.";
    const updatedGuidance = "Share architecture decisions only.";
    const fixture = makeFixture({ sharingGuidance: originalGuidance });
    const replacementDir = join(fixture.root, "replacement-config");
    const replacementConfig = join(replacementDir, "config.json");
    writeConfig(replacementDir, fixture.repoUrl, fixture.branch, updatedGuidance);
    writePostIndexChangeHook(
      fixture.checkout,
      `if [[ -f "${replacementConfig}" ]]; then mv "${replacementConfig}" "${join(fixture.pluginDir, "config.json")}"; fi`,
    );

    const result = await publish(
      fixture,
      proposal(
        fixture.expectedHead,
        [
          {
            path: "concepts/deploy-runbook.md",
            content: `${DEPLOY_CONTENT}\nPolicy-race update.\n`,
          },
        ],
        policyFingerprint(originalGuidance),
      ),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("STALE_POLICY");
    expect(JSON.stringify(result.body.effectivePolicy)).toContain(updatedGuidance);
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
  });

  test("revalidates the repository target immediately before pushing", async () => {
    const fixture = makeFixture();
    const replacementDir = join(fixture.root, "replacement-config");
    const replacementConfig = join(replacementDir, "config.json");
    writeConfig(replacementDir, `${fixture.repoUrl}-other`, fixture.branch);
    writePostIndexChangeHook(
      fixture.checkout,
      `if [[ -f "${replacementConfig}" ]]; then mv "${replacementConfig}" "${join(fixture.pluginDir, "config.json")}"; fi`,
    );

    const result = await publish(
      fixture,
      proposal(fixture.expectedHead, [
        {
          path: "concepts/deploy-runbook.md",
          content: `${DEPLOY_CONTENT}\nRepository-race update.\n`,
        },
      ]),
    );

    expect(result.reply.isError).toBe(true);
    expect(errorCode(result.body)).toBe("REPOSITORY_MISMATCH");
    expect(remoteHead(fixture)).toBe(fixture.expectedHead);
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
      ], policyFingerprint("Share release runbooks only.")),
    );
    const secondResult = await publish(
      second,
      proposal(fixture.expectedHead, [
        { path: "concepts/deploy-runbook.md", content: secondContent },
      ], policyFingerprint("Share release runbooks only.")),
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

  test("replaces an oversized existing page with compliant content", async () => {
    const fixture = makeFixture();
    const writer = advanceFromClone(
      fixture,
      "oversized-writer",
      "concepts/oversized.md",
      `# Oversized\n\n${"x".repeat(70_000)}\n`,
    );
    const replacement = "# Recovered page\n\nUse the bounded procedure.\n";

    const result = await publish(
      fixture,
      proposal(writer.sha, [{ path: "concepts/oversized.md", content: replacement }]),
    );

    expect(result.reply.isError).toBe(false);
    expect(remoteFile(fixture, "concepts/oversized.md")).toBe(replacement);
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
