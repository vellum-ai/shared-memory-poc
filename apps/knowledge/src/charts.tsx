/**
 * Dependency-free SVG charts.
 *
 * The runtime's bundler allowlists chart.js but its 5 MB package cap rejects
 * the installed size, so the import can never resolve in a deployed build.
 * These two components cover what the dashboard needs, and theming rides on
 * CSS custom properties: every color below is a var() reference, so dark mode
 * needs no JavaScript at all.
 */

/**
 * Categorical series slots, assigned to authors in a fixed order. The hex
 * values live in styles.css (light and dark are separate, validated steps);
 * the slot ORDER is part of the palette's colorblind-safety and must not be
 * shuffled. Series beyond the last slot fold into "Other".
 */
export const SERIES_SLOTS = 8;

export function seriesColor(slot: number): string {
  return `var(--viz-${Math.min(slot, SERIES_SLOTS - 1) + 1})`;
}

export const OTHER_SERIES_COLOR = "var(--viz-other)";

export interface ChartSeries {
  name: string;
  color: string;
  /** One value per label, aligned by index. */
  values: number[];
}

const WIDTH = 800;
const PAD = { top: 10, right: 26, bottom: 22, left: 36 };
/** Surface gap between stacked segments and between adjacent bars. */
const GAP = 2;

/** Round the axis ceiling up to 1/2/5 × 10^k so tick labels stay clean. */
function niceCeil(value: number): number {
  if (value <= 4) return Math.max(value, 1);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function ticksFor(max: number): number[] {
  // niceCeil yields 1/2/5 × 10^k, so one of these counts always divides max
  // exactly and every label sits on its own gridline.
  const count = max <= 4 ? max : max % 4 === 0 ? 4 : max % 5 === 0 ? 5 : 4;
  const ticks: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    ticks.push(Math.round((max / count) * i));
  }
  return [...new Set(ticks)];
}

/** Indexes of the x labels to render, thinned so ~70px separates them. */
function labelIndexes(count: number, plotWidth: number): Set<number> {
  const fit = Math.max(2, Math.floor(plotWidth / 70));
  if (count <= fit) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = (count - 1) / (fit - 1);
  const chosen = new Set<number>();
  for (let i = 0; i < fit; i += 1) {
    chosen.add(Math.round(i * step));
  }
  return chosen;
}

/** A bar with only its top corners rounded, anchored to the segment below. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2);
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

function Grid({
  ticks,
  max,
  plotHeight,
}: {
  ticks: number[];
  max: number;
  plotHeight: number;
}) {
  return (
    <g>
      {ticks.map((tick) => {
        const y = PAD.top + plotHeight - (tick / max) * plotHeight;
        return (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y}
              y2={y}
              stroke="var(--chart-grid)"
              stroke-width="1"
            />
            <text x={PAD.left - 6} y={y + 3.5} class="viz-tick" text-anchor="end">
              {tick}
            </text>
          </g>
        );
      })}
      <line
        x1={PAD.left}
        x2={WIDTH - PAD.right}
        y1={PAD.top + plotHeight}
        y2={PAD.top + plotHeight}
        stroke="var(--chart-axis)"
        stroke-width="1"
      />
    </g>
  );
}

export function StackedBarChart({
  labels,
  series,
  height,
  ariaLabel,
}: {
  labels: string[];
  series: ChartSeries[];
  height: number;
  ariaLabel: string;
}) {
  const plotHeight = height - PAD.top - PAD.bottom;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const columnTotals = labels.map((_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const max = niceCeil(Math.max(1, ...columnTotals));
  const slot = plotWidth / Math.max(1, labels.length);
  const barWidth = Math.max(4, Math.min(40, slot - GAP));
  const shownLabels = labelIndexes(labels.length, plotWidth);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      class="viz"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      <Grid ticks={ticksFor(max)} max={max} plotHeight={plotHeight} />
      {labels.map((label, column) => {
        const x = PAD.left + column * slot + (slot - barWidth) / 2;
        const baseline = PAD.top + plotHeight;
        // Topmost non-zero segment gets the rounded data-end.
        const topIndex = series.reduce(
          (top, s, i) => ((s.values[column] ?? 0) > 0 ? i : top),
          -1,
        );
        let usedHeight = 0;
        return (
          <g key={label}>
            {series.map((s, i) => {
              const value = s.values[column] ?? 0;
              if (value <= 0) return null;
              const rawHeight = (value / max) * plotHeight;
              const y = baseline - usedHeight - rawHeight;
              usedHeight += rawHeight;
              const isTop = i === topIndex;
              // Every segment below the top one gives up 2px of its own top
              // edge, so a surface gap separates it from the segment above.
              const segmentHeight = Math.max(rawHeight - (isTop ? 0 : GAP), 1);
              const title = `${s.name} — ${label}: ${value}`;
              if (isTop) {
                return (
                  <path key={s.name} d={topRoundedRect(x, y, barWidth, segmentHeight, 3)} fill={s.color}>
                    <title>{title}</title>
                  </path>
                );
              }
              return (
                <rect key={s.name} x={x} y={y + GAP} width={barWidth} height={segmentHeight} fill={s.color}>
                  <title>{title}</title>
                </rect>
              );
            })}
            {shownLabels.has(column) ? (
              <text
                x={x + barWidth / 2}
                y={baseline + 14}
                class="viz-tick"
                text-anchor="middle"
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({
  labels,
  values,
  height,
  ariaLabel,
  color = "var(--viz-1)",
}: {
  labels: string[];
  values: number[];
  height: number;
  ariaLabel: string;
  color?: string;
}) {
  const plotHeight = height - PAD.top - PAD.bottom;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const max = niceCeil(Math.max(1, ...values));
  const shownLabels = labelIndexes(labels.length, plotWidth);
  const pointX = (i: number) =>
    labels.length === 1
      ? PAD.left + plotWidth / 2
      : PAD.left + (i / (labels.length - 1)) * plotWidth;
  const pointY = (value: number) => PAD.top + plotHeight - (value / max) * plotHeight;
  const path = values
    .map((value, i) => `${i === 0 ? "M" : "L"}${pointX(i).toFixed(1)},${pointY(value).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      class="viz"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      <Grid ticks={ticksFor(max)} max={max} plotHeight={plotHeight} />
      <path d={path} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" />
      {values.map((value, i) => (
        <circle key={labels[i]} cx={pointX(i)} cy={pointY(value)} r="3" fill={color}>
          <title>{`${labels[i]}: ${value}`}</title>
        </circle>
      ))}
      {labels.map((label, i) =>
        shownLabels.has(i) ? (
          <text key={label} x={pointX(i)} y={PAD.top + plotHeight + 14} class="viz-tick" text-anchor="middle">
            {label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div class="viz-legend" role="list">
      {series.map((s) => (
        <span class="viz-legend-item" role="listitem" key={s.name}>
          <span class="swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.name}
        </span>
      ))}
    </div>
  );
}
