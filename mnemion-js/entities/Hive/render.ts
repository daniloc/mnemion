// render.ts — served public-page + OG-card render orchestration, evicted from HiveDO.
//
// This module renders agent-authored public pages (HTML + an OG chart card) for
// unauthenticated, edge-cacheable URLs. Its ONLY data access is `servedQuery` —
// the untrusted reader, which refuses kernel patterns at the engine (data.ts
// query()'s `!ctx.trusted` check). RenderContext deliberately exposes nothing
// else: no `db`, no owner/trusted context, no way to construct one. That is the
// point of the eviction — a served sink that physically cannot read a kernel
// pattern. Everything else this module needs is a PURE helper imported directly
// (chart SVG, chart spec, XSS escape, the page CSS). The DO keeps thin RPC
// wrappers; this holds the logic.
import { renderChartSvg, chartOgSvg, type ChartPayload } from "../../shared/core/chart-svg";
import { pivotSeries, resolveChart, chartQuery, aggSpec } from "../../shared/core/chart-spec";
import { escapeXml } from "../../shared/core/escape";
import PUBLIC_PAGE_CSS from "./public-page.css";

export interface RenderContext {
  /** The untrusted served reader (data.query bound to a `trusted: false` context).
   *  This is the SINGLE chokepoint for every read this module makes — it refuses
   *  kernel patterns at the engine, so render orchestration never needs (and never
   *  gets) a per-block kernel guard. Signature mirrors hive.ts `servedQuery`. */
  servedQuery(
    patternName: string, filterJson: string, facets: string, sortField: string,
    limit: number, countOnly: boolean, groupBy: string, aggregateJson: string,
  ): string;
}

/** Aggregate rows for a block (reuses the query engine: group_by x, agg y).
 *  Still used by the metric block (no x) — chart blocks go through chartData. */
async function aggRows(
  ctx: RenderContext, pattern: string, x: string | undefined, y: string | undefined,
  agg: string | undefined, sort: string,
): Promise<any[]> {
  const aggregate = aggSpec(agg || (y ? "sum" : "count"), y);
  try {
    // servedQuery refuses kernel patterns at the engine — the one read-boundary.
    const r = JSON.parse(ctx.servedQuery(pattern, "", "", sort || "", 200, false, x || "", aggregate));
    return r.rows || [];
  } catch { return []; }
}

/** Resolve a chart block's data into the payload both server renderers expect:
 *  raw x,y points for scatter; a pivoted multi-series set when `series` is set
 *  (non-round marks); a flat aggregate otherwise (incl. pie/donut). Fetch
 *  params come from chartQuery (the same source the client renderer uses), so
 *  the `:unit` bucket is split correctly: q.group_by GROUPs BY the full
 *  "facet:unit" field while q.sort and the row read-key rc.x use the bare
 *  alias the engine emits — passing the full field as the sort field is what
 *  the engine rejected, flattening bucketed charts to empty. */
async function chartData(ctx: RenderContext, b: any): Promise<ChartPayload> {
  const rc = resolveChart(b);
  const q = chartQuery(rc);
  try {
    // servedQuery refuses kernel patterns — protects the OG path too, which
    // reaches chartData without a per-block guard.
    if (q.kind === "scatter") {
      const r = JSON.parse(ctx.servedQuery(b.pattern, "", q.facets ?? "", "", q.limit, false, "", ""));
      const data = (r.entries || []).map((e: any) => ({ label: String(e[rc.x!] ?? ""), value: Number(e[rc.y!]) || 0 }));
      return { multi: false, data };
    }
    if (q.kind === "series") {
      const r = JSON.parse(ctx.servedQuery(b.pattern, "", "", q.sort ?? "", q.limit, false, q.group_by ?? "", q.aggregate ?? ""));
      const { rows, keys } = pivotSeries(r.rows || [], rc.x!, rc.series!);
      return { multi: true, data: { xKey: rc.x!, rows, keys } };
    }
    const r = JSON.parse(ctx.servedQuery(b.pattern, "", "", q.sort ?? "", q.limit, false, q.group_by ?? "", q.aggregate ?? ""));
    const data = (r.rows || []).map((row: any) => ({ label: String(row[rc.x!] ?? ""), value: Number(row.value) || 0 }));
    return { multi: false, data };
  } catch {
    if (q.kind === "series") return { multi: true, data: { xKey: rc.x ?? "", rows: [], keys: [] } };
    return { multi: false, data: [] };
  }
}

async function renderBlockHtml(ctx: RenderContext, b: any): Promise<string> {
  const w = b.width === "half" ? "w-half" : b.width === "third" ? "w-third" : "w-full";
  const e = (v: unknown) => escapeXml(String(v ?? ""));
  // No per-block kernel guard here: servedQuery is the single chokepoint and
  // refuses any kernel pattern at the engine (data.ts query()'s `!trusted`
  // check). A block naming a kernel pattern simply reads back empty — there is
  // no second place to forget the guard, because there is no second reader.
  switch (b.type) {
    case "heading": return `<h2 class="pb-h ${w}">${e(b.text)}</h2>`;
    case "text": return `<p class="pb-t ${w}">${e(b.text)}</p>`;
    case "metric": {
      const rows = await aggRows(ctx, b.pattern, undefined, b.metric, b.agg, "");
      const v = rows[0] ? Number(rows[0].value) : null;
      return `<div class="pb-metric ${w}"><div class="pb-metric-n">${v == null ? "—" : new Intl.NumberFormat("en").format(v)}</div><div class="pb-metric-l">${e(b.label)}</div></div>`;
    }
    case "chart": {
      const payload = await chartData(ctx, b);
      const has = payload.multi ? payload.data.rows.length : payload.data.length;
      const svg = has ? renderChartSvg(b.mark || "bar", payload, { stack: b.stack === true }) : `<div class="pb-empty">no data</div>`;
      return `<figure class="pb-chart ${w}">${b.title ? `<figcaption class="pb-chart-t">${e(b.title)}</figcaption>` : ""}<div class="pb-chart-c">${svg}</div>${b.caption ? `<figcaption class="pb-chart-cap">${e(b.caption)}</figcaption>` : ""}</figure>`;
    }
    default: return ""; // embeds (view/entry/list) aren't served on public pages yet
  }
}

export async function renderPublicPage(ctx: RenderContext, row: any, path: string): Promise<string> {
  let blocks: any[] = [];
  try { blocks = JSON.parse(row.blocks || "[]"); } catch { /* */ }
  // DoS backstop: each chart/metric block is a DB aggregate run sequentially
  // on the single-threaded DO, on an unauthenticated edge-cacheable URL. Cap
  // the render so a page with hundreds of heavy blocks can't pin the DO;
  // overflow blocks are silently dropped.
  const MAX_BLOCKS = 32;
  if (Array.isArray(blocks) && blocks.length > MAX_BLOCKS) blocks = blocks.slice(0, MAX_BLOCKS);
  const parts: string[] = [];
  for (const b of blocks) parts.push(await renderBlockHtml(ctx, b));
  const title = escapeXml(row.title || row.name);
  const desc = escapeXml(row.description || "");
  const og = `/page/${encodeURIComponent(path)}/og.png`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
${desc ? `<meta property="og:description" content="${desc}"><meta name="description" content="${desc}">` : ""}
<meta property="og:type" content="article"><meta property="og:image" content="${og}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${og}">
<style>${PUBLIC_PAGE_CSS}</style></head>
<body><main class="pb"><h1 class="pb-title">${title}</h1>${desc ? `<p class="pb-desc">${desc}</p>` : ""}<div class="pb-grid">${parts.join("")}</div><footer class="pb-foot">made with Mnemion</footer></main></body></html>`;
}

export async function renderPageOgSvg(ctx: RenderContext, row: any): Promise<string | null> {
  let blocks: any[] = [];
  try { blocks = JSON.parse(row.blocks || "[]"); } catch { /* */ }
  const chart = blocks.find((b: any) => b.type === "chart");
  if (!chart) return null;
  const data = await chartData(ctx, chart);
  // An empty chart would render a blank 1200×630 card — serve no OG image instead.
  const empty = data.multi ? data.data.rows.length === 0 : data.data.length === 0;
  if (empty) return null;
  return chartOgSvg(row.title || row.name, chart.mark || "bar", data, chart.stack === true);
}
