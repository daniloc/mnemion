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

// Mark-category membership — the single home both renderers MUST agree on (was
// re-inlined as `mark === "bar" || mark === "area"` etc. in three files). Adding a
// mark to a set above now flows to every renderer through these.
export function isRound(mark: string): boolean { return ROUND_MARKS.has(mark); }
export function isContinuous(mark: string): boolean { return CONTINUOUS_MARKS.has(mark); }
export function isStackable(mark: string): boolean { return STACKABLE_MARKS.has(mark); }

// The label NULL/empty series values bucket under, so a row with no series value
// is named rather than silently dropped from the chart.
export const SERIES_NONE = "—";

// A group field may carry a `:unit` datetime bucket (e.g. "created_at:month"). The
// query engine GROUPs BY the full "facet:unit" but aliases the OUTPUT column to the
// bare facet — so the GROUP BY uses the full field while the sort field, the row
// read-key, and the pivot/dataKey must use the bare facet. Split once, here.
export function groupKey(field: string): string {
  const i = field.indexOf(":");
  return i === -1 ? field : field.slice(0, i);
}

// The aggregate wire-spec ({fn, facet?, as:'value'}) in one place (server
// chartData + client ChartView both built this literal independently).
export function aggSpec(agg: string, y: string | undefined): string {
  return JSON.stringify([{ fn: agg, ...(y ? { facet: y } : {}), as: "value" }]);
}

// A chart spec, resolved once at the boundary: aliases (x|group_by, y|metric) and
// defaults (mark, agg) collapsed, and the `:unit` bucket split into `groupBy` (the
// full field for GROUP BY) vs `x`/`series` (the bare column the engine aliases it
// to, which rows/sort/pivot/dataKey read). Both renderers derive from this so they
// can't resolve aliases or buckets differently.
export interface ResolvedChart {
  mark: string;
  /** full x for GROUP BY (may carry ":unit") */
  groupBy?: string;
  /** bare read/sort/pivot/dataKey for x */
  x?: string;
  /** full series for GROUP BY (may carry ":unit") */
  seriesGroup?: string;
  /** bare read/pivot key for series */
  series?: string;
  y?: string;
  stack: boolean;
  agg: string;
  title?: string;
  caption?: string;
}
// The query plan for a resolved chart — what to fetch and how to aggregate/sort.
// The SERVER (hive.chartData via this.query) and the CLIENT (ChartView via
// /api/query) both derive their query from this ONE function, so the in-hive chart
// and the published/OG chart can't aggregate, sort, bucket, or truncate differently.
export type ChartQueryKind = "scatter" | "series" | "aggregate";
export interface ChartQuery {
  kind: ChartQueryKind;
  facets?: string;     // scatter: raw facets to read
  group_by?: string;   // series/aggregate: GROUP BY field(s) (full, incl ":unit")
  aggregate?: string;  // series/aggregate: aggSpec JSON
  sort?: string;       // bare x for continuous/series; "-value" for ranked
  limit: number;
}
export function chartQuery(rc: ResolvedChart): ChartQuery {
  if (rc.mark === "scatter") {
    return { kind: "scatter", facets: [rc.x, rc.y].filter(Boolean).join(","), limit: 500 };
  }
  if (rc.series && rc.x && !isRound(rc.mark)) {
    return {
      kind: "series",
      group_by: [rc.groupBy, rc.seriesGroup].filter(Boolean).join(","),
      aggregate: aggSpec(rc.agg, rc.y),
      sort: rc.x, // bare alias — line/area read left→right; pivot preserves it
      limit: 500,
    };
  }
  return {
    kind: "aggregate",
    group_by: rc.groupBy,
    aggregate: aggSpec(rc.agg, rc.y),
    sort: isContinuous(rc.mark) ? rc.x : "-value", // line/area by x; bar & slices ranked
    limit: 200,
  };
}

export function resolveChart(cfg: Record<string, unknown>): ResolvedChart {
  const xRaw = (cfg.x as string) || (cfg.group_by as string) || undefined;
  const sRaw = (cfg.series as string) || undefined;
  const y = (cfg.y as string) || (cfg.metric as string) || undefined;
  return {
    mark: (cfg.mark as string) || "bar",
    groupBy: xRaw,
    x: xRaw ? groupKey(xRaw) : undefined,
    seriesGroup: sRaw,
    series: sRaw ? groupKey(sRaw) : undefined,
    y,
    stack: cfg.stack === true,
    agg: (cfg.agg as string) || (y ? "sum" : "count"),
    title: (cfg.title as string) || undefined,
    caption: (cfg.caption as string) || undefined,
  };
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
  const seen = new Set<string>(); // O(1) membership — keys can be high-cardinality
  const byX = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const r of rows) {
    const xv = r[xKey] ?? "";
    const xk = String(xv);
    // A NULL/empty series value buckets under SERIES_NONE rather than being
    // silently dropped (which previously flattened the whole chart to zero when
    // the series facet was unset on every row).
    const sv = String(r[seriesKey] ?? "") || SERIES_NONE;
    if (!byX.has(xk)) { byX.set(xk, { [xKey]: xv }); order.push(xk); }
    if (!seen.has(sv)) { seen.add(sv); keys.push(sv); }
    byX.get(xk)![sv] = Number(r[valueKey]) || 0;
  }
  const out = order.map((xk) => {
    const row = byX.get(xk)!;
    for (const k of keys) if (!(k in row)) row[k] = 0;
    return row;
  });
  return { rows: out, keys };
}
