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

import init from "../hooks/init.js";
import {
  ensureGitExclude,
  ensureSkillsSymlink,
  SKILLS_LINK_TARGET,
} from "../src/workspace-setup.js";

const EXCLUDE_LINE = "/plugins/shared-memory/data/";

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A workspace laid out the way a deployed install finds it. */
function makeWorkspace({ git = true }: { git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-"));
  workspaces.push(root);
  const pluginDir = join(root, "plugins", "shared-memory");
  const storageDir = join(pluginDir, "data");
  mkdirSync(storageDir, { recursive: true });
  if (git) mkdirSync(join(root, ".git"), { recursive: true });
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
    rmSync(storageDir, { recursive: true });
    const first = makeContext(storageDir);

    await init(first.ctx);

    expect(lstatSync(storageDir).isDirectory()).toBe(true);
    expect(readFileSync(excludePath, "utf8")).toBe(`${EXCLUDE_LINE}\n`);
    expect(readlinkSync(join(pluginDir, "skills"))).toBe(SKILLS_LINK_TARGET);
    expect(first.calls.map((call) => call.level)).toEqual(["info", "info"]);

    const second = makeContext(storageDir);
    await init(second.ctx);

    expect(readFileSync(excludePath, "utf8")).toBe(`${EXCLUDE_LINE}\n`);
    expect(readlinkSync(join(pluginDir, "skills"))).toBe(SKILLS_LINK_TARGET);
    expect(second.calls.map((call) => call.obj)).toEqual([
      expect.objectContaining({ result: "present" }),
      expect.objectContaining({ result: "ok" }),
    ]);
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

  test("logs and returns when the plugin directory cannot be created", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-memory-"));
    workspaces.push(root);
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "a file where the workspace should be\n");
    const storageDir = join(blocked, "plugins", "shared-memory", "data");
    const { calls, ctx } = makeContext(storageDir);

    await init(ctx);

    expect(calls.map((call) => call.level)).toEqual(["error"]);
    expect(existsSync(storageDir)).toBe(false);
  });
});
