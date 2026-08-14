import type { ActionCounts, ChangeAction, CommitChange } from "./api";

// Hand-rolled date helpers. The runtime's bundler allowlists date-fns but its
// 5 MB package cap rejects the installed size, so the import can never
// resolve in a deployed build. Everything the app needs fits here.

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value.includes("T") ? new Date(value) : new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const RELATIVE_STEPS: Array<{ ms: number; singular: string; plural: string }> = [
  { ms: 365 * 24 * 3_600_000, singular: "a year", plural: "years" },
  { ms: 30 * 24 * 3_600_000, singular: "a month", plural: "months" },
  { ms: 7 * 24 * 3_600_000, singular: "a week", plural: "weeks" },
  { ms: 24 * 3_600_000, singular: "a day", plural: "days" },
  { ms: 3_600_000, singular: "an hour", plural: "hours" },
  { ms: 60_000, singular: "a minute", plural: "minutes" },
];

/** "2 hours ago", or a fallback when the timestamp is missing or bad. */
export function relativeTime(value: string | null | undefined, fallback = "unknown"): string {
  const date = toDate(value);
  if (!date) return fallback;
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 0) return "just now";
  for (const step of RELATIVE_STEPS) {
    if (elapsed >= step.ms) {
      const count = Math.floor(elapsed / step.ms);
      return count === 1 ? `${step.singular} ago` : `${count} ${step.plural} ago`;
    }
  }
  return "just now";
}

/** Absolute timestamp for the `title` attribute beside a relative one. */
export function absoluteTime(value: string | null | undefined): string | undefined {
  const date = toDate(value);
  return date
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : undefined;
}

/** Short week label for a chart axis, from a `YYYY-MM-DD` week start. */
export function weekLabel(weekStart: string): string {
  const date = toDate(weekStart);
  return date
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : weekStart;
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
