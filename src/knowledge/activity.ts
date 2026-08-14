import { decodeUtf8, runRepositoryGit } from "../shared-memory-repository.js";
import {
  failureResponse,
  jsonResponse,
  KnowledgeError,
  openClone,
  requireBase,
  searchParams,
} from "./base.js";

export const DEFAULT_ACTIVITY_DAYS = 90;
export const MIN_ACTIVITY_DAYS = 1;
export const MAX_ACTIVITY_DAYS = 365;
export const MAX_ACTIVITY_COMMITS = 2_000;
export const MAX_ACTIVITY_FEED = 50;

const DAY_MS = 24 * 60 * 60 * 1_000;

// Record and unit separators frame the commit headers, because a subject may
// hold anything except a newline, and name-status lines are tab-separated.
const COMMIT_MARK = "\u001e";
const FIELD_MARK = "\u001f";
const LOG_FORMAT = `${COMMIT_MARK}%H${FIELD_MARK}%aN${FIELD_MARK}%aI${FIELD_MARK}%s`;

export type EntityKind = "skill" | "page";
export type EntityAction = "added" | "updated" | "removed";

export interface EntityChange {
  kind: EntityKind;
  name: string;
  action: EntityAction;
}

export interface ActivityCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  changes: EntityChange[];
}

export interface ActivityCounts {
  added: number;
  updated: number;
  removed: number;
}

export interface ActivityWeek {
  weekStart: string;
  author: string;
  skills: ActivityCounts;
  pages: ActivityCounts;
}

export interface ActivityReport {
  range: { from: string; to: string };
  weekly: ActivityWeek[];
  commits: ActivityCommit[];
}

export function parseActivityDays(raw: string | null): number {
  if (raw === null || raw.length === 0) {
    return DEFAULT_ACTIVITY_DAYS;
  }
  if (!/^-?\d{1,9}$/.test(raw)) {
    throw new KnowledgeError(400, "INVALID_PARAM", "days must be a whole number.");
  }
  const days = Number.parseInt(raw, 10);
  return Math.min(MAX_ACTIVITY_DAYS, Math.max(MIN_ACTIVITY_DAYS, days));
}

/**
 * The same attribution the digest schedule applies, file by file. A skill is
 * added or removed only when its own SKILL.md is; every other change under its
 * directory is an update, and a rename or copy is an update of the new path.
 */
export function attributeStatusLine(line: string): EntityChange | null {
  const fields = line.split("\t");
  const status = (fields[0] ?? "").charAt(0);
  const path = status === "R" || status === "C" ? fields[2] : fields[1];
  if (!path) {
    return null;
  }

  const skill = /^skills\/([^/]+)\/./.exec(path);
  if (skill) {
    const name = skill[1];
    const manifest = path === `skills/${name}/SKILL.md`;
    if (manifest && status === "A") {
      return { kind: "skill", name, action: "added" };
    }
    if (manifest && status === "D") {
      return { kind: "skill", name, action: "removed" };
    }
    return { kind: "skill", name, action: "updated" };
  }

  const page = /^concepts\/(..*)\.md$/.exec(path);
  if (page) {
    const action = status === "A" ? "added" : status === "D" ? "removed" : "updated";
    return { kind: "page", name: page[1], action };
  }
  return null;
}

// One entity touched twice by one commit is one change, and the SKILL.md
// verdict outranks the update its sibling files imply.
function mergeChange(changes: EntityChange[], change: EntityChange): void {
  const existing = changes.find(
    (candidate) => candidate.kind === change.kind && candidate.name === change.name,
  );
  if (!existing) {
    changes.push(change);
    return;
  }
  if (existing.action === "updated") {
    existing.action = change.action;
  }
}

export function parseActivityLog(output: string): ActivityCommit[] {
  const commits: ActivityCommit[] = [];
  let current: ActivityCommit | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      const fields = line.slice(COMMIT_MARK.length).split(FIELD_MARK);
      if (fields.length < 4) {
        current = null;
        continue;
      }
      current = {
        sha: fields[0],
        author: fields[1],
        date: fields[2],
        subject: fields.slice(3).join(FIELD_MARK),
        changes: [],
      };
      commits.push(current);
      continue;
    }
    if (!current || line.length === 0) {
      continue;
    }
    const change = attributeStatusLine(line);
    if (change) {
      mergeChange(current.changes, change);
    }
  }
  return commits;
}

/** The Monday of the commit's week in UTC, as YYYY-MM-DD. */
export function weekStartOf(date: string): string {
  const instant = new Date(date);
  if (Number.isNaN(instant.getTime())) {
    return "";
  }
  const midnight = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  const weekday = new Date(midnight).getUTCDay();
  return new Date(midnight - ((weekday + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

function emptyCounts(): ActivityCounts {
  return { added: 0, updated: 0, removed: 0 };
}

/**
 * Raw activity, not the digest: every commit contributes its own changes, so
 * an entity edited in five commits counts five times.
 */
export function summarizeWeeks(commits: ActivityCommit[]): ActivityWeek[] {
  const weeks = new Map<string, ActivityWeek>();
  for (const commit of commits) {
    if (commit.changes.length === 0) {
      continue;
    }
    const weekStart = weekStartOf(commit.date);
    const key = `${weekStart} ${commit.author}`;
    let week = weeks.get(key);
    if (!week) {
      week = { weekStart, author: commit.author, skills: emptyCounts(), pages: emptyCounts() };
      weeks.set(key, week);
    }
    for (const change of commit.changes) {
      const counts = change.kind === "skill" ? week.skills : week.pages;
      counts[change.action] += 1;
    }
  }
  return [...weeks.values()].sort(
    (left, right) =>
      left.weekStart.localeCompare(right.weekStart) || left.author.localeCompare(right.author),
  );
}

export async function readActivity(pluginDir: string, days: number): Promise<ActivityReport> {
  const clone = await openClone(pluginDir);
  // A range whose log exceeds the git helper's output budget fails the read
  // rather than reporting a silently truncated one.
  const log = await runRepositoryGit(clone.repoDir, [
    "log",
    "--no-merges",
    "-M",
    `--since=${days}.days`,
    "--date=iso-strict",
    `--max-count=${MAX_ACTIVITY_COMMITS}`,
    `--format=${LOG_FORMAT}`,
    "--name-status",
    clone.head,
  ]);

  const commits = parseActivityLog(decodeUtf8(log.stdout));
  const to = new Date();
  return {
    range: { from: new Date(to.getTime() - days * DAY_MS).toISOString(), to: to.toISOString() },
    weekly: summarizeWeeks(commits),
    commits: commits.slice(0, MAX_ACTIVITY_FEED),
  };
}

export async function handleKnowledgeActivity(
  request: Request,
  pluginDir: string,
): Promise<Response> {
  try {
    const params = searchParams(request);
    const base = requireBase(params);
    const report = await readActivity(pluginDir, parseActivityDays(params.get("days")));
    return jsonResponse({ ok: true, base, ...report });
  } catch (error) {
    return failureResponse(error);
  }
}
