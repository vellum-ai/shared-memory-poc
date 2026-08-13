import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runRepositoryGit } from "../src/shared-memory-repository.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELPER = join(REPO_ROOT, "github-oauth-credential.sh");

function runHelper(input: string, response = '{"body":{"temp_clone_token":"short-lived"}}') {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-oauth-"));
  const inputFile = join(root, "credential-input");
  writeFileSync(inputFile, input);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const assistant = join(bin, "assistant");
  writeFileSync(
    assistant,
    `#!/usr/bin/env bash\nprintf '%s' '${response.replaceAll("'", "'\\''")}'\n`,
  );
  chmodSync(assistant, 0o755);
  try {
    return Bun.spawnSync(["bash", HELPER], {
      env: {
        PATH: `${bin}:/usr/bin`,
        HOME: root,
        SHARED_MEMORY_ASSISTANT_BIN: assistant,
        SHARED_MEMORY_JQ_BIN: "/usr/bin/jq",
      },
      stdin: Bun.file(inputFile),
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("GitHub OAuth credential helper", () => {
  test("returns a short-lived credential for a GitHub HTTPS repository", () => {
    const result = runHelper("protocol=https\nhost=github.com\npath=org/private-repo.git\n\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "username=x-access-token\npassword=short-lived\n\n",
    );
  });

  test("does not answer credentials for another host or protocol", () => {
    const result = runHelper("protocol=https\nhost=gitlab.com\npath=org/private-repo.git\n\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  test("injects the OAuth helper into TypeScript Git operations", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-memory-git-env-"));
    const bin = join(root, "bin");
    const capture = join(root, "env");
    const fakeGit = join(bin, "git");
    mkdirSync(bin);
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
printf '%s\n' "GIT_CONFIG_COUNT=$GIT_CONFIG_COUNT" "GIT_CONFIG_KEY_0=$GIT_CONFIG_KEY_0" "GIT_CONFIG_VALUE_0=$GIT_CONFIG_VALUE_0" "GIT_CONFIG_KEY_1=$GIT_CONFIG_KEY_1" "GIT_CONFIG_VALUE_1=$GIT_CONFIG_VALUE_1" "GIT_CONFIG_KEY_2=$GIT_CONFIG_KEY_2" "GIT_CONFIG_VALUE_2=$GIT_CONFIG_VALUE_2" > "$OAUTH_ENV_CAPTURE"
`,
    );
    chmodSync(fakeGit, 0o755);
    try {
      await runRepositoryGit(root, ["rev-parse", "HEAD"], {
        env: {
          PATH: `${bin}:/usr/bin`,
          OAUTH_ENV_CAPTURE: capture,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.attributesFile",
          GIT_CONFIG_VALUE_0: "/empty/attributes",
        },
      });
      const values = readFileSync(capture, "utf8");
      expect(values).toContain("GIT_CONFIG_COUNT=3");
      expect(values).toContain("GIT_CONFIG_KEY_0=core.attributesFile");
      expect(values).toContain("GIT_CONFIG_VALUE_0=/empty/attributes");
      expect(values).toContain("GIT_CONFIG_KEY_1=credential.helper");
      expect(values).toContain(`GIT_CONFIG_VALUE_1=${join(REPO_ROOT, "github-oauth-credential.sh")}`);
      expect(values).toContain("GIT_CONFIG_KEY_2=credential.useHttpPath");
      expect(values).toContain("GIT_CONFIG_VALUE_2=true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the OAuth response has no clone token", () => {
    const result = runHelper(
      "protocol=https\nhost=github.com\npath=org/private-repo.git\n\n",
      '{"body":{}}',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
});
