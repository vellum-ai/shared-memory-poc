import { useMemo } from "react";

import type { ActionCounts, ActivityResponse, WeeklyActivity } from "../api";
import { fetchActivity } from "../api";
import {
  ChartLegend,
  type ChartSeries,
  LineChart,
  OTHER_SERIES_COLOR,
  SERIES_SLOTS,
  StackedBarChart,
  seriesColor,
} from "../charts";
import { Card, EmptyState, ErrorBanner, Skeleton } from "../components";
import { EMPTY_COUNTS, addCounts, totalOf, weekLabel } from "../format";
import { useResource } from "../hooks";

export const DAY_OPTIONS = [30, 90, 180, 365];

const OTHER_LABEL = "Other";

interface AuthorTotals {
  author: string;
  skills: ActionCounts;
  pages: ActionCounts;
  total: number;
  color: string;
}

interface Aggregate {
  weeks: string[];
  /** Leaderboard rows, sorted by total. */
  authors: AuthorTotals[];
  /** Chart series in slot order; authors beyond the slots fold into Other. */
  series: ChartSeries[];
  cumulative: number[];
  grandTotal: number;
}

function aggregate(weekly: WeeklyActivity[]): Aggregate {
  const weeks = [...new Set(weekly.map((row) => row.weekStart))].sort();
  const weekIndex = new Map(weeks.map((week, i) => [week, i]));
  const totals = new Map<string, AuthorTotals>();
  const byAuthorWeek = new Map<string, number[]>();
  const weekTotals = weeks.map(() => 0);

  for (const row of weekly) {
    const existing =
      totals.get(row.author) ??
      { author: row.author, skills: EMPTY_COUNTS, pages: EMPTY_COUNTS, total: 0, color: "" };
    const skills = addCounts(existing.skills, row.skills);
    const pages = addCounts(existing.pages, row.pages);
    totals.set(row.author, {
      author: row.author,
      skills,
      pages,
      total: totalOf(skills) + totalOf(pages),
      color: "",
    });

    const rowTotal = totalOf(row.skills) + totalOf(row.pages);
    const column = weekIndex.get(row.weekStart) ?? 0;
    const values = byAuthorWeek.get(row.author) ?? weeks.map(() => 0);
    values[column] += rowTotal;
    byAuthorWeek.set(row.author, values);
    weekTotals[column] += rowTotal;
  }

  let running = 0;
  const cumulative = weekTotals.map((total) => {
    running += total;
    return running;
  });

  // Slots are assigned alphabetically, so an author keeps their color when the
  // day window changes and the set of visible authors shifts around them.
  // Anyone past the last slot folds into one muted Other series.
  const alphabetical = [...totals.keys()].sort((a, b) => a.localeCompare(b));
  const slotted = alphabetical.slice(0, SERIES_SLOTS);
  const folded = alphabetical.slice(SERIES_SLOTS);
  const colorOf = new Map(slotted.map((author, slot) => [author, seriesColor(slot)]));

  const series: ChartSeries[] = slotted.map((author) => ({
    name: author,
    color: colorOf.get(author) ?? OTHER_SERIES_COLOR,
    values: byAuthorWeek.get(author) ?? weeks.map(() => 0),
  }));
  if (folded.length > 0) {
    const other = weeks.map(() => 0);
    for (const author of folded) {
      const values = byAuthorWeek.get(author) ?? [];
      values.forEach((value, i) => {
        other[i] += value;
      });
    }
    series.push({ name: OTHER_LABEL, color: OTHER_SERIES_COLOR, values: other });
  }

  const authors = [...totals.values()]
    .sort((a, b) => b.total - a.total || a.author.localeCompare(b.author))
    .map((entry) => ({
      ...entry,
      color: colorOf.get(entry.author) ?? OTHER_SERIES_COLOR,
    }));

  return { weeks, authors, series, cumulative, grandTotal: running };
}

export function ContributorsTab({
  baseId,
  days,
  onDaysChange,
}: {
  baseId: string;
  days: number;
  onDaysChange: (days: number) => void;
}) {
  const activity = useResource<ActivityResponse>(
    () => fetchActivity(baseId, days),
    [baseId, days],
  );

  const data = activity.data;
  const summary = useMemo(() => aggregate(data?.weekly ?? []), [data]);
  const hasData = summary.weeks.length > 0;
  const labels = summary.weeks.map(weekLabel);

  const daySelector = (
    <div class="segmented" role="group" aria-label="Time range">
      {DAY_OPTIONS.map((option) => (
        <button
          class={option === days ? "segment segment-on" : "segment"}
          type="button"
          key={option}
          aria-pressed={option === days}
          onClick={() => onDaysChange(option)}
        >
          {option}d
        </button>
      ))}
    </div>
  );

  return (
    <div class="stack">
      <ErrorBanner message={activity.error} onRetry={activity.reload} />

      <Card title="Changes per week" actions={daySelector}>
        {data === null && activity.loading ? (
          <Skeleton lines={5} />
        ) : !hasData ? (
          <EmptyState title="No activity in this range.">
            <p>Pick a longer range, or wait for the next sync to bring commits in.</p>
          </EmptyState>
        ) : (
          <>
            <StackedBarChart
              labels={labels}
              series={summary.series}
              height={260}
              ariaLabel="Stacked bar chart of changes per week, one color per author"
            />
            <ChartLegend series={summary.series} />
          </>
        )}
      </Card>

      <Card title="Cumulative changes">
        {data === null && activity.loading ? (
          <Skeleton lines={4} />
        ) : !hasData ? (
          <p class="quiet">Nothing to plot for this range.</p>
        ) : (
          <LineChart
            labels={labels}
            values={summary.cumulative}
            height={220}
            ariaLabel="Line chart of total changes accumulating over time"
          />
        )}
      </Card>

      <Card title="Leaderboard">
        {data === null && activity.loading ? (
          <Skeleton lines={4} />
        ) : summary.authors.length === 0 ? (
          <p class="quiet">No contributors in this range.</p>
        ) : (
          <Leaderboard authors={summary.authors} grandTotal={summary.grandTotal} />
        )}
      </Card>
    </div>
  );
}

function Leaderboard({
  authors,
  grandTotal,
}: {
  authors: AuthorTotals[];
  grandTotal: number;
}) {
  return (
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr class="group-row">
            <td />
            <th scope="colgroup" colSpan={3} class="group-head">
              Skills
            </th>
            <th scope="colgroup" colSpan={3} class="group-head">
              Pages
            </th>
            <td />
          </tr>
          <tr>
            <th scope="col">Author</th>
            <th scope="col" class="num">Added</th>
            <th scope="col" class="num">Updated</th>
            <th scope="col" class="num">Removed</th>
            <th scope="col" class="num">Added</th>
            <th scope="col" class="num">Updated</th>
            <th scope="col" class="num">Removed</th>
            <th scope="col" class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {authors.map((row) => (
            <tr key={row.author}>
              <th scope="row" class="author-cell">
                <span class="swatch" style={{ background: row.color }} aria-hidden="true" />
                {row.author}
              </th>
              <td class="num">{row.skills.added}</td>
              <td class="num">{row.skills.updated}</td>
              <td class="num">{row.skills.removed}</td>
              <td class="num">{row.pages.added}</td>
              <td class="num">{row.pages.updated}</td>
              <td class="num">{row.pages.removed}</td>
              <td class="num strong">{row.total}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All authors</th>
            <td class="num" />
            <td class="num" />
            <td class="num" />
            <td class="num" />
            <td class="num" />
            <td class="num" />
            <td class="num strong">{grandTotal}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
