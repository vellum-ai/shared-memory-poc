import { format, formatDistanceToNow, parseISO } from "date-fns";

import type { ActionCounts, ChangeAction, CommitChange } from "./api";

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value.includes("T") ? parseISO(value) : new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "about 2 hours ago", or a fallback when the timestamp is missing or bad. */
export function relativeTime(value: string | null | undefined, fallback = "unknown"): string {
  const date = toDate(value);
  if (!date) return fallback;
  return formatDistanceToNow(date, { addSuffix: true });
}

/** Absolute timestamp for the `title` attribute beside a relative one. */
export function absoluteTime(value: string | null | undefined): string | undefined {
  const date = toDate(value);
  return date ? format(date, "PPpp") : undefined;
}

/** Short week label for a chart axis, from a `YYYY-MM-DD` week start. */
export function weekLabel(weekStart: string): string {
  const date = toDate(weekStart);
  return date ? format(date, "MMM d") : weekStart;
}

/** Compact duration for lock ages: "45s", "12m", "2h 05m". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return "none";
  return sha.slice(0, 7);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export const ACTION_SIGN: Record<ChangeAction, string> = {
  added: "+",
  updated: "~",
  removed: "−",
};

export function totalOf(counts: ActionCounts): number {
  return counts.added + counts.updated + counts.removed;
}

export const EMPTY_COUNTS: ActionCounts = { added: 0, updated: 0, removed: 0 };

export function addCounts(a: ActionCounts, b: ActionCounts): ActionCounts {
  return {
    added: a.added + b.added,
    updated: a.updated + b.updated,
    removed: a.removed + b.removed,
  };
}

/**
 * Repo path for a change reported by `/activity`.
 *
 * Assumption, from the content-repo layout in the README: a page named
 * `team/oncall` lives at `concepts/team/oncall.md`, and a skill named
 * `rollback` lives at `skills/rollback/SKILL.md`.
 */
export function changePath(change: CommitChange): string {
  return change.kind === "page"
    ? `concepts/${change.name}.md`
    : `skills/${change.name}/SKILL.md`;
}

/** Slug shown for a repo path in the browser list. */
export function pathLabel(path: string): string {
  if (path.startsWith("concepts/") && path.endsWith(".md")) {
    return path.slice("concepts/".length, -".md".length);
  }
  if (path.startsWith("skills/") && path.endsWith("/SKILL.md")) {
    return path.slice("skills/".length, -"/SKILL.md".length);
  }
  return path;
}
