import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRawConfig, SetupConfigError, updateConfig } from "../src/setup/config-file.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "sm-setup-config-"));
  roots.push(pluginDir);
});

function writeConfig(contents: string): void {
  writeFileSync(join(pluginDir, "config.json"), contents);
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginDir, "config.json"), "utf8"));
}

describe("readRawConfig", () => {
  // A fresh install has no config, which is precisely when the setup flow runs.
  test("reads a missing config as empty rather than failing", async () => {
    expect(await readRawConfig(pluginDir)).toEqual({});
  });

  test("refuses a config that does not parse, rather than overwriting it", async () => {
    writeConfig("{ this is not json");
    await expect(readRawConfig(pluginDir)).rejects.toThrow(SetupConfigError);
  });

  test("refuses a config that is not an object", async () => {
    writeConfig('["repoUrl"]');
    await expect(readRawConfig(pluginDir)).rejects.toThrow(SetupConfigError);
  });
});

describe("updateConfig", () => {
  test("creates a config for a fresh install", async () => {
    await updateConfig(pluginDir, { repoUrl: "https://github.com/acme/k.git", branch: "main" });
    expect(readConfig()).toEqual({ repoUrl: "https://github.com/acme/k.git", branch: "main" });
  });

  // The sync schedule and the digest both read keys this flow never sets, so a
  // write that dropped them would silently reconfigure the plugin.
  test("carries through keys the setup flow does not manage", async () => {
    writeConfig(
      JSON.stringify({
        repoUrl: "https://github.com/acme/old.git",
        sharingGuidance: "Runbooks only.",
        digest: { summary: "llm" },
      }),
    );
    await updateConfig(pluginDir, { repoUrl: "https://github.com/acme/new.git" });

    expect(readConfig()).toEqual({
      repoUrl: "https://github.com/acme/new.git",
      sharingGuidance: "Runbooks only.",
      digest: { summary: "llm" },
    });
  });

  test("leaves an unmentioned field alone", async () => {
    writeConfig(JSON.stringify({ repoUrl: "https://github.com/acme/k.git", branch: "trunk" }));
    await updateConfig(pluginDir, { author: { name: "Alex", email: "alex@example.com" } });

    const config = readConfig();
    expect(config.branch).toBe("trunk");
    expect(config.author).toEqual({ name: "Alex", email: "alex@example.com" });
  });

  test("trims edge whitespace off values", async () => {
    await updateConfig(pluginDir, {
      repoUrl: "  https://github.com/acme/k.git  ",
      branch: " main ",
      author: { name: " Alex Chen ", email: " alex@example.com " },
    });

    expect(readConfig()).toEqual({
      repoUrl: "https://github.com/acme/k.git",
      branch: "main",
      author: { name: "Alex Chen", email: "alex@example.com" },
    });
  });

  test("leaves no temp file behind", async () => {
    await updateConfig(pluginDir, { repoUrl: "https://github.com/acme/k.git" });
    expect(readdirSync(pluginDir)).toEqual(["config.json"]);
  });

  // Every rule below matches readRepositoryConfig, the reader that gates sync.
  // Accepting one it rejects would report setup finished and then fail to sync.
  test("refuses an empty repo URL", async () => {
    await expect(updateConfig(pluginDir, { repoUrl: "   " })).rejects.toThrow(SetupConfigError);
  });

  test("refuses a branch git would read as an option", async () => {
    await expect(updateConfig(pluginDir, { branch: "--upload-pack=x" })).rejects.toThrow(
      SetupConfigError,
    );
  });

  test("refuses an empty branch", async () => {
    await expect(updateConfig(pluginDir, { branch: "  " })).rejects.toThrow(SetupConfigError);
  });

  test.each([
    [{ name: "", email: "alex@example.com" }, "an empty name"],
    [{ name: "Alex", email: "" }, "an empty email"],
    [{ name: "Alex", email: "not-an-address" }, "an email with no @"],
    [{ name: "Alex <hi>", email: "alex@example.com" }, "a name with commit-trailer syntax"],
    [{ name: "Alex\nChen", email: "alex@example.com" }, "a name with a newline"],
    [{ name: "Alex", email: "alex @example.com" }, "an email with a space"],
  ])("refuses %o (%s)", async (author) => {
    await expect(updateConfig(pluginDir, { author })).rejects.toThrow(SetupConfigError);
  });

  test("does not write anything when validation fails", async () => {
    writeConfig(JSON.stringify({ repoUrl: "https://github.com/acme/k.git" }));
    await expect(updateConfig(pluginDir, { branch: "-x" })).rejects.toThrow(SetupConfigError);
    expect(readConfig()).toEqual({ repoUrl: "https://github.com/acme/k.git" });
  });
});
