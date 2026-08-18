import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Registers the module fake, so it must be imported before anything that pulls
// the plugin API in. See the file itself for why the fake is shared.
import { pluginApiFake } from "./plugin-api-fake.js";

import { readSetupStatus } from "../src/setup/status.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "sm-setup-status-"));
  roots.push(pluginDir);
  pluginApiFake.reset();
});

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(pluginDir, "config.json"), JSON.stringify(config));
}

/** Stands in for a clone sync would have left, with the origin git records. */
function writeClone(originUrl: string): void {
  const gitConfig = join(pluginDir, "data", "repo", ".git", "config");
  mkdirSync(dirname(gitConfig), { recursive: true });
  writeFileSync(gitConfig, `[remote "origin"]\n\turl = ${originUrl}\n`);
}

function writeWatermark(name: string, value: string): void {
  const path = join(pluginDir, "data", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function step(status: Awaited<ReturnType<typeof readSetupStatus>>, id: string) {
  const found = status.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} step`);
  return found;
}

describe("readSetupStatus", () => {
  test("a fresh install is incomplete and starts at the repository step", async () => {
    const status = await readSetupStatus(pluginDir);

    expect(status.complete).toBe(false);
    expect(status.repoUrl).toBeNull();
    expect(step(status, "repository").state).toBe("pending");
  });

  test("defaults the branch to main when the config omits it", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    expect((await readSetupStatus(pluginDir)).branch).toBe("main");
  });

  // A blank URL is normalized to "no repository" upstream, so it reports as
  // not-started. Blocked is reserved for a value that is present and unusable —
  // which is only what `readRepositoryConfig` also refuses.
  test("reports a blank URL as not started rather than blocked", async () => {
    writeConfig({ repoUrl: "   " });
    const status = await readSetupStatus(pluginDir);

    expect(status.repoUrl).toBeNull();
    expect(step(status, "repository").state).toBe("pending");
  });

  test.each([
    [`https://github.com/acme/${"n".repeat(2_100)}.git`, "past the length the reader accepts"],
    ["https://github.com/acme/k\0.git", "carrying a NUL byte"],
  ])("blocks the repository step on a URL %s", async (repoUrl) => {
    writeConfig({ repoUrl, author: { name: "Alex", email: "alex@example.com" } });
    const status = await readSetupStatus(pluginDir);

    expect(step(status, "repository").state).toBe("blocked");
    expect(status.complete).toBe(false);
  });

  /**
   * The QA runbook installs against a `file://` fixture repo, and a local
   * remote needs no credential from the plugin. Blocking it, or holding it at
   * an access step with no action on it, would break a documented setup.
   */
  test("lets a file:// repository through without asking for a credential", async () => {
    writeConfig({
      repoUrl: "file:///tmp/shared-content-fixture",
      author: { name: "Alex", email: "alex@example.com" },
    });
    const status = await readSetupStatus(pluginDir);

    expect(step(status, "repository").state).toBe("done");
    expect(step(status, "access").state).toBe("done");
    expect(status.tokenStored).toBe(false);
    expect(status.complete).toBe(true);
  });

  test("does the same for a bare local path", async () => {
    writeConfig({
      repoUrl: "/srv/git/knowledge.git",
      author: { name: "Alex", email: "alex@example.com" },
    });

    expect((await readSetupStatus(pluginDir)).complete).toBe(true);
  });

  test("an https remote needs a token before access is done", async () => {
    writeConfig({
      repoUrl: "https://github.com/acme/k.git",
      author: { name: "Alex", email: "alex@example.com" },
    });
    const status = await readSetupStatus(pluginDir);

    expect(status.tokenStored).toBe(false);
    expect(step(status, "access").state).toBe("pending");
    expect(status.complete).toBe(false);
  });

  test("an https remote with a stored token completes setup", async () => {
    pluginApiFake.setToken("github_pat_example");
    writeConfig({
      repoUrl: "https://github.com/acme/k.git",
      author: { name: "Alex", email: "alex@example.com" },
    });
    const status = await readSetupStatus(pluginDir);

    expect(status.tokenStored).toBe(true);
    expect(step(status, "access").state).toBe("done");
    expect(status.complete).toBe(true);
  });

  // Setup completing is about being able to sync, not about having synced.
  // Blocking on the sync step would hold the user at a screen with no action.
  test("completes without a sync having run", async () => {
    pluginApiFake.setToken("github_pat_example");
    writeConfig({
      repoUrl: "https://github.com/acme/k.git",
      author: { name: "Alex", email: "alex@example.com" },
    });
    const status = await readSetupStatus(pluginDir);

    expect(status.syncedHead).toBeNull();
    expect(step(status, "sync").state).toBe("pending");
    expect(status.complete).toBe(true);
  });

  test("reports a sync once a watermark exists", async () => {
    writeConfig({ repoUrl: "git@github.com:acme/k.git" });
    writeClone("git@github.com:acme/k.git");
    writeWatermark("last-sha", "a".repeat(40));

    const status = await readSetupStatus(pluginDir);
    expect(status.syncedHead).toBe("a".repeat(40));
    expect(step(status, "sync").state).toBe("done");
  });

  // An SSH clone that exists is the only proof available that the key works;
  // nothing in the app can inspect the key itself.
  test("an SSH remote with a matching clone counts as authenticated", async () => {
    writeConfig({
      repoUrl: "git@github.com:acme/k.git",
      author: { name: "Alex", email: "alex@example.com" },
    });
    writeClone("git@github.com:acme/k.git");

    const status = await readSetupStatus(pluginDir);
    expect(step(status, "access").state).toBe("done");
    expect(status.complete).toBe(true);
  });

  test("an SSH remote with no clone is blocked and offered an https switch", async () => {
    writeConfig({
      repoUrl: "git@github.com:acme/k.git",
      author: { name: "Alex", email: "alex@example.com" },
    });

    const status = await readSetupStatus(pluginDir);
    expect(step(status, "access").state).toBe("blocked");
    expect(status.httpsAlternative).toBe("https://github.com/acme/k.git");
    expect(status.complete).toBe(false);
  });

  // A clone left over from a previous repoUrl proves nothing about the new one.
  test("an SSH remote whose clone points elsewhere is still blocked", async () => {
    writeConfig({ repoUrl: "git@github.com:acme/new.git" });
    writeClone("git@github.com:acme/old.git");

    expect(step(await readSetupStatus(pluginDir), "access").state).toBe("blocked");
  });

  // The token is scoped to this plugin's own field, so an SSH install never
  // reads one and never reports one.
  test("does not report a token for an SSH remote", async () => {
    pluginApiFake.setToken("github_pat_example");
    writeConfig({ repoUrl: "git@github.com:acme/k.git" });

    expect((await readSetupStatus(pluginDir)).tokenStored).toBe(false);
  });

  test("an author is required before setup completes", async () => {
    pluginApiFake.setToken("github_pat_example");
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });

    const status = await readSetupStatus(pluginDir);
    expect(step(status, "identity").state).toBe("pending");
    expect(status.complete).toBe(false);
  });

  test.each([
    [{ name: "Alex" }, "an author missing an email"],
    [{ name: "", email: "alex@example.com" }, "an author with a blank name"],
    ["Alex Chen", "an author that is not an object"],
  ])("treats %o as no author (%s)", async (author) => {
    pluginApiFake.setToken("github_pat_example");
    writeConfig({ repoUrl: "https://github.com/acme/k.git", author });

    const status = await readSetupStatus(pluginDir);
    expect(status.author).toBeNull();
    expect(status.complete).toBe(false);
  });

  test("exposes the repo path the token check needs", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    expect((await readSetupStatus(pluginDir)).repoPath).toBe("acme/k");
  });
});
