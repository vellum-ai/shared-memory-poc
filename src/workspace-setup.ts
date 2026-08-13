/**
 * Filesystem preparation for a deployed install: keep the plugin directory
 * out of the workspace's git history, and point the assistant's skill catalog
 * at the content-repo clone.
 *
 * Everything here is synchronous, node-stdlib only, and safe to re-run.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export type GitExcludeResult = "added" | "present" | "no-repo";

export type UntrackResult = "untracked" | "not-tracked" | "no-repo" | "failed";

export type SkillsSymlinkResult = "created" | "ok" | "repaired" | "conflict";

/** Relative target of `<pluginDir>/skills`, resolved against the plugin dir. */
export const SKILLS_LINK_TARGET = "data/repo/skills";

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Whether the workspace keeps its own repo, as opposed to none or a worktree file. */
function hasGitDir(workspaceRoot: string): boolean {
  try {
    return statSync(join(workspaceRoot, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/** Runs git in `cwd` and reports whether it succeeded, never throwing. */
function runGit(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return { ok: false, stdout: "" };
  return { ok: true, stdout: result.stdout ?? "" };
}

/**
 * Ensure `<workspaceRoot>/.git/info/exclude` carries `line` exactly once.
 *
 * A workspace without a git repo is a supported install, so an absent `.git`
 * is reported rather than treated as a failure, and nothing is written.
 */
export function ensureGitExclude(
  workspaceRoot: string,
  line: string,
): GitExcludeResult {
  if (!hasGitDir(workspaceRoot)) return "no-repo";

  const excludePath = join(workspaceRoot, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  if (existing.split("\n").includes(line)) return "present";

  mkdirSync(join(workspaceRoot, ".git", "info"), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${separator}${line}\n`);
  return "added";
}

/**
 * Drop `<workspaceRoot>/<relPath>` from the workspace's index, leaving the
 * files on disk.
 *
 * An exclude line only hides untracked paths. A workspace whose daemon ran
 * `git add -A` before this plugin's first boot already has the install
 * committed, usually as a gitlink, and would re-dirty on every plugin update
 * until that entry leaves the index. Removing it stages a deletion the
 * daemon's next commit picks up.
 */
export function untrackPluginPath(
  workspaceRoot: string,
  relPath: string,
): UntrackResult {
  if (!hasGitDir(workspaceRoot)) return "no-repo";

  const listed = runGit(workspaceRoot, ["ls-files", "--", relPath]);
  if (!listed.ok) return "failed";
  if (listed.stdout.trim().length === 0) return "not-tracked";

  const removed = runGit(workspaceRoot, ["rm", "-r", "-q", "--cached", "--", relPath]);
  return removed.ok ? "untracked" : "failed";
}

/**
 * Ensure `<pluginDir>/skills` is a relative symlink to the clone's skills.
 *
 * The link is created before the clone exists. A dangling symlink is fine:
 * the skill catalog skips it and picks the skills up once the clone lands.
 */
export function ensureSkillsSymlink(pluginDir: string): SkillsSymlinkResult {
  const linkPath = join(pluginDir, "skills");

  let entry;
  try {
    entry = lstatSync(linkPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    symlinkSync(SKILLS_LINK_TARGET, linkPath);
    return "created";
  }

  if (!entry.isSymbolicLink()) return "conflict";
  if (readlinkSync(linkPath) === SKILLS_LINK_TARGET) return "ok";

  unlinkSync(linkPath);
  symlinkSync(SKILLS_LINK_TARGET, linkPath);
  return "repaired";
}
