import { describe, expect, test } from "bun:test";

import { parseRemote, toHttpsUrl } from "../src/setup/remote.js";

describe("parseRemote", () => {
  test("reads an https GitHub remote", () => {
    expect(parseRemote("https://github.com/acme/knowledge.git")).toEqual({
      transport: "https",
      host: "github.com",
      repoPath: "acme/knowledge",
      isGitHub: true,
    });
  });

  test("reads the scp-like SSH form the example config ships with", () => {
    expect(parseRemote("git@github.com:acme/knowledge.git")).toEqual({
      transport: "ssh",
      host: "github.com",
      repoPath: "acme/knowledge",
      isGitHub: true,
    });
  });

  test("reads the ssh:// URL form", () => {
    expect(parseRemote("ssh://git@github.com/acme/knowledge.git")).toEqual({
      transport: "ssh",
      host: "github.com",
      repoPath: "acme/knowledge",
      isGitHub: true,
    });
  });

  test("tolerates a missing .git suffix", () => {
    expect(parseRemote("https://github.com/acme/knowledge").repoPath).toBe("acme/knowledge");
  });

  test("reports a non-GitHub host as parsed but not GitHub", () => {
    const remote = parseRemote("https://gitlab.example.com/acme/knowledge.git");
    expect(remote.transport).toBe("https");
    expect(remote.isGitHub).toBe(false);
    expect(remote.repoPath).toBe("acme/knowledge");
  });

  // A path that is not exactly owner/repo cannot address the GitHub API, so it
  // is reported absent rather than guessed at — the verify call would 404 and
  // blame the token for a URL problem.
  test("reports no repo path for a URL that is not owner/repo", () => {
    expect(parseRemote("https://github.com/acme").repoPath).toBeNull();
    expect(parseRemote("https://github.com/acme/group/knowledge.git").repoPath).toBeNull();
  });

  test.each([
    ["", "empty"],
    ["not a url", "prose"],
    ["file:///tmp/repo", "a scheme git will not fetch over the network"],
    ["ftp://example.com/repo.git", "an unsupported scheme"],
  ])("refuses %p (%s)", (url) => {
    expect(parseRemote(url).transport).toBe("unknown");
  });

  test("refuses a URL carrying a NUL byte", () => {
    expect(parseRemote("https://github.com/acme/knowledge\0.git").transport).toBe("unknown");
  });

  test("refuses a URL past the length the config reader accepts", () => {
    const long = `https://github.com/acme/${"n".repeat(2_100)}.git`;
    expect(parseRemote(long).transport).toBe("unknown");
  });
});

describe("toHttpsUrl", () => {
  test("rewrites an SSH remote onto the transport setup can finish", () => {
    expect(toHttpsUrl("git@github.com:acme/knowledge.git")).toBe(
      "https://github.com/acme/knowledge.git",
    );
  });

  test("normalizes an https remote to the same canonical form", () => {
    expect(toHttpsUrl("https://github.com/acme/knowledge")).toBe(
      "https://github.com/acme/knowledge.git",
    );
  });

  // Offering a switch means promising it names the same repository. Without an
  // owner/repo there is nothing to rebuild from, so no offer is made.
  test("offers nothing when the URL carries no owner/repo", () => {
    expect(toHttpsUrl("git@github.com:acme.git")).toBeNull();
    expect(toHttpsUrl("nonsense")).toBeNull();
  });
});
