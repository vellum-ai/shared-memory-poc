/**
 * Typed client for the shared-memory knowledge routes.
 *
 * Every call goes through `window.vellum.fetch`, the bridge the host injects
 * into the app's sandboxed iframe. The global `fetch` is not usable from the
 * sandbox origin, so it is never used here.
 *
 * Every route answers with `{ok: true, ...}` or
 * `{ok: false, error: {code, message}}`. `request` unwraps that envelope and
 * turns both transport failures and `ok: false` bodies into an `ApiError`, so
 * callers only deal with the success shape.
 */

const ROUTE_PREFIX = "/x/plugins/shared-memory/knowledge";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** Human-readable text for anything a fetch can reject or resolve with. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface BaseCounts {
  skills: number;
  pages: number;
}

export interface BaseHealth {
  lockPresent: boolean;
  /** Age of the sync lock. Absent or null when no lock is held. */
  lockAgeMs: number | null;
  identityConfigured: boolean;
}

export type DigestMode = "deterministic" | "llm";

export interface KnowledgeBase {
  id: string;
  configured: boolean;
  /** Null until the base has a `repoUrl` in config.json. */
  repoUrl: string | null;
  branch: string | null;
  clonePresent: boolean;
  /** Commit the assistant is synced to, or null before the first sync. */
  syncedHead: string | null;
  /** ISO-8601 timestamp of the last successful sync, or null. */
  syncedAt: string | null;
  /** Commit the last digest reported through, or null before the baseline. */
  digestHead: string | null;
  digestMode: DigestMode;
  /** Null when neither config.json nor the guardian contact supplies one. */
  author: CommitAuthor | null;
  /** Null when the clone is missing, so nothing can be counted. */
  counts: BaseCounts | null;
  health: BaseHealth;
}

export interface SummaryResponse {
  bases: KnowledgeBase[];
}

export type ChangeKind = "skill" | "page";
export type ChangeAction = "added" | "updated" | "removed";

export interface CommitChange {
  kind: ChangeKind;
  /** Skill directory name, or page slug without the `concepts/` prefix. */
  name: string;
  action: ChangeAction;
}

export interface ActivityCommit {
  sha: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  changes: CommitChange[];
}

export interface ActionCounts {
  added: number;
  updated: number;
  removed: number;
}

export interface WeeklyActivity {
  /** Monday of the week, `YYYY-MM-DD`. */
  weekStart: string;
  author: string;
  skills: ActionCounts;
  pages: ActionCounts;
}

export interface ActivityResponse {
  base: string;
  range: { from: string; to: string };
  /** One row per (week, author) pair. */
  weekly: WeeklyActivity[];
  /** The 50 newest commits, newest first. */
  commits: ActivityCommit[];
}

export interface PageResponse {
  base: string;
  path: string;
  /** Raw markdown, optionally led by a YAML frontmatter block. */
  content: string;
}

export interface SearchMatch {
  path: string;
  excerpt: string;
  truncated: boolean;
}

export interface SearchResponse {
  base: string;
  matches: SearchMatch[];
  /** True when the match list itself was cut short. */
  truncated: boolean;
}

export type DigestStatus =
  | "unconfigured"
  | "no-sync"
  | "baselined"
  | "no-changes"
  | "changes";

export interface DigestNameLists {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface DigestAuthor {
  author: string;
  skills: DigestNameLists;
  pages: DigestNameLists;
}

export interface DigestCommit {
  author: string;
  subject: string;
}

export interface PendingDigest {
  status: DigestStatus;
  mode?: DigestMode;
  range?: { start: string; end: string };
  dedupeKey?: string;
  /** Present only for status `changes`. */
  authors?: DigestAuthor[];
  commits?: DigestCommit[];
}

export interface PendingResponse {
  base: string;
  digest: PendingDigest;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type QueryValue = string | number | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function readEnvelopeError(body: unknown): ApiError | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return new ApiError(
    typeof code === "string" ? code : "UNKNOWN",
    typeof message === "string" ? message : "The request failed.",
  );
}

async function request<T>(
  path: string,
  params: Record<string, QueryValue> = {},
): Promise<T> {
  let response;
  try {
    response = await window.vellum.fetch(
      `${ROUTE_PREFIX}${path}${queryString(params)}`,
    );
  } catch (cause) {
    throw new ApiError(
      "UNREACHABLE",
      `Could not reach the plugin: ${errorMessage(cause)}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      "BAD_RESPONSE",
      `The plugin answered ${response.status} ${response.statusText} with a body that is not JSON.`,
    );
  }

  const envelopeError = readEnvelopeError(body);
  if (envelopeError) throw envelopeError;

  const ok =
    typeof body === "object" &&
    body !== null &&
    (body as { ok?: unknown }).ok === true;

  if (!ok) {
    throw new ApiError(
      "BAD_RESPONSE",
      `The plugin answered ${response.status} ${response.statusText} with an unexpected body.`,
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function fetchSummary(): Promise<SummaryResponse> {
  return request<SummaryResponse>("/summary");
}

export function fetchActivity(
  base: string,
  days: number,
): Promise<ActivityResponse> {
  return request<ActivityResponse>("/activity", { base, days });
}

export function fetchPage(base: string, path: string): Promise<PageResponse> {
  return request<PageResponse>("/page", { base, path });
}

export function fetchSearch(
  base: string,
  q: string,
): Promise<SearchResponse> {
  return request<SearchResponse>("/search", { base, q });
}

export function fetchPending(base: string): Promise<PendingResponse> {
  return request<PendingResponse>("/pending", { base });
}
