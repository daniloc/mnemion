// The chart vocabulary shared by BOTH renderers — the in-hive Recharts renderer
// (web/src/Chart.tsx) and the server SVG renderer (chart-svg.ts, public pages +
// OG cards). One home for: the mark set, the categorical color palette (so the
// same dataset reads identically in-hive and on a published page), and the
// long→wide pivot that turns multi-dimension aggregate rows into per-series
// columns. Pure data, zero env deps — bundled into both worker and SPA.

export const CHART_MARKS = ["bar", "line", "area", "scatter", "pie", "donut"] as const;
export type ChartMark = (typeof CHART_MARKS)[number];

// Mark categories — which machinery a mark needs. Derived from, never duplicated.
export const CONTINUOUS_MARKS = new Set<string>(["line", "area", "scatter"]); // numeric/time x to scale
export const ROUND_MARKS = new Set<string>(["pie", "donut"]); // no axes; slices of a whole
export const STACKABLE_MARKS = new Set<string>(["bar", "area"]); // `stack` applies here

export function isChartMark(s: string): s is ChartMark {
  return (CHART_MARKS as readonly string[]).includes(s);
}

// Categorical palette — the notebook accent first, then a tuned spread that holds
// up on the warm paper background (#f1efe8). Cycled by index for series/slices.
export const SERIES_COLORS = [
  "#cf4a1a", // accent — terracotta
  "#2f6f6a", // pine
  "#c79a3a", // ochre
  "#6a5aa6", // plum
  "#3f7cac", // slate blue
  "#9c4f4f", // brick
  "#5c8a3a", // moss
  "#b0683a", // clay
  "#4a4a8a", // indigo
  "#a23a6e", // magenta-mute
];

export function seriesColor(i: number): string {
  return SERIES_COLORS[((i % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length];
}

// Compact number formatting shared by axes, labels, and tooltips (no Intl on the
// server SVG path — keep one deterministic implementation).
export function compactNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K";
  return String(Math.round(n));
}

// Long rows [{ [xKey]: x, [seriesKey]: s, [valueKey]: v }, ...] from a two-facet
// aggregate → wide rows [{ [xKey]: x, [s1]: v, [s2]: v, ... }] plus the ordered
// list of series keys (first-seen order). Missing cells are 0-filled so stacked
// marks and multi-line charts don't tear. x order is first-seen (the caller
// sorts the aggregate by x, so this preserves it).
export function pivotSeries(
  rows: Record<string, unknown>[],
  xKey: string,
  seriesKey: string,
  valueKey = "value",
): { rows: Record<string, unknown>[]; keys: string[] } {
  const keys: string[] = [];
  const byX = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const r of rows) {
    const xv = r[xKey] ?? "";
    const xk = String(xv);
    const sv = String(r[seriesKey] ?? "");
    if (!byX.has(xk)) { byX.set(xk, { [xKey]: xv }); order.push(xk); }
    if (sv && !keys.includes(sv)) keys.push(sv);
    if (sv) byX.get(xk)![sv] = Number(r[valueKey]) || 0;
  }
  const out = order.map((xk) => {
    const row = byX.get(xk)!;
    for (const k of keys) if (!(k in row)) row[k] = 0;
    return row;
  });
  return { rows: out, keys };
}
