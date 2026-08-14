import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ConceptPathError, MAX_CONCEPT_FILE_BYTES } from "../concept-path.js";
import {
  decodeUtf8,
  runRepositoryGit,
  SharedMemoryRepositoryError,
} from "../shared-memory-repository.js";

/**
 * Read-only reads of the clone sync maintains, for the knowledge dashboard.
 *
 * Nothing here fetches, locks, or writes. The dashboard reports the clone as
 * sync last left it, so a request never competes with a sync run and never
 * needs the network.
 *
 * config.json describes exactly one knowledge base today, so every route
 * accepts `?base=` and answers for this one id. The parameter exists so a
 * second base can be added without changing the URLs.
 */
export const DEFAULT_BASE_ID = "default";

const MAX_REFLECTED_PARAM_CHARS = 64;

export class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

// Repository failures a later request may recover from answer 503; the rest
// describe the request itself.
const REPOSITORY_ERROR_STATUS: Record<string, number> = {
  PATH_NOT_FOUND: 404,
  PATH_ERROR: 400,
  CONTENT_LIMIT: 413,
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, error: { code, message } }, status);
}

/** Every route handler ends here, because a route that throws becomes a 500. */
export function failureResponse(error: unknown): Response {
  if (error instanceof KnowledgeError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof ConceptPathError) {
    return errorResponse(400, "INVALID_PATH", error.message);
  }
  if (error instanceof SharedMemoryRepositoryError) {
    return errorResponse(REPOSITORY_ERROR_STATUS[error.code] ?? 503, error.code, error.message);
  }
  return errorResponse(
    503,
    "REPOSITORY_ERROR",
    "The knowledge dashboard could not read the shared content clone.",
  );
}

function reflect(value: string): string {
  return value.length > MAX_REFLECTED_PARAM_CHARS
    ? `${value.slice(0, MAX_REFLECTED_PARAM_CHARS)}…`
    : value;
}

export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function requireBase(params: URLSearchParams): string {
  const requested = params.get("base");
  if (requested !== null && requested !== DEFAULT_BASE_ID) {
    throw new KnowledgeError(
      404,
      "UNKNOWN_BASE",
      `This install has no knowledge base named "${reflect(requested)}".`,
    );
  }
  return DEFAULT_BASE_ID;
}

export interface KnowledgeClone {
  repoDir: string;
  head: string;
}

export function cloneDir(pluginDir: string): string {
  return join(pluginDir, "data", "repo");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the clone's checked-out HEAD. The remote is never consulted. */
export async function openClone(pluginDir: string): Promise<KnowledgeClone> {
  const repoDir = cloneDir(pluginDir);
  if (!(await pathExists(join(repoDir, ".git")))) {
    throw new KnowledgeError(
      503,
      "CLONE_MISSING",
      "The shared content clone does not exist yet. It appears once sync has run.",
    );
  }
  const head = decodeUtf8(
    (await runRepositoryGit(repoDir, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout,
  ).trim();
  if (head.length === 0) {
    throw new KnowledgeError(
      503,
      "CLONE_MISSING",
      "The shared content clone holds no commit yet.",
    );
  }
  return { repoDir, head };
}

/** Returns the trimmed watermark file, or null when it is missing or empty. */
export async function readWatermark(pluginDir: string, name: string): Promise<string | null> {
  try {
    const value = (await readFile(join(pluginDir, "data", name), "utf8")).trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export interface TreeBlob {
  oid: string;
  size: number;
}

const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/;

export async function findBlob(
  clone: KnowledgeClone,
  path: string,
): Promise<TreeBlob | null> {
  const tree = await runRepositoryGit(clone.repoDir, [
    "ls-tree",
    "-l",
    "-z",
    clone.head,
    "--",
    path,
  ]);
  const record = decodeUtf8(tree.stdout).replace(/\0$/, "");
  if (record.length === 0) {
    return null;
  }
  const match = TREE_ENTRY.exec(record);
  if (!match || match[5] !== path) {
    throw new KnowledgeError(503, "REPOSITORY_ERROR", `Git could not resolve ${path}.`);
  }
  if ((match[1] !== "100644" && match[1] !== "100755") || match[2] !== "blob") {
    throw new KnowledgeError(400, "INVALID_PATH", `${path} is not a regular Markdown file.`);
  }
  const size = Number.parseInt(match[4], 10);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new KnowledgeError(503, "REPOSITORY_ERROR", `Git returned an invalid size for ${path}.`);
  }
  return { oid: match[3], size };
}

/** Reads a concept blob at HEAD, under the same size limit publishing uses. */
export async function readBlobAtHead(clone: KnowledgeClone, path: string): Promise<string> {
  const blob = await findBlob(clone, path);
  if (!blob) {
    throw new KnowledgeError(404, "PATH_NOT_FOUND", `No shared page exists at ${path}.`);
  }
  if (blob.size > MAX_CONCEPT_FILE_BYTES) {
    throw new KnowledgeError(
      413,
      "CONTENT_LIMIT",
      `${path} exceeds the ${MAX_CONCEPT_FILE_BYTES}-byte read limit.`,
    );
  }
  const content = await runRepositoryGit(clone.repoDir, ["cat-file", "blob", blob.oid]);
  try {
    return decodeUtf8(content.stdout);
  } catch {
    throw new KnowledgeError(400, "INVALID_PATH", `${path} is not UTF-8 Markdown.`);
  }
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
