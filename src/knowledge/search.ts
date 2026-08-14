import { ConceptPathError, validateConceptPath } from "../concept-path.js";
import {
  decodeUtf8,
  MAX_QUERY_BYTES,
  MAX_QUERY_MATCHES,
  runRepositoryGit,
} from "../shared-memory-repository.js";
import {
  byteLength,
  failureResponse,
  jsonResponse,
  KnowledgeError,
  type KnowledgeClone,
  openClone,
  readBlobAtHead,
  requireBase,
  searchParams,
} from "./base.js";

export const MAX_EXCERPT_CHARS = 300;
const EXCERPT_LEAD_CHARS = 100;

export interface KnowledgeMatch {
  path: string;
  excerpt: string;
  truncated: boolean;
}

export function parseQuery(raw: string | null): string {
  const query = (raw ?? "").trim();
  if (query.length === 0) {
    throw new KnowledgeError(400, "INVALID_QUERY", "q must be non-empty text.");
  }
  if (query.includes("\0") || byteLength(query) > MAX_QUERY_BYTES) {
    throw new KnowledgeError(
      400,
      "INVALID_QUERY",
      `q may be at most ${MAX_QUERY_BYTES} UTF-8 bytes.`,
    );
  }
  return query;
}

/** A window around the first case-insensitive hit, flagged when it is clipped. */
export function excerptAround(content: string, query: string): Omit<KnowledgeMatch, "path"> {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, (index < 0 ? 0 : index) - EXCERPT_LEAD_CHARS);
  const end = Math.min(content.length, start + MAX_EXCERPT_CHARS);
  return { excerpt: content.slice(start, end), truncated: start > 0 || end < content.length };
}

async function grepPaths(clone: KnowledgeClone, query: string): Promise<string[]> {
  const grep = await runRepositoryGit(
    clone.repoDir,
    [
      "grep",
      "-F",
      "-i",
      "-I",
      "-l",
      "-z",
      "-e",
      query,
      clone.head,
      "--",
      ":(glob)concepts/*.md",
      ":(glob)concepts/**/*.md",
    ],
    // git grep reports "nothing matched" as exit 1, which is an answer.
    { allowedExitCodes: [0, 1] },
  );
  if (grep.exitCode === 1 || grep.stdout.length === 0) {
    return [];
  }

  const prefix = `${clone.head}:`;
  const paths: string[] = [];
  for (const entry of decodeUtf8(grep.stdout).split("\0")) {
    if (entry.length === 0) {
      continue;
    }
    const path = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
    try {
      paths.push(validateConceptPath(path));
    } catch (error) {
      if (!(error instanceof ConceptPathError)) {
        throw error;
      }
    }
  }
  return paths;
}

export async function searchKnowledge(
  pluginDir: string,
  query: string,
): Promise<{ matches: KnowledgeMatch[]; truncated: boolean }> {
  const clone = await openClone(pluginDir);
  const paths = await grepPaths(clone, query);
  const selected = paths.slice(0, MAX_QUERY_MATCHES);
  const matches: KnowledgeMatch[] = [];
  for (const path of selected) {
    try {
      matches.push({ path, ...excerptAround(await readBlobAtHead(clone, path), query) });
    } catch (error) {
      // A page too large to excerpt is still a hit worth naming, so it is
      // reported without one rather than failing the whole search.
      if (!(error instanceof KnowledgeError) || error.code !== "CONTENT_LIMIT") {
        throw error;
      }
      matches.push({ path, excerpt: "", truncated: true });
    }
  }
  return { matches, truncated: paths.length > selected.length };
}

export async function handleKnowledgeSearch(
  request: Request,
  pluginDir: string,
): Promise<Response> {
  try {
    const params = searchParams(request);
    const base = requireBase(params);
    const result = await searchKnowledge(pluginDir, parseQuery(params.get("q")));
    return jsonResponse({ ok: true, base, ...result });
  } catch (error) {
    return failureResponse(error);
  }
}
