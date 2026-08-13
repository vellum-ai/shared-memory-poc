/** Git helpers shared by the test files that build repo fixtures. */

import { execFileSync } from "node:child_process";

/**
 * Runs git in `cwd` and returns its stdout.
 *
 * stderr is captured rather than inherited so the hints git prints about
 * embedded repos, and the commands a test fails on purpose, stay out of the
 * test output.
 */
export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Gives a repo an author and no signing, so commits work on any machine. */
export function identify(repo: string): void {
  runGit(repo, ["config", "user.name", "Fixture"]);
  runGit(repo, ["config", "user.email", "fixture@example.com"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
}
