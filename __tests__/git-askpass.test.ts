import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASKPASS = join(REPO_ROOT, "bin", "git-askpass.sh");

/**
 * Stands in for the assistant CLI. `SM_TEST_REVEAL` holds the exact stdout the
 * real `credentials reveal --json` would print, so a test can reproduce a
 * healthy daemon, a failed lookup, or a daemon that is down.
 */
const FAKE_ASSISTANT = `#!/usr/bin/env bash
cat "$SM_TEST_REVEAL"
exit "\${SM_TEST_EXIT:-0}"
`;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

let bin: string;
let revealFile: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "sm-askpass-"));
  roots.push(root);
  bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "assistant"), FAKE_ASSISTANT);
  chmodSync(join(bin, "assistant"), 0o755);
  revealFile = join(root, "reveal.json");
  writeFileSync(revealFile, "");
});

interface Run {
  stdout: string;
  exitCode: number;
}

async function askpass(prompt: string, env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([ASKPASS, prompt], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SM_TEST_REVEAL: revealFile,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { stdout, exitCode };
}

describe("git-askpass.sh", () => {
  test("answers the username prompt without consulting the vault", async () => {
    const result = await askpass("Username for 'https://github.com': ");
    expect(result.stdout.trim()).toBe("x-access-token");
    expect(result.exitCode).toBe(0);
  });

  test("answers the password prompt with the stored token", async () => {
    writeFileSync(revealFile, '{"ok":true,"value":"github_pat_example"}\n');
    const result = await askpass("Password for 'https://x-access-token@github.com': ");
    expect(result.stdout.trim()).toBe("github_pat_example");
    expect(result.exitCode).toBe(0);
  });

  /**
   * The reason the helper parses JSON rather than reading the bare human form:
   * a daemon that is down prints a diagnostic, and git would otherwise hand
   * that prose to GitHub as a password.
   */
  test("answers nothing when the daemon is unreachable", async () => {
    writeFileSync(
      revealFile,
      '{"ok":false,"error":"Could not connect to the assistant at /tmp/assistant.sock."}\n',
    );
    const result = await askpass("Password for 'https://github.com': ");
    expect(result.stdout.trim()).toBe("");
  });

  test("answers nothing when the CLI prints nothing at all", async () => {
    const result = await askpass("Password for 'https://github.com': ", { SM_TEST_EXIT: "1" });
    expect(result.stdout.trim()).toBe("");
  });

  test("answers nothing when the CLI prints something that is not JSON", async () => {
    writeFileSync(revealFile, "command not found\n");
    const result = await askpass("Password for 'https://github.com': ");
    expect(result.stdout.trim()).toBe("");
  });

  test("answers nothing when the value is not a string", async () => {
    writeFileSync(revealFile, '{"ok":true,"value":null}\n');
    const result = await askpass("Password for 'https://github.com': ");
    expect(result.stdout.trim()).toBe("");
  });

  // Answering an unrecognized prompt with the token would hand it to whatever
  // asked, so the helper declines instead of guessing.
  test("refuses a prompt it does not recognize", async () => {
    writeFileSync(revealFile, '{"ok":true,"value":"github_pat_example"}\n');
    const result = await askpass("Enter passphrase for key '/home/u/.ssh/id_ed25519': ");
    expect(result.stdout.trim()).toBe("");
    expect(result.exitCode).toBe(1);
  });

  test("refuses an empty prompt", async () => {
    const result = await askpass("");
    expect(result.exitCode).toBe(1);
  });
});
