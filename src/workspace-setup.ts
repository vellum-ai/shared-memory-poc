/**
 * Filesystem preparation for a deployed install: keep the runtime `data/`
 * directory out of the workspace's git history, and point the assistant's
 * skill catalog at the content-repo clone.
 *
 * Everything here is synchronous, node-stdlib only, and safe to re-run.
 */

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

export type SkillsSymlinkResult = "created" | "ok" | "repaired" | "conflict";

/** Relative target of `<pluginDir>/skills`, resolved against the plugin dir. */
export const SKILLS_LINK_TARGET = "data/repo/skills";

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
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
  const gitDir = join(workspaceRoot, ".git");
  try {
    if (!statSync(gitDir).isDirectory()) return "no-repo";
  } catch {
    return "no-repo";
  }

  const excludePath = join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  if (existing.split("\n").includes(line)) return "present";

  mkdirSync(join(gitDir, "info"), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${separator}${line}\n`);
  return "added";
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
    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(SKILLS_LINK_TARGET, linkPath);
    return "created";
  }

  if (!entry.isSymbolicLink()) return "conflict";
  if (readlinkSync(linkPath) === SKILLS_LINK_TARGET) return "ok";

  unlinkSync(linkPath);
  symlinkSync(SKILLS_LINK_TARGET, linkPath);
  return "repaired";
}
