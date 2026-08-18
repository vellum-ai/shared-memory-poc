import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Registers the module fake, so it must be imported before anything that pulls
// the plugin API in.
import { pluginApiFake } from "./plugin-api-fake.js";

import {
  handleSetupConfig,
  handleSetupCredential,
  handleSetupStatus,
} from "../src/setup/handlers.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const realFetch = globalThis.fetch;

let pluginDir: string;
/** Requests the handler made to GitHub, so the token is never asserted on. */
let githubCalls: { url: string; authorization: string | null }[];

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "sm-setup-routes-"));
  roots.push(pluginDir);
  pluginApiFake.reset();
  githubCalls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers the one GitHub call the credential handler makes. */
function stubGitHub(status: number, body: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    githubCalls.push({
      url: String(input),
      authorization: headers.get("authorization"),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function stubGitHubUnreachable(): void {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
}

function post(body: unknown): Request {
  return new Request("http://localhost/v1/x/plugins/shared-memory/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(pluginDir, "config.json"), JSON.stringify(config));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginDir, "config.json"), "utf8"));
}

describe("GET setup/status", () => {
  test("answers the envelope the app's client expects", async () => {
    const response = await handleSetupStatus(pluginDir);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect((body.status as { complete: boolean }).complete).toBe(false);
  });

  test("reports a config that does not parse instead of throwing", async () => {
    writeConfig({});
    writeFileSync(join(pluginDir, "config.json"), "{ broken");

    const response = await handleSetupStatus(pluginDir);
    expect(response.status).toBe(400);
    expect((await readBody(response)).ok).toBe(false);
  });
});

describe("POST setup/config", () => {
  test("saves the repository and returns the advanced status", async () => {
    const response = await handleSetupConfig(
      post({ repoUrl: "https://github.com/acme/k.git", branch: "main" }),
      pluginDir,
    );
    const body = await readBody(response);

    expect(body.ok).toBe(true);
    expect(readConfig().repoUrl).toBe("https://github.com/acme/k.git");
    // The fresh status rides back on the same response so the wizard advances
    // without a second round trip.
    expect((body.status as { repoUrl: string }).repoUrl).toBe("https://github.com/acme/k.git");
  });

  test("rejects a branch git would read as an option", async () => {
    const response = await handleSetupConfig(post({ branch: "--upload-pack=x" }), pluginDir);
    const body = await readBody(response);

    expect(response.status).toBe(400);
    expect((body.error as { code: string }).code).toBe("INVALID_BRANCH");
  });

  test("rejects a body that is not JSON", async () => {
    const request = new Request("http://localhost/v1/x/plugins/shared-memory/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await handleSetupConfig(request, pluginDir)).status).toBe(400);
  });

  test("rejects a repo URL that is not a string", async () => {
    const response = await handleSetupConfig(post({ repoUrl: 42 }), pluginDir);
    expect(response.status).toBe(400);
  });
});

describe("POST setup/credential", () => {
  test("stores the token under this plugin's own scoped reference", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(200, { permissions: { push: true } });

    const response = await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir);
    const body = await readBody(response);

    expect(body.stored).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.canPush).toBe(true);
    // The field has to equal the plugin's manifest name or the host refuses
    // both the write and the read back.
    expect(pluginApiFake.storedRefs).toEqual(["github/shared-memory"]);
  });

  test("checks the token against the configured repository", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(200, { permissions: { push: true } });

    await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir);

    expect(githubCalls).toHaveLength(1);
    expect(githubCalls[0]!.url).toBe("https://api.github.com/repos/acme/k");
    expect(githubCalls[0]!.authorization).toBe("Bearer github_pat_example");
  });

  // Read-only is a usable install: shared knowledge still syncs in. Only
  // publishing needs write, so this reports rather than refuses.
  test("accepts a read-only token and says publishing will not work", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(200, { permissions: { push: false } });

    const body = await readBody(
      await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir),
    );

    expect(body.verified).toBe(true);
    expect(body.canPush).toBe(false);
    expect(String(body.message)).toContain("cannot publish");
  });

  test("reports a token GitHub rejects", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(401, { message: "Bad credentials" });

    const body = await readBody(
      await handleSetupCredential(post({ token: "github_pat_bad" }), pluginDir),
    );

    expect(body.verified).toBe(false);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("reports a repository the token cannot see", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(404, { message: "Not Found" });

    const body = await readBody(
      await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir),
    );

    expect(body.verified).toBe(false);
    expect(body.code).toBe("NO_ACCESS");
  });

  // The token is in the vault by then, and re-prompting would throw away a
  // value the user already pasted.
  test("keeps the token when GitHub cannot be reached", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHubUnreachable();

    const body = await readBody(
      await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir),
    );

    expect(body.stored).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.code).toBe("UNREACHABLE");
    expect(pluginApiFake.token).toBe("github_pat_example");
  });

  test("stores without checking when no repository is set yet", async () => {
    const body = await readBody(
      await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir),
    );

    expect(body.stored).toBe(true);
    expect(body.verified).toBe(false);
    expect(githubCalls).toHaveLength(0);
  });

  test.each([
    [{}, "a missing token"],
    [{ token: "" }, "an empty token"],
    [{ token: "   " }, "a token that is only whitespace"],
    [{ token: 42 }, "a token that is not a string"],
    [{ token: "ghp_with space" }, "a token containing a space"],
    [{ token: "ghp_with\nnewline" }, "a token containing a newline"],
  ])("refuses %o (%s)", async (body) => {
    const response = await handleSetupCredential(post(body), pluginDir);

    expect(response.status).toBe(400);
    expect(pluginApiFake.storedRefs).toHaveLength(0);
  });

  test("trims edge whitespace off a pasted token", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(200, { permissions: { push: true } });

    await handleSetupCredential(post({ token: "  github_pat_example\n" }), pluginDir);

    expect(pluginApiFake.token).toBe("github_pat_example");
  });

  // The host fails closed when no plugin is in context, and refuses a field
  // outside the plugin's scope. Both are deployment faults, and both would send
  // the user back to re-paste a token that was never the problem — so the
  // reason is carried through rather than flattened into a generic failure.
  test.each([
    ["storeCredential requires an active plugin execution context", "no plugin context"],
    ['Plugin "shared-memory" may only store credentials whose field matches', "a scope refusal"],
  ])("passes through the host's refusal: %s (%s)", async (hostMessage) => {
    pluginApiFake.failNextStore(new Error(hostMessage));

    const response = await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir);
    const body = await readBody(response);

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect((body.error as { code: string }).code).toBe("STORE_REFUSED");
    expect((body.error as { message: string }).message).toContain(hostMessage);
  });

  test("does not report a refused store as saved", async () => {
    pluginApiFake.failNextStore(new Error("out of scope"));

    const body = await readBody(
      await handleSetupCredential(post({ token: "github_pat_example" }), pluginDir),
    );

    expect(body.stored).toBeUndefined();
    expect(pluginApiFake.token).toBeNull();
  });

  // The response is rendered in the wizard and logged by the host; neither
  // should ever carry the value.
  test("never echoes the token back", async () => {
    writeConfig({ repoUrl: "https://github.com/acme/k.git" });
    stubGitHub(200, { permissions: { push: true } });

    const response = await handleSetupCredential(post({ token: "github_pat_secret" }), pluginDir);
    expect(await response.text()).not.toContain("github_pat_secret");
  });
});
