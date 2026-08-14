import { Chart, registerables } from "chart.js";
import type { ChartConfiguration } from "chart.js";
import { useEffect, useRef } from "react";

Chart.register(...registerables);

/**
 * Series colours. Fixed hex values rather than CSS variables: chart.js needs a
 * concrete colour per dataset, and these six read against both the light and
 * the dark surface.
 */
export const SERIES_PALETTE = [
  "#3d6df0",
  "#e8833a",
  "#1a9e6c",
  "#9257d8",
  "#d34a6a",
  "#0e9bb0",
  "#b0891a",
  "#5b6bd6",
];

export interface ChartTheme {
  grid: string;
  tick: string;
  text: string;
  surface: string;
  tooltip: string;
  border: string;
}

/**
 * Reads the palette off the root element at render time, so the charts follow
 * the same custom properties as the rest of the page in either colour scheme.
 */
export function readChartTheme(): ChartTheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    grid: read("--chart-grid", "rgba(20, 25, 35, 0.1)"),
    tick: read("--text-muted", "#626b78"),
    text: read("--text", "#16191d"),
    surface: read("--surface", "#ffffff"),
    tooltip: read("--surface-3", "#e9ecf1"),
    border: read("--border-strong", "#c6ccd6"),
  };
}

/**
 * Renders one chart.js instance and destroys it on every rebuild.
 *
 * chart.js keeps a global registry keyed by canvas, so a config change has to
 * destroy the old instance before a new one attaches. Leaving that out leaks
 * canvases and makes the second render throw.
 */
export function ChartCanvas({
  build,
  deps,
  height,
  label,
}: {
  build: () => ChartConfiguration;
  deps: readonly unknown[];
  height: number;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, buildRef.current());

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // The caller decides what invalidates the chart.
  }, [...deps]);

  return (
    <div class="chart-frame" style={{ height: `${height}px` }}>
      <canvas ref={canvasRef} role="img" aria-label={label} />
    </div>
  );
}
