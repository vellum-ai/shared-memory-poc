import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import init from "../hooks/init.js";
import {
  ensureGitExclude,
  ensureSkillsSymlink,
  SKILLS_LINK_TARGET,
  untrackPluginPath,
} from "../src/workspace-setup.js";
import { commit, initRepo, runGit } from "./git-fixture.js";

const PLUGIN_REL_PATH = "plugins/shared-memory";
const EXCLUDE_LINE = `/${PLUGIN_REL_PATH}/`;

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initWorkspaceRepo(root: string): void {
  initRepo(root);
  // git's own template exclude file would blur the assertions about what the
  // hook writes into the exclude.
  rmSync(join(root, ".git", "info", "exclude"), { force: true });
}

/** Commits everything in the workspace the way its daemon's `git add -A` would. */
function autoCommit(root: string): void {
  commit(root, "workspace auto-commit");
}

function trackedPaths(root: string, relPath: string): string {
  return runGit(root, ["ls-files", "--", relPath]).trim();
}

function stagedChanges(root: string): string {
  return runGit(root, ["diff", "--cached", "--name-status"]).trim();
}

/** A workspace laid out the way a deployed install finds it. */
function makeWorkspace({ git = true }: { git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-"));
  workspaces.push(root);
  const pluginDir = join(root, PLUGIN_REL_PATH);
  const storageDir = join(pluginDir, "data");
  mkdirSync(storageDir, { recursive: true });
  if (git) initWorkspaceRepo(root);
  return { root, pluginDir, storageDir, excludePath: join(root, ".git", "info", "exclude") };
}

type LogCall = { level: string; obj: unknown; msg: string };

function makeContext(storageDir: string) {
  const calls: LogCall[] = [];
  const record =
    (level: string) =>
    (obj: unknown, msg?: string) => {
      calls.push({ level, obj, msg: msg ?? "" });
    };
  return {
    calls,
    ctx: {
      config: {},
      pluginStorageDir: storageDir,
      assistantVersion: "0.0.0-test",
      logger: {
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        debug: record("debug"),
      },
    },
  };
}

describe("ensureGitExclude", () => {
  test("adds the line once and leaves the file untouched on a re-run", () => {
    const { root, excludePath } = makeWorkspace();

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("added");
    const afterFirst = readFileSync(excludePath, "utf8");
    expect(afterFirst).toBe(`${EXCLUDE_LINE}\n`);

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("present");
    expect(readFileSync(excludePath, "utf8")).toBe(afterFirst);
  });

  test("appends to an existing exclude file without clobbering it", () => {
    const { root, excludePath } = makeWorkspace();
    const existing = "# git ls-files --others --exclude-from=.git/info/exclude\n.DS_Store\n";
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(excludePath, existing);

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("added");
    expect(readFileSync(excludePath, "utf8")).toBe(`${existing}${EXCLUDE_LINE}\n`);

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("present");
    const lines = readFileSync(excludePath, "utf8").split("\n");
    expect(lines.filter((line) => line === EXCLUDE_LINE)).toHaveLength(1);
  });

  test("adds a newline before the line when the file does not end in one", () => {
    const { root, excludePath } = makeWorkspace();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(excludePath, "build");

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("added");
    expect(readFileSync(excludePath, "utf8")).toBe(`build\n${EXCLUDE_LINE}\n`);
  });

  test("reports no-repo and writes nothing when the workspace has no .git", () => {
    const { root } = makeWorkspace({ git: false });

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("no-repo");
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  test("reports no-repo when .git is a file rather than a directory", () => {
    const { root } = makeWorkspace({ git: false });
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");

    expect(ensureGitExclude(root, EXCLUDE_LINE)).toBe("no-repo");
    expect(existsSync(join(root, ".git", "info"))).toBe(false);
  });
});

describe("untrackPluginPath", () => {
  test("drops committed files under the path and keeps them on disk", () => {
    const { root } = makeWorkspace();
    const state = join(root, PLUGIN_REL_PATH, "data", "state.json");
    writeFileSync(state, "{}\n");
    writeFileSync(join(root, "README.md"), "# workspace\n");
    autoCommit(root);
    expect(trackedPaths(root, PLUGIN_REL_PATH)).toBe(`${PLUGIN_REL_PATH}/data/state.json`);

    expect(untrackPluginPath(root, PLUGIN_REL_PATH)).toBe("untracked");

    expect(trackedPaths(root, PLUGIN_REL_PATH)).toBe("");
    expect(stagedChanges(root)).toBe(`D\t${PLUGIN_REL_PATH}/data/state.json`);
    expect(existsSync(state)).toBe(true);
    expect(trackedPaths(root, "README.md")).toBe("README.md");

    expect(untrackPluginPath(root, PLUGIN_REL_PATH)).toBe("not-tracked");
  });

  test("reports not-tracked and stages nothing when the path was never committed", () => {
    const { root } = makeWorkspace();
    writeFileSync(join(root, "README.md"), "# workspace\n");
    runGit(root, ["add", "README.md"]);
    runGit(root, ["commit", "-q", "-m", "seed"]);

    expect(untrackPluginPath(root, PLUGIN_REL_PATH)).toBe("not-tracked");
    expect(stagedChanges(root)).toBe("");
  });

  test("reports no-repo when the workspace has no .git", () => {
    const { root } = makeWorkspace({ git: false });

    expect(untrackPluginPath(root, PLUGIN_REL_PATH)).toBe("no-repo");
  });

  test("reports no-repo when .git is a file rather than a directory", () => {
    const { root } = makeWorkspace({ git: false });
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");

    expect(untrackPluginPath(root, PLUGIN_REL_PATH)).toBe("no-repo");
  });

  test("reports failed when .git is a directory but not a usable repo", () => {
    const { root } = makeWorkspace({ git: false });
    mkdirSync(join(root, ".git"));

    expect(untrackPluginPath(root, PLUGIN_REL_PATH)).toBe("failed");
  });

  test("reports failed instead of throwing when git is missing from PATH", () => {
    const { root } = makeWorkspace();
    const module = fileURLToPath(new URL("../src/workspace-setup.ts", import.meta.url));
    const program = [
      `const { untrackPluginPath } = await import(${JSON.stringify(module)});`,
      `console.log(untrackPluginPath(${JSON.stringify(root)}, ${JSON.stringify(PLUGIN_REL_PATH)}));`,
    ].join("\n");

    const result = Bun.spawnSync([process.execPath, "-e", program], {
      env: { PATH: join(root, "no-such-bin"), HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("failed");
  });
});

describe("ensureSkillsSymlink", () => {
  test("creates a relative link even though the clone does not exist yet", () => {
    const { pluginDir } = makeWorkspace();
    const linkPath = join(pluginDir, "skills");

    expect(ensureSkillsSymlink(pluginDir)).toBe("created");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(SKILLS_LINK_TARGET);
    expect(existsSync(linkPath)).toBe(false);

    expect(ensureSkillsSymlink(pluginDir)).toBe("ok");
    expect(readlinkSync(linkPath)).toBe(SKILLS_LINK_TARGET);
  });

  test("repairs a link that points somewhere else", () => {
    const { pluginDir } = makeWorkspace();
    const linkPath = join(pluginDir, "skills");
    symlinkSync("data/old-clone/skills", linkPath);

    expect(ensureSkillsSymlink(pluginDir)).toBe("repaired");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(SKILLS_LINK_TARGET);
  });

  test("leaves a real skills directory alone and reports a conflict", () => {
    const { pluginDir } = makeWorkspace();
    const skillsDir = join(pluginDir, "skills");
    const sentinel = join(skillsDir, "local", "SKILL.md");
    mkdirSync(join(skillsDir, "local"), { recursive: true });
    writeFileSync(sentinel, "# local skill\n");

    expect(ensureSkillsSymlink(pluginDir)).toBe("conflict");
    expect(lstatSync(skillsDir).isDirectory()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("# local skill\n");
  });

  test("reports a conflict for a plain file in the link's place", () => {
    const { pluginDir } = makeWorkspace();
    const linkPath = join(pluginDir, "skills");
    writeFileSync(linkPath, "not a link\n");

    expect(ensureSkillsSymlink(pluginDir)).toBe("conflict");
    expect(readFileSync(linkPath, "utf8")).toBe("not a link\n");
  });
});

describe("init hook", () => {
  test("prepares the workspace and is a no-op on the second boot", async () => {
    const { pluginDir, storageDir, excludePath } = makeWorkspace();
    const first = makeContext(storageDir);

    await init(first.ctx);

    expect(readFileSync(excludePath, "utf8")).toBe(`${EXCLUDE_LINE}\n`);
    expect(readlinkSync(join(pluginDir, "skills"))).toBe(SKILLS_LINK_TARGET);
    expect(first.calls.map((call) => call.level)).toEqual(["info", "info", "info"]);

    const second = makeContext(storageDir);
    await init(second.ctx);

    expect(readFileSync(excludePath, "utf8")).toBe(`${EXCLUDE_LINE}\n`);
    expect(readlinkSync(join(pluginDir, "skills"))).toBe(SKILLS_LINK_TARGET);
    expect(second.calls.map((call) => call.obj)).toEqual([
      expect.objectContaining({ result: "present" }),
      expect.objectContaining({ result: "not-tracked" }),
      expect.objectContaining({ result: "ok" }),
    ]);
  });

  test("untracks a plugin directory the workspace committed as a gitlink", async () => {
    const { root, pluginDir, storageDir } = makeWorkspace();
    initRepo(pluginDir);
    writeFileSync(join(pluginDir, "package.json"), "{}\n");
    commit(pluginDir, "install the plugin");
    autoCommit(root);
    expect(runGit(root, ["ls-files", "-s", "--", PLUGIN_REL_PATH])).toMatch(/^160000 /);

    const { calls, ctx } = makeContext(storageDir);
    await init(ctx);

    expect(trackedPaths(root, PLUGIN_REL_PATH)).toBe("");
    expect(stagedChanges(root)).toBe(`D\t${PLUGIN_REL_PATH}`);
    expect(calls.map((call) => call.obj)).toEqual([
      expect.objectContaining({ result: "added" }),
      expect.objectContaining({ result: "untracked" }),
      expect.objectContaining({ result: "created" }),
    ]);
  });

  test("warns without failing when the workspace index cannot be read", async () => {
    const { root, pluginDir, storageDir } = makeWorkspace({ git: false });
    mkdirSync(join(root, ".git"));
    const { calls, ctx } = makeContext(storageDir);

    await init(ctx);

    expect(calls.filter((call) => call.level === "warn")).toHaveLength(1);
    expect(calls.some((call) => call.level === "error")).toBe(false);
    expect(readlinkSync(join(pluginDir, "skills"))).toBe(SKILLS_LINK_TARGET);
  });

  test("warns instead of failing when a real skills directory is in the way", async () => {
    const { pluginDir, storageDir } = makeWorkspace();
    mkdirSync(join(pluginDir, "skills"));
    const { calls, ctx } = makeContext(storageDir);

    await init(ctx);

    const warning = calls.find((call) => call.level === "warn");
    expect(warning?.msg).toContain("skills/");
    expect(calls.some((call) => call.level === "error")).toBe(false);
  });

  test("logs and returns when the workspace exclude file cannot be written", async () => {
    // Running as root defeats the permission bits this test relies on.
    if (process.getuid?.() === 0) return;
    const { root, pluginDir, storageDir } = makeWorkspace();
    const infoDir = join(root, ".git", "info");
    mkdirSync(infoDir, { recursive: true });
    chmodSync(infoDir, 0o500);
    const { calls, ctx } = makeContext(storageDir);

    try {
      await init(ctx);
    } finally {
      chmodSync(infoDir, 0o700);
    }

    expect(calls.map((call) => call.level)).toEqual(["error"]);
    expect(() => lstatSync(join(pluginDir, "skills"))).toThrow();
  });
});
