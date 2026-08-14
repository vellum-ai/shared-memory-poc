import type { ChartConfiguration } from "chart.js";
import { useMemo } from "react";

import type { ActionCounts, ActivityResponse, WeeklyActivity } from "../api";
import { fetchActivity } from "../api";
import { ChartCanvas, SERIES_PALETTE, readChartTheme } from "../charts";
import { Card, EmptyState, ErrorBanner, Skeleton } from "../components";
import { EMPTY_COUNTS, addCounts, totalOf, weekLabel } from "../format";
import { useColorSchemeTick, useResource } from "../hooks";

export const DAY_OPTIONS = [30, 90, 180, 365];

interface AuthorTotals {
  author: string;
  skills: ActionCounts;
  pages: ActionCounts;
  total: number;
  /** Series colour, taken from the leaderboard position so no two authors in
   *  the same view can collide. */
  color: string;
}

interface Aggregate {
  weeks: string[];
  authors: AuthorTotals[];
  /** author -> weekStart -> total changes that week. */
  byAuthorWeek: Map<string, Map<string, number>>;
  cumulative: number[];
  grandTotal: number;
}

function aggregate(weekly: WeeklyActivity[]): Aggregate {
  const weeks = [...new Set(weekly.map((row) => row.weekStart))].sort();
  const totals = new Map<string, AuthorTotals>();
  const byAuthorWeek = new Map<string, Map<string, number>>();
  const weekTotals = new Map<string, number>();

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
    const weeksForAuthor = byAuthorWeek.get(row.author) ?? new Map<string, number>();
    weeksForAuthor.set(row.weekStart, (weeksForAuthor.get(row.weekStart) ?? 0) + rowTotal);
    byAuthorWeek.set(row.author, weeksForAuthor);
    weekTotals.set(row.weekStart, (weekTotals.get(row.weekStart) ?? 0) + rowTotal);
  }

  let running = 0;
  const cumulative = weeks.map((week) => {
    running += weekTotals.get(week) ?? 0;
    return running;
  });

  const authors = [...totals.values()]
    .sort((a, b) => b.total - a.total || a.author.localeCompare(b.author))
    .map((entry, index) => ({
      ...entry,
      color: SERIES_PALETTE[index % SERIES_PALETTE.length] ?? SERIES_PALETTE[0] ?? "#3d6df0",
    }));

  return { weeks, authors, byAuthorWeek, cumulative, grandTotal: running };
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
  const themeTick = useColorSchemeTick();

  const data = activity.data;
  const summary = useMemo(() => aggregate(data?.weekly ?? []), [data]);
  const hasData = summary.weeks.length > 0;

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
          <ChartCanvas
            height={260}
            label="Stacked bar chart of changes per week, one colour per author"
            deps={[summary, themeTick]}
            build={() => buildStackedBar(summary)}
          />
        )}
      </Card>

      <Card title="Cumulative changes">
        {data === null && activity.loading ? (
          <Skeleton lines={4} />
        ) : !hasData ? (
          <p class="quiet">Nothing to plot for this range.</p>
        ) : (
          <ChartCanvas
            height={220}
            label="Line chart of total changes accumulating over time"
            deps={[summary, themeTick]}
            build={() => buildCumulativeLine(summary)}
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

function buildStackedBar(summary: Aggregate): ChartConfiguration {
  const theme = readChartTheme();
  return {
    type: "bar",
    data: {
      labels: summary.weeks.map(weekLabel),
      datasets: summary.authors.map((author) => ({
        label: author.author,
        data: summary.weeks.map(
          (week) => summary.byAuthorWeek.get(author.author)?.get(week) ?? 0,
        ),
        backgroundColor: author.color,
        borderWidth: 0,
        borderRadius: 2,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: theme.tick, boxWidth: 10, boxHeight: 10, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: theme.tooltip,
          titleColor: theme.text,
          bodyColor: theme.text,
          borderColor: theme.border,
          borderWidth: 1,
          padding: 8,
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: theme.border },
          ticks: { color: theme.tick, maxRotation: 0, autoSkipPadding: 12 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: { color: theme.tick, precision: 0 },
        },
      },
    },
  };
}

function buildCumulativeLine(summary: Aggregate): ChartConfiguration {
  const theme = readChartTheme();
  const accent = SERIES_PALETTE[0] ?? "#3d6df0";
  return {
    type: "line",
    data: {
      labels: summary.weeks.map(weekLabel),
      datasets: [
        {
          label: "Total changes",
          data: summary.cumulative,
          borderColor: accent,
          backgroundColor: accent,
          fill: false,
          tension: 0.25,
          pointRadius: 2,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: theme.tooltip,
          titleColor: theme.text,
          bodyColor: theme.text,
          borderColor: theme.border,
          borderWidth: 1,
          padding: 8,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: theme.border },
          ticks: { color: theme.tick, maxRotation: 0, autoSkipPadding: 12 },
        },
        y: {
          beginAtZero: true,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: { color: theme.tick, precision: 0 },
        },
      },
    },
  };
}
