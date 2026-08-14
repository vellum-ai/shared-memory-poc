import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleKnowledgeActivity } from "../src/knowledge/activity.js";
import { handleKnowledgePage } from "../src/knowledge/page.js";
import { handleKnowledgePending } from "../src/knowledge/pending.js";
import { handleKnowledgeSearch } from "../src/knowledge/search.js";
import { handleKnowledgeSummary } from "../src/knowledge/summary.js";
import { initRepo, runGit } from "./git-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIGEST_SCRIPT = join(REPO_ROOT, "schedules", "digest", "index.sh");

const RUNBOOK = "---\ntitle: Deploy runbook\n---\n\nCut the release, then announce it.\n";
const ONCALL = "---\ntitle: On-call\n---\n\nThe pager rotates every Monday.\n";

type Handler = (request: Request, pluginDir: string) => Promise<Response>;

interface Fixture {
  root: string;
  content: string;
  pluginDir: string;
  clone: string;
  repoUrl: string;
}

interface JsonBody {
  ok: boolean;
  [key: string]: unknown;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Commits everything staged in the content repo under the named author. */
function commitAs(repo: string, author: string, message: string): string {
  runGit(repo, ["add", "-A"]);
  runGit(repo, [
    "-c",
    `user.name=${author}`,
    "-c",
    `user.email=${author.toLowerCase().replace(/ /g, ".")}@example.com`,
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return runGit(repo, ["rev-parse", "HEAD"]).trim();
}

function writeConfig(pluginDir: string, config: Record<string, unknown> | null): void {
  const path = join(pluginDir, "config.json");
  if (config === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

function dataPath(fixture: Fixture, ...parts: string[]): string {
  return join(fixture.pluginDir, "data", ...parts);
}

function head(repo: string): string {
  return runGit(repo, ["rev-parse", "HEAD"]).trim();
}

/** Seeds a content repo, clones it the way sync does, and configures the install. */
function makeFixture(options: { config?: Record<string, unknown> | null } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-knowledge-"));
  roots.push(root);

  const content = join(root, "content");
  initRepo(content);
  writeFile(join(content, "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n\nShip it.\n");
  writeFile(join(content, "concepts", "deploy-runbook.md"), RUNBOOK);
  writeFile(join(content, "README.md"), "# Shared content\n");
  commitAs(content, "Seeder", "seed shared content");

  const pluginDir = join(root, "plugins", "shared-memory");
  const clone = join(pluginDir, "data", "repo");
  mkdirSync(dirname(clone), { recursive: true });
  const repoUrl = `file://${content}`;
  runGit(root, ["clone", "-q", repoUrl, clone]);

  const fixture: Fixture = { root, content, pluginDir, clone, repoUrl };
  writeConfig(
    pluginDir,
    options.config === undefined
      ? { repoUrl, branch: "main", author: { name: "Ada Lovelace", email: "ada@example.com" } }
      : options.config,
  );
  writeFile(dataPath(fixture, "last-sha"), `${head(clone)}\n`);
  return fixture;
}

/** Pulls the content repo's commits into the clone and moves the watermark. */
function syncClone(fixture: Fixture): string {
  runGit(fixture.clone, ["pull", "-q"]);
  const synced = head(fixture.clone);
  writeFile(dataPath(fixture, "last-sha"), `${synced}\n`);
  return synced;
}

function installDigestScript(fixture: Fixture): void {
  const script = join(fixture.pluginDir, "schedules", "digest", "index.sh");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(DIGEST_SCRIPT, script);
  chmodSync(script, 0o755);
}

function request(route: string, params: Record<string, string> = {}): Request {
  const url = new URL(`http://plugin.local/x/plugins/shared-memory/knowledge/${route}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

async function call(
  handler: Handler,
  fixture: Fixture,
  route: string,
  params: Record<string, string> = {},
): Promise<{ status: number; body: JsonBody }> {
  const response = await handler(request(route, params), fixture.pluginDir);
  return { status: response.status, body: (await response.json()) as JsonBody };
}

interface SummaryBase {
  id: string;
  configured: boolean;
  repoUrl: string | null;
  branch: string | null;
  clonePresent: boolean;
  syncedHead: string | null;
  syncedAt: string | null;
  digestHead: string | null;
  digestMode: string | null;
  author: { name: string; email: string } | null;
  counts: { skills: number; pages: number } | null;
  health: { lockPresent: boolean; lockAgeMs: number | null; identityConfigured: boolean } | null;
}

async function summaryBase(fixture: Fixture): Promise<SummaryBase> {
  const { status, body } = await call(handleKnowledgeSummary, fixture, "summary");
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  const bases = body.bases as SummaryBase[];
  expect(bases).toHaveLength(1);
  return bases[0];
}

interface ActivityChange {
  kind: string;
  name: string;
  action: string;
}

interface ActivityCommitBody {
  sha: string;
  author: string;
  date: string;
  subject: string;
  changes: ActivityChange[];
}

interface ActivityWeekBody {
  weekStart: string;
  author: string;
  skills: { added: number; updated: number; removed: number };
  pages: { added: number; updated: number; removed: number };
}

describe("knowledge summary", () => {
  test("reports the configured base, its heads and its entity counts", async () => {
    const fixture = makeFixture();
    writeFile(join(fixture.content, "skills", "oncall", "SKILL.md"), "---\nname: oncall\n---\n\nPage.\n");
    writeFile(join(fixture.content, "skills", "oncall", "reference.md"), "Escalation ladder.\n");
    writeFile(join(fixture.content, "concepts", "team", "oncall.md"), ONCALL);
    commitAs(fixture.content, "Alice", "add oncall skill and page");
    const synced = syncClone(fixture);
    writeFile(dataPath(fixture, "digest-last-sha"), `${synced}\n`);

    const base = await summaryBase(fixture);

    expect(base.id).toBe("default");
    expect(base.configured).toBe(true);
    expect(base.repoUrl).toBe(fixture.repoUrl);
    expect(base.branch).toBe("main");
    expect(base.clonePresent).toBe(true);
    expect(base.syncedHead).toBe(synced);
    expect(base.syncedAt).toBe(runGit(fixture.clone, ["show", "-s", "--format=%cI", synced]).trim());
    expect(base.digestHead).toBe(synced);
    expect(base.digestMode).toBe("deterministic");
    expect(base.author).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(base.counts).toEqual({ skills: 2, pages: 2 });
    expect(base.health).toEqual({
      lockPresent: false,
      lockAgeMs: null,
      identityConfigured: true,
    });
  });

  test("reports the llm digest mode, a held lock and a missing identity", async () => {
    const fixture = makeFixture({
      config: { repoUrl: "file:///srv/kb.git", branch: "main", digest: { summary: "llm" } },
    });
    mkdirSync(dataPath(fixture, "sync.lock"));

    const base = await summaryBase(fixture);

    expect(base.digestMode).toBe("llm");
    expect(base.author).toBeNull();
    expect(base.health?.identityConfigured).toBe(false);
    expect(base.health?.lockPresent).toBe(true);
    expect(base.health?.lockAgeMs).toBeGreaterThanOrEqual(0);
  });

  test("an unconfigured install still answers, with one unconfigured base", async () => {
    const fixture = makeFixture({ config: null });

    const base = await summaryBase(fixture);

    expect(base).toEqual({
      id: "default",
      configured: false,
      repoUrl: null,
      branch: null,
      clonePresent: false,
      syncedHead: null,
      syncedAt: null,
      digestHead: null,
      digestMode: null,
      author: null,
      counts: null,
      health: null,
    });
  });

  test("a missing clone leaves the counts and the synced date unknown", async () => {
    const fixture = makeFixture();
    const synced = head(fixture.clone);
    rmSync(fixture.clone, { recursive: true, force: true });

    const base = await summaryBase(fixture);

    expect(base.configured).toBe(true);
    expect(base.clonePresent).toBe(false);
    expect(base.counts).toBeNull();
    expect(base.syncedAt).toBeNull();
    expect(base.syncedHead).toBe(synced);
  });
});

describe("knowledge activity", () => {
  async function seedActivity(fixture: Fixture): Promise<void> {
    writeFile(join(fixture.content, "concepts", "team", "oncall.md"), ONCALL);
    writeFile(join(fixture.content, "skills", "rollback", "SKILL.md"), "---\nname: rollback\n---\n\nUndo.\n");
    commitAs(fixture.content, "Alice", "add rollback skill and oncall page");

    writeFile(join(fixture.content, "skills", "deploy", "reference.md"), "Release checklist.\n");
    runGit(fixture.content, ["rm", "-q", "concepts/team/oncall.md"]);
    commitAs(fixture.content, "Bob", "extend deploy, drop the oncall page");

    runGit(fixture.content, ["mv", "concepts/deploy-runbook.md", "concepts/deploy-guide.md"]);
    commitAs(fixture.content, "Alice", "rename the runbook");

    writeFile(join(fixture.content, "README.md"), "# Shared content\n\nSee the skills.\n");
    commitAs(fixture.content, "Carol", "document the layout");

    syncClone(fixture);
  }

  test("aggregates adds, updates and removes per week and author", async () => {
    const fixture = makeFixture();
    await seedActivity(fixture);

    const { status, body } = await call(handleKnowledgeActivity, fixture, "activity");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.base).toBe("default");
    const weekly = body.weekly as ActivityWeekBody[];
    const weekStart = weekly[0].weekStart;
    expect(new Date(`${weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(weekly.map((week) => week.author)).toEqual(["Alice", "Bob", "Seeder"]);
    expect(weekly).toEqual([
      {
        weekStart,
        author: "Alice",
        skills: { added: 1, updated: 0, removed: 0 },
        pages: { added: 1, updated: 1, removed: 0 },
      },
      {
        weekStart,
        author: "Bob",
        skills: { added: 0, updated: 1, removed: 0 },
        pages: { added: 0, updated: 0, removed: 1 },
      },
      {
        weekStart,
        author: "Seeder",
        skills: { added: 1, updated: 0, removed: 0 },
        pages: { added: 1, updated: 0, removed: 0 },
      },
    ]);

    const range = body.range as { from: string; to: string };
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(90 * 24 * 60 * 60 * 1_000);
  });

  test("the commit feed is newest first and keeps commits that changed no entity", async () => {
    const fixture = makeFixture();
    await seedActivity(fixture);

    const { body } = await call(handleKnowledgeActivity, fixture, "activity");

    const commits = body.commits as ActivityCommitBody[];
    expect(commits.map((entry) => entry.subject)).toEqual([
      "document the layout",
      "rename the runbook",
      "extend deploy, drop the oncall page",
      "add rollback skill and oncall page",
      "seed shared content",
    ]);
    expect(commits[0].author).toBe("Carol");
    expect(commits[0].changes).toEqual([]);
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(commits[0].date)).toBeGreaterThan(0);
    expect(commits[1].changes).toEqual([{ kind: "page", name: "deploy-guide", action: "updated" }]);
    expect(commits[2].changes).toEqual([
      { kind: "page", name: "team/oncall", action: "removed" },
      { kind: "skill", name: "deploy", action: "updated" },
    ]);
    expect(commits[3].changes).toEqual([
      { kind: "page", name: "team/oncall", action: "added" },
      { kind: "skill", name: "rollback", action: "added" },
    ]);
  });

  test("a skill counts as added only through its own SKILL.md", async () => {
    const fixture = makeFixture();
    writeFile(join(fixture.content, "skills", "audit", "SKILL.md"), "---\nname: audit\n---\n\nCheck.\n");
    writeFile(join(fixture.content, "skills", "audit", "checklist.md"), "One item.\n");
    commitAs(fixture.content, "Alice", "add the audit skill with its checklist");
    syncClone(fixture);

    const { body } = await call(handleKnowledgeActivity, fixture, "activity");

    const commits = body.commits as ActivityCommitBody[];
    expect(commits[0].changes).toEqual([{ kind: "skill", name: "audit", action: "added" }]);
  });

  test("merge commits and files outside skills and concepts are ignored", async () => {
    const fixture = makeFixture();
    runGit(fixture.content, ["checkout", "-q", "-b", "side"]);
    writeFile(join(fixture.content, "concepts", "side-note.md"), "A side note.\n");
    commitAs(fixture.content, "Bob", "add a side note");
    runGit(fixture.content, ["checkout", "-q", "main"]);
    writeFile(join(fixture.content, "docs", "handbook.md"), "Not shared knowledge.\n");
    commitAs(fixture.content, "Carol", "add a handbook");
    runGit(fixture.content, [
      "-c",
      "user.name=Merger",
      "-c",
      "user.email=merger@example.com",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge the side note",
      "side",
    ]);
    syncClone(fixture);

    const { body } = await call(handleKnowledgeActivity, fixture, "activity");

    const commits = body.commits as ActivityCommitBody[];
    expect(commits.map((entry) => entry.subject)).not.toContain("merge the side note");
    expect(commits.find((entry) => entry.subject === "add a handbook")?.changes).toEqual([]);
    const weekly = body.weekly as ActivityWeekBody[];
    expect(weekly.map((week) => week.author)).toEqual(["Bob", "Seeder"]);
    expect(weekly[0].pages).toEqual({ added: 1, updated: 0, removed: 0 });
  });

  test("days is clamped to a year and rejected when it is not a number", async () => {
    const fixture = makeFixture();

    const clamped = await call(handleKnowledgeActivity, fixture, "activity", { days: "5000" });
    const range = clamped.body.range as { from: string; to: string };
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(365 * 24 * 60 * 60 * 1_000);

    const floor = await call(handleKnowledgeActivity, fixture, "activity", { days: "0" });
    const floorRange = floor.body.range as { from: string; to: string };
    expect(Date.parse(floorRange.to) - Date.parse(floorRange.from)).toBe(24 * 60 * 60 * 1_000);

    const invalid = await call(handleKnowledgeActivity, fixture, "activity", { days: "many" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      ok: false,
      error: { code: "INVALID_PARAM", message: "days must be a whole number." },
    });
  });

  test("a missing clone is a retryable failure", async () => {
    const fixture = makeFixture();
    rmSync(fixture.clone, { recursive: true, force: true });

    const { status, body } = await call(handleKnowledgeActivity, fixture, "activity");

    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("CLONE_MISSING");
  });
});

describe("knowledge page", () => {
  test("serves the Markdown at the clone's HEAD", async () => {
    const fixture = makeFixture();

    const { status, body } = await call(handleKnowledgePage, fixture, "page", {
      path: "concepts/deploy-runbook.md",
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      base: "default",
      path: "concepts/deploy-runbook.md",
      content: RUNBOOK,
    });
  });

  test("rejects traversal and paths outside concepts", async () => {
    const fixture = makeFixture();

    for (const path of [
      "concepts/../../etc/passwd",
      "../../etc/passwd",
      "/etc/passwd",
      "skills/deploy/SKILL.md",
      "concepts/deploy-runbook.md/../../secrets.md",
    ]) {
      const { status, body } = await call(handleKnowledgePage, fixture, "page", { path });
      expect(status).toBe(400);
      expect((body.error as { code: string }).code).toBe("INVALID_PATH");
    }

    const missing = await call(handleKnowledgePage, fixture, "page");
    expect(missing.status).toBe(400);
  });

  test("refuses a page past the read limit", async () => {
    const fixture = makeFixture();
    writeFile(
      join(fixture.content, "concepts", "huge-page.md"),
      `${"filler line\n".repeat(6_000)}`,
    );
    commitAs(fixture.content, "Alice", "add an oversized page");
    syncClone(fixture);

    const { status, body } = await call(handleKnowledgePage, fixture, "page", {
      path: "concepts/huge-page.md",
    });

    expect(status).toBe(413);
    expect((body.error as { code: string }).code).toBe("CONTENT_LIMIT");
  });

  test("reports a page that HEAD does not hold", async () => {
    const fixture = makeFixture();

    const { status, body } = await call(handleKnowledgePage, fixture, "page", {
      path: "concepts/team/missing.md",
    });

    expect(status).toBe(404);
    expect((body.error as { code: string }).code).toBe("PATH_NOT_FOUND");
  });
});

describe("knowledge search", () => {
  test("returns matching pages with an excerpt around the hit", async () => {
    const fixture = makeFixture();
    writeFile(join(fixture.content, "concepts", "team", "oncall.md"), ONCALL);
    commitAs(fixture.content, "Alice", "add the oncall page");
    syncClone(fixture);

    const { status, body } = await call(handleKnowledgeSearch, fixture, "search", { q: "pager" });

    expect(status).toBe(200);
    expect(body.base).toBe("default");
    expect(body.truncated).toBe(false);
    const matches = body.matches as { path: string; excerpt: string; truncated: boolean }[];
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("concepts/team/oncall.md");
    expect(matches[0].excerpt).toContain("pager rotates");
    expect(matches[0].truncated).toBe(false);
  });

  test("marks an excerpt clipped out of a long page", async () => {
    const fixture = makeFixture();
    const filler = "Background paragraph.\n".repeat(40);
    writeFile(
      join(fixture.content, "concepts", "long-page.md"),
      `${filler}The rollback lever is in the console.\n${filler}`,
    );
    commitAs(fixture.content, "Alice", "add a long page");
    syncClone(fixture);

    const { body } = await call(handleKnowledgeSearch, fixture, "search", { q: "rollback lever" });

    const matches = body.matches as { excerpt: string; truncated: boolean }[];
    expect(matches).toHaveLength(1);
    expect(matches[0].excerpt).toContain("rollback lever");
    expect(matches[0].excerpt.length).toBe(300);
    expect(matches[0].truncated).toBe(true);
  });

  test("a page too large to excerpt is still named", async () => {
    const fixture = makeFixture();
    writeFile(
      join(fixture.content, "concepts", "huge-page.md"),
      `The freeze window starts on Friday.\n${"filler line\n".repeat(6_000)}`,
    );
    commitAs(fixture.content, "Alice", "add an oversized page");
    syncClone(fixture);

    const { status, body } = await call(handleKnowledgeSearch, fixture, "search", {
      q: "freeze window",
    });

    expect(status).toBe(200);
    expect(body.matches).toEqual([
      { path: "concepts/huge-page.md", excerpt: "", truncated: true },
    ]);
  });

  test("no match is an empty answer, not a failure", async () => {
    const fixture = makeFixture();

    const { status, body } = await call(handleKnowledgeSearch, fixture, "search", {
      q: "nothing here says this",
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, base: "default", matches: [], truncated: false });
  });

  test("caps the matches and says the list was cut", async () => {
    const fixture = makeFixture();
    for (let index = 0; index < 21; index += 1) {
      writeFile(
        join(fixture.content, "concepts", `note-${index}.md`),
        `The freeze window starts on Friday. Note ${index}.\n`,
      );
    }
    commitAs(fixture.content, "Alice", "add many pages about the freeze window");
    syncClone(fixture);

    const { body } = await call(handleKnowledgeSearch, fixture, "search", { q: "freeze window" });

    expect(body.matches).toHaveLength(20);
    expect(body.truncated).toBe(true);
  });

  test("a missing or oversized query is a bad request", async () => {
    const fixture = makeFixture();

    const missing = await call(handleKnowledgeSearch, fixture, "search");
    expect(missing.status).toBe(400);
    expect((missing.body.error as { code: string }).code).toBe("INVALID_QUERY");

    const oversized = await call(handleKnowledgeSearch, fixture, "search", { q: "x".repeat(257) });
    expect(oversized.status).toBe(400);
    expect((oversized.body.error as { code: string }).code).toBe("INVALID_QUERY");
  });
});

describe("knowledge pending", () => {
  test("passes the digest collector's own JSON through", async () => {
    const fixture = makeFixture();
    installDigestScript(fixture);
    const baseline = head(fixture.clone);
    writeFile(dataPath(fixture, "digest-last-sha"), `${baseline}\n`);
    writeFile(join(fixture.content, "concepts", "team", "oncall.md"), ONCALL);
    commitAs(fixture.content, "Alice", "add the oncall page");
    const synced = syncClone(fixture);

    const { status, body } = await call(handleKnowledgePending, fixture, "pending");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.base).toBe("default");
    expect(body.digest).toMatchObject({
      status: "changes",
      mode: "deterministic",
      range: { start: baseline, end: synced },
      authors: [
        {
          author: "Alice",
          skills: { added: [], updated: [], removed: [] },
          pages: { added: ["team/oncall"], updated: [], removed: [] },
        },
      ],
      commits: [{ author: "Alice", subject: "add the oncall page" }],
    });
  });

  test("a first collect baselines and says so", async () => {
    const fixture = makeFixture();
    installDigestScript(fixture);

    const { status, body } = await call(handleKnowledgePending, fixture, "pending");

    expect(status).toBe(200);
    expect(body.digest).toEqual({ status: "baselined", mode: "deterministic" });
  });

  test("a collector that cannot run is a retryable failure", async () => {
    const fixture = makeFixture();

    const { status, body } = await call(handleKnowledgePending, fixture, "pending");

    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("COLLECT_FAILED");
  });
});

describe("knowledge route modules", () => {
  test("each route exposes GET and a description", async () => {
    for (const name of ["summary", "activity", "page", "search", "pending"]) {
      const module = (await import(`../routes/knowledge/${name}.js`)) as {
        description?: unknown;
        GET?: unknown;
      };
      expect([name, typeof module.GET]).toEqual([name, "function"]);
      expect([name, typeof module.description]).toEqual([name, "string"]);
    }
  });

  test("the summary route answers for the plugin directory it resolves", async () => {
    const module = (await import("../routes/knowledge/summary.js")) as {
      GET: (request: Request) => Promise<Response>;
    };

    const response = await module.GET(request("summary"));

    expect(response.status).toBe(200);
    expect(((await response.json()) as JsonBody).ok).toBe(true);
  });
});

describe("knowledge base parameter", () => {
  const routes: [string, Handler, Record<string, string>][] = [
    ["summary", handleKnowledgeSummary, {}],
    ["activity", handleKnowledgeActivity, {}],
    ["page", handleKnowledgePage, { path: "concepts/deploy-runbook.md" }],
    ["search", handleKnowledgeSearch, { q: "release" }],
    ["pending", handleKnowledgePending, {}],
  ];

  test("every route answers for the default base", async () => {
    const fixture = makeFixture();
    installDigestScript(fixture);

    for (const [route, handler, params] of routes) {
      const { status, body } = await call(handler, fixture, route, { ...params, base: "default" });
      expect([route, status]).toEqual([route, 200]);
      expect(body.ok).toBe(true);
    }
  });

  test("every route reports an unknown base as missing", async () => {
    const fixture = makeFixture();
    installDigestScript(fixture);

    for (const [route, handler, params] of routes) {
      const { status, body } = await call(handler, fixture, route, { ...params, base: "other" });
      expect([route, status]).toEqual([route, 404]);
      expect(body).toEqual({
        ok: false,
        error: {
          code: "UNKNOWN_BASE",
          message: 'This install has no knowledge base named "other".',
        },
      });
    }
  });
});
