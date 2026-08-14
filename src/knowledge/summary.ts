import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  type CommitAuthor,
  decodeUtf8,
  readRepositoryConfig,
  type RepositoryConfig,
  runRepositoryGit,
} from "../shared-memory-repository.js";
import {
  cloneDir,
  DEFAULT_BASE_ID,
  failureResponse,
  jsonResponse,
  pathExists,
  readWatermark,
  requireBase,
  searchParams,
} from "./base.js";

export type DigestMode = "deterministic" | "llm";

export interface KnowledgeCounts {
  skills: number;
  pages: number;
}

export interface KnowledgeHealth {
  lockPresent: boolean;
  lockAgeMs: number | null;
  identityConfigured: boolean;
}

export interface KnowledgeBaseSummary {
  id: string;
  configured: boolean;
  repoUrl: string | null;
  branch: string | null;
  clonePresent: boolean;
  syncedHead: string | null;
  syncedAt: string | null;
  digestHead: string | null;
  digestMode: DigestMode | null;
  author: CommitAuthor | null;
  counts: KnowledgeCounts | null;
  health: KnowledgeHealth | null;
}

// Watermarks are whatever the writer left behind, so a value is only handed to
// git once it looks like an object id.
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const SKILL_MANIFEST = /^skills\/[^/]+\/SKILL\.md$/;
const CONCEPT_PAGE = /^concepts\/..*\.md$/;

const UNCONFIGURED_BASE: KnowledgeBaseSummary = {
  id: DEFAULT_BASE_ID,
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirrors the digest schedule: any value other than "llm" is deterministic,
 * including a missing block and one the schedule would reject.
 */
async function readDigestMode(pluginDir: string): Promise<DigestMode> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(pluginDir, "config.json"), "utf8"));
    const digest = isRecord(raw) ? raw.digest : undefined;
    return isRecord(digest) && digest.summary === "llm" ? "llm" : "deterministic";
  } catch {
    return "deterministic";
  }
}

async function countEntities(repoDir: string): Promise<KnowledgeCounts | null> {
  const tree = await runRepositoryGit(
    repoDir,
    ["ls-tree", "-r", "-z", "HEAD", "--", "skills", "concepts"],
    { allowFailure: true },
  );
  if (tree.exitCode !== 0) {
    return null;
  }
  let skills = 0;
  let pages = 0;
  for (const record of decodeUtf8(tree.stdout).split("\0")) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    if (!record.slice(0, separator).includes(" blob ")) {
      continue;
    }
    const path = record.slice(separator + 1);
    if (SKILL_MANIFEST.test(path)) {
      skills += 1;
    } else if (CONCEPT_PAGE.test(path)) {
      pages += 1;
    }
  }
  return { skills, pages };
}

async function readCommitDate(repoDir: string, sha: string | null): Promise<string | null> {
  if (!sha || !OBJECT_ID.test(sha)) {
    return null;
  }
  const shown = await runRepositoryGit(repoDir, ["show", "-s", "--format=%cI", `${sha}^{commit}`], {
    allowFailure: true,
  });
  if (shown.exitCode !== 0) {
    return null;
  }
  const date = decodeUtf8(shown.stdout).trim();
  return date.length === 0 ? null : date;
}

async function readHealth(pluginDir: string, identityConfigured: boolean): Promise<KnowledgeHealth> {
  const lockDir = join(pluginDir, "data", "sync.lock");
  try {
    const lock = await stat(lockDir);
    return {
      lockPresent: true,
      lockAgeMs: Math.max(0, Date.now() - lock.mtimeMs),
      identityConfigured,
    };
  } catch {
    return { lockPresent: false, lockAgeMs: null, identityConfigured };
  }
}

// A config.json that cannot be read describes no usable base, so the dashboard
// reports such an install the same way it reports one with no config.json.
async function readConfig(pluginDir: string): Promise<RepositoryConfig | null> {
  try {
    return await readRepositoryConfig(pluginDir);
  } catch {
    return null;
  }
}

export async function readBaseSummary(pluginDir: string): Promise<KnowledgeBaseSummary> {
  const config = await readConfig(pluginDir);
  if (!config) {
    return { ...UNCONFIGURED_BASE };
  }

  const repoDir = cloneDir(pluginDir);
  const clonePresent = await pathExists(join(repoDir, ".git"));
  const syncedHead = await readWatermark(pluginDir, "last-sha");
  return {
    id: DEFAULT_BASE_ID,
    configured: true,
    repoUrl: config.repoUrl,
    branch: config.branch,
    clonePresent,
    syncedHead,
    syncedAt: clonePresent ? await readCommitDate(repoDir, syncedHead) : null,
    digestHead: await readWatermark(pluginDir, "digest-last-sha"),
    digestMode: await readDigestMode(pluginDir),
    author: config.author,
    counts: clonePresent ? await countEntities(repoDir) : null,
    health: await readHealth(pluginDir, config.author !== null),
  };
}

export async function handleKnowledgeSummary(
  request: Request,
  pluginDir: string,
): Promise<Response> {
  try {
    requireBase(searchParams(request));
    return jsonResponse({ ok: true, bases: [await readBaseSummary(pluginDir)] });
  } catch (error) {
    return failureResponse(error);
  }
}
