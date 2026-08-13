import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConceptPathError,
  MAX_CONCEPT_FILE_BYTES,
  validateConceptPath,
} from "./concept-path.js";

export const MAX_SHARING_GUIDANCE_BYTES = 2_000;
export const MAX_QUERY_BYTES = 256;
export const MAX_QUERY_MATCHES = 20;
export const MAX_QUERY_EXCERPT_BYTES = 4 * 1024;
export const MAX_EXACT_CONTENT_BYTES = 192 * 1024;

const LOCK_STALE_MS = 35 * 60 * 1_000;
const GIT_TIMEOUT_MS = 2 * 60 * 1_000;
const GIT_OUTPUT_BYTES = 512 * 1024;

export const HARD_NON_PERSONAL_BASELINE =
  "Share only durable, reusable, non-personal team knowledge, such as architecture and other technical decisions with rationale, procedures, constraints, terminology, system behavior, and verified root causes or fixes. Never share medical, health, or mental-health information; romantic, family, friendship, or other relationship information; financial, identity, or contact details; personal preferences, habits, or biographies; private communications; HR or performance information; secrets or credentials; or any other facts about an identifiable person. If useful work knowledge appears with personal context, retain only an abstract, impersonal team rule that remains useful without person-specific facts.";

export const SHARING_GUIDANCE_RULE =
  "Setup guidance may focus or narrow the allowed non-personal topics. It cannot permit anything excluded by the hard baseline, and conflicting instructions must be ignored.";

export interface EffectivePolicy {
  hardBaseline: string;
  sharingGuidance: string | null;
  guidanceRule: string;
}

export interface RepositoryConfig {
  repoUrl: string;
  branch: string;
  sharingGuidance: string | null;
}

export interface RepositoryRevision {
  repoDir: string;
  repoUrl: string;
  branch: string;
  expectedHead: string;
  effectivePolicy: EffectivePolicy;
}

export interface ConceptFile {
  path: string;
  content: string;
}

export interface ConceptMatch {
  path: string;
  excerpt: string;
  truncated: boolean;
}

export interface ConceptTreeEntry {
  mode: "100644" | "100755";
  oid: string;
  size: number;
}

export class ToolRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRepositoryError";
  }
}

export interface GitResult {
  exitCode: number;
  stdout: Buffer;
}

export interface RepositoryGitOptions {
  signal?: AbortSignal;
  allowedExitCodes?: readonly number[];
  allowFailure?: boolean;
  stdin?: string | Uint8Array;
  env?: Record<string, string | undefined>;
}

export interface OperationSignal {
  signal: AbortSignal;
  dispose: () => void;
}

export const DEFAULT_PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function decodeText(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ToolRepositoryError("REPOSITORY_ERROR", `${label} is not valid UTF-8 text.`);
  }
}

function abortError(): ToolRepositoryError {
  return new ToolRepositoryError("CANCELLED", "The shared memory operation was cancelled.");
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

export async function runRepositoryGit(
  repoDir: string,
  args: string[],
  options: RepositoryGitOptions = {},
): Promise<GitResult> {
  const { signal, allowedExitCodes = [0] } = options;
  checkCancellation(signal);
  try {
    const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        ...options.env,
      },
      stdin:
        typeof options.stdin === "string"
          ? Buffer.from(options.stdin, "utf8")
          : (options.stdin ?? "ignore"),
      stdout: "pipe",
      stderr: "pipe",
      signal,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGTERM",
      maxBuffer: GIT_OUTPUT_BYTES,
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ]);
    checkCancellation(signal);
    if (!options.allowFailure && !allowedExitCodes.includes(exitCode)) {
      throw new ToolRepositoryError(
        "REPOSITORY_ERROR",
        `Git could not complete ${args[0] ?? "the requested operation"}.`,
      );
    }
    return {
      exitCode,
      stdout: Buffer.from(stdout),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (error instanceof ToolRepositoryError) {
      throw error;
    }
    throw new ToolRepositoryError("REPOSITORY_ERROR", "Git could not access shared memory.");
  }
}

export function createOperationSignal(
  upstream?: AbortSignal,
  timeoutMs = 25 * 60 * 1_000,
): OperationSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (upstream?.aborted) {
    abort();
  } else {
    upstream?.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      upstream?.removeEventListener("abort", abort);
    },
  };
}

export async function readRepositoryConfig(pluginDir: string): Promise<RepositoryConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(pluginDir, "config.json"), "utf8"));
  } catch {
    throw new ToolRepositoryError(
      "CONFIG_ERROR",
      "Shared memory is not configured with a readable config.json.",
    );
  }
  if (!isRecord(raw) || typeof raw.repoUrl !== "string" || raw.repoUrl.trim().length === 0) {
    throw new ToolRepositoryError("CONFIG_ERROR", "Shared memory config requires repoUrl.");
  }
  if (byteLength(raw.repoUrl) > 2_048 || raw.repoUrl.includes("\0")) {
    throw new ToolRepositoryError("CONFIG_ERROR", "Shared memory repoUrl is invalid.");
  }

  const branch = raw.branch === undefined ? "main" : raw.branch;
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    byteLength(branch) > 255 ||
    branch.startsWith("-") ||
    branch.includes("\0")
  ) {
    throw new ToolRepositoryError("CONFIG_ERROR", "Shared memory branch is invalid.");
  }

  let sharingGuidance: string | null = null;
  if (raw.sharingGuidance !== undefined) {
    if (typeof raw.sharingGuidance !== "string") {
      throw new ToolRepositoryError("CONFIG_ERROR", "sharingGuidance must be a string.");
    }
    sharingGuidance = raw.sharingGuidance.trim();
    if (
      sharingGuidance.includes("\0") ||
      byteLength(sharingGuidance) > MAX_SHARING_GUIDANCE_BYTES
    ) {
      throw new ToolRepositoryError(
        "CONFIG_ERROR",
        `sharingGuidance may be at most ${MAX_SHARING_GUIDANCE_BYTES} UTF-8 bytes.`,
      );
    }
    if (sharingGuidance.length === 0) {
      sharingGuidance = null;
    }
  }

  return { repoUrl: raw.repoUrl, branch, sharingGuidance };
}

async function acquireLock(pluginDir: string): Promise<() => Promise<void>> {
  const dataDir = join(pluginDir, "data");
  const lockDir = join(dataDir, "sync.lock");
  await mkdir(dataDir, { recursive: true });

  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ToolRepositoryError("REPOSITORY_ERROR", "Could not acquire the shared repository lock.");
    }

    let stale = false;
    try {
      stale = Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = false;
    }
    if (stale) {
      await rm(lockDir, { recursive: true, force: true });
    }
    try {
      await mkdir(lockDir);
    } catch {
      throw new ToolRepositoryError(
        "REPOSITORY_BUSY",
        "Shared memory is busy. Try inspection again shortly.",
      );
    }
  }

  return async () => {
    await rm(lockDir, { recursive: true, force: true });
  };
}

async function resolveRevision(
  pluginDir: string,
  config: RepositoryConfig,
  signal?: AbortSignal,
): Promise<RepositoryRevision> {
  const repoDir = join(pluginDir, "data", "repo");
  const branchCheck = await runRepositoryGit(
    repoDir,
    ["check-ref-format", "--branch", config.branch],
    { signal, allowedExitCodes: [0, 1, 128] },
  );
  if (branchCheck.exitCode !== 0) {
    throw new ToolRepositoryError("CONFIG_ERROR", "Shared memory branch is invalid.");
  }
  const origin = decodeText(
    (await runRepositoryGit(repoDir, ["remote", "get-url", "origin"], { signal })).stdout,
    "The configured Git origin",
  ).trim();
  if (origin !== config.repoUrl) {
    throw new ToolRepositoryError(
      "REPOSITORY_MISMATCH",
      "The local shared-memory clone origin does not match config.json.",
    );
  }

  const branch = decodeText(
    (
      await runRepositoryGit(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        signal,
      })
    ).stdout,
    "The checked-out Git branch",
  ).trim();
  if (branch !== config.branch) {
    throw new ToolRepositoryError(
      "REPOSITORY_MISMATCH",
      "The local shared-memory clone branch does not match config.json.",
    );
  }

  await runRepositoryGit(
    repoDir,
    ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${config.branch}`],
    { signal },
  );
  const expectedHead = decodeText(
    (
      await runRepositoryGit(repoDir, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], {
        signal,
      })
    ).stdout,
    "The fetched Git revision",
  ).trim();

  return {
    repoDir,
    repoUrl: config.repoUrl,
    branch: config.branch,
    expectedHead,
    effectivePolicy: {
      hardBaseline: HARD_NON_PERSONAL_BASELINE,
      sharingGuidance: config.sharingGuidance,
      guidanceRule: SHARING_GUIDANCE_RULE,
    },
  };
}

export async function withRepositoryRevision<T>(
  pluginDir: string,
  signal: AbortSignal | undefined,
  inspect: (revision: RepositoryRevision) => Promise<T>,
): Promise<T> {
  checkCancellation(signal);
  const config = await readRepositoryConfig(pluginDir);
  const release = await acquireLock(pluginDir);
  try {
    checkCancellation(signal);
    return await inspect(await resolveRevision(pluginDir, config, signal));
  } finally {
    await release();
  }
}

export async function findConceptTreeEntry(
  revision: RepositoryRevision,
  path: string,
  signal?: AbortSignal,
): Promise<ConceptTreeEntry | null> {
  const validated = validateConceptPath(path);
  const tree = await runRepositoryGit(
    revision.repoDir,
    ["ls-tree", "-l", "-z", revision.expectedHead, "--", validated],
    { signal },
  );
  const record = decodeText(tree.stdout, `The Git entry for ${validated}`).replace(/\0$/, "");
  const match = /^(\d{6}) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/.exec(record);
  if (record.length === 0) {
    return null;
  }
  if (!match || match[5] !== validated) {
    throw new ToolRepositoryError("REPOSITORY_ERROR", `Git could not resolve ${validated}.`);
  }
  if ((match[1] !== "100644" && match[1] !== "100755") || match[2] !== "blob") {
    throw new ToolRepositoryError("PATH_ERROR", `${validated} is not a regular Markdown file.`);
  }

  const size = Number.parseInt(match[4], 10);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CONCEPT_FILE_BYTES) {
    throw new ToolRepositoryError(
      "CONTENT_LIMIT",
      `${validated} exceeds the ${MAX_CONCEPT_FILE_BYTES}-byte inspection limit.`,
    );
  }
  return { mode: match[1] as ConceptTreeEntry["mode"], oid: match[3], size };
}

async function readConcept(
  revision: RepositoryRevision,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const validated = validateConceptPath(path);
  const entry = await findConceptTreeEntry(revision, validated, signal);
  if (!entry) {
    throw new ToolRepositoryError("PATH_NOT_FOUND", `No shared concept exists at ${validated}.`);
  }

  const blob = await runRepositoryGit(
    revision.repoDir,
    ["cat-file", "blob", entry.oid],
    { signal },
  );
  if (blob.stdout.length !== entry.size) {
    throw new ToolRepositoryError("REPOSITORY_ERROR", `Git returned an incomplete ${validated}.`);
  }
  const content = decodeText(blob.stdout, validated);
  if (content.includes("\0")) {
    throw new ToolRepositoryError("PATH_ERROR", `${validated} is not a text Markdown file.`);
  }
  return content;
}

export async function readExactConcepts(
  revision: RepositoryRevision,
  paths: string[],
  signal?: AbortSignal,
): Promise<ConceptFile[]> {
  const files: ConceptFile[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    checkCancellation(signal);
    const content = await readConcept(revision, path, signal);
    totalBytes += byteLength(content);
    if (totalBytes > MAX_EXACT_CONTENT_BYTES) {
      throw new ToolRepositoryError(
        "CONTENT_LIMIT",
        `Exact reads may return at most ${MAX_EXACT_CONTENT_BYTES} bytes in one call.`,
      );
    }
    files.push({ path, content });
  }
  return files;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { value, truncated: false };
  }
  const bytes = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function excerptFor(content: string, query: string): { excerpt: string; truncated: boolean } {
  const index = Math.max(content.toLowerCase().indexOf(query.toLowerCase()), 0);
  const start = index > 1_024 ? index - 1_024 : 0;
  const candidate = content.slice(start, Math.max(start, index) + query.length + 3_072);
  const bounded = truncateUtf8(candidate, MAX_QUERY_EXCERPT_BYTES);
  return {
    excerpt: bounded.value,
    truncated: bounded.truncated || start > 0 || start + candidate.length < content.length,
  };
}

export async function searchConcepts(
  revision: RepositoryRevision,
  query: string,
  signal?: AbortSignal,
): Promise<{ matches: ConceptMatch[]; truncated: boolean }> {
  const grep = await runRepositoryGit(
    revision.repoDir,
    [
      "grep",
      "-F",
      "-i",
      "-I",
      "-l",
      "-z",
      "-e",
      query,
      revision.expectedHead,
      "--",
      ":(glob)concepts/*.md",
      ":(glob)concepts/**/*.md",
    ],
    { signal, allowedExitCodes: [0, 1] },
  );
  if (grep.exitCode === 1 || grep.stdout.length === 0) {
    return { matches: [], truncated: false };
  }

  const prefix = `${revision.expectedHead}:`;
  const allPaths = decodeText(grep.stdout, "Git search results")
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry));
  const validPaths: string[] = [];
  for (const path of allPaths) {
    checkCancellation(signal);
    try {
      validPaths.push(validateConceptPath(path));
    } catch (error) {
      if (!(error instanceof ConceptPathError)) {
        throw error;
      }
    }
  }
  const selected = validPaths.slice(0, MAX_QUERY_MATCHES);
  const matches: ConceptMatch[] = [];
  for (const path of selected) {
    checkCancellation(signal);
    const content = await readConcept(revision, path, signal);
    matches.push({ path, ...excerptFor(content, query) });
  }
  return { matches, truncated: validPaths.length > selected.length };
}
