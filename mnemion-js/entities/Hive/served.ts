// served.ts — the untrusted served reader. ALL served public reads live here.
//
// This module is the single home for every public, unauthenticated, edge-cacheable
// read Mnemion exposes: agent-authored public pages (HTML + an OG chart card),
// shared entries (`/o/entry`), agent-defined outputs (`/o`), publications (`/p`),
// and the input-endpoint visibility probe (`/i`). Its ONLY user-pattern data
// access is `servedQuery` — the untrusted reader, which refuses kernel patterns at
// the engine (data.ts query()'s `!ctx.trusted` check). ServedContext deliberately
// exposes nothing else that could reach arbitrary kernel data: no `db`, no
// owner/trusted context, no way to construct one. The kernel-CONFIG rows these
// readers legitimately need (a `_shared` visibility, a `_publications`/`_outputs`/
// `_inputs` config row, supersession ids, facet metadata) are reached only through
// NARROW bound lookups the DO provides — each returning ONLY that specific answer,
// never an arbitrary kernel row — exactly as federation.ts gets a bound
// `isHostAllowed` and never `db`. That is the point of the eviction: a served sink
// that physically cannot read a kernel pattern, and cannot reach `db` to try.
// Everything else is a PURE helper imported directly (chart SVG/spec, XSS escape,
// the page CSS, the publication renderer, seal/sealAll). The DO keeps thin RPC
// stubs that build the context and delegate; this holds the logic.
import { renderChartSvg, chartOgSvg, type ChartPayload } from "../../shared/core/chart-svg";
import { pivotSeries, resolveChart, chartQuery, aggSpec } from "../../shared/core/chart-spec";
import { escapeXml } from "../../shared/core/escape";
import { seal, sealAll } from "./policy";
import { renderPublication, type PublicationRow } from "../../shared/IO/publications";
import PUBLIC_PAGE_CSS from "./public-page.css";

/** A `_publications` config row plus the projection params the served read needs.
 *  Returned WHOLE only for the public publication path; it carries no secret column
 *  (publications are agent-authored projection config, never credential-bearing). */
export interface PublicationConfig extends PublicationRow {
  visibility: string;
  filters: string | null;
  facets: string | null;
  sort: string | null;
  limit: number | null;
  include_superseded: number | boolean | null;
  updated_at: string;
}

export interface ServedContext {
  /** The untrusted served reader (data.query bound to a `trusted: false` context).
   *  This is the SINGLE chokepoint for every USER-PATTERN read this module makes —
   *  it refuses kernel patterns at the engine, so served orchestration never needs
   *  (and never gets) a per-block / per-method kernel guard. Signature mirrors
   *  hive.ts `servedQuery`. */
  servedQuery(
    patternName: string, filterJson: string, facets: string, sortField: string,
    limit: number, countOnly: boolean, groupBy: string, aggregateJson: string,
  ): string;

  // --- Narrow kernel-CONFIG lookups (the DO owns these reads; each returns ONLY
  //     the specific config answer, never an arbitrary kernel row). ---

  /** `true` if (pattern,id) names a real pattern AND an integer id — the same
   *  existence/identifier check `query()` makes, exposed so the served-entry read
   *  can fail not-found before touching `servedQuery`. (servedQuery ALSO refuses a
   *  non-existent pattern, so this is a clean early return, not the security gate.) */
  patternExists(name: string): boolean;

  /** The `_shared` visibility for (pattern,id), or null if not shared. Kernel-config
   *  answer only — never the entry, never another `_shared` field. */
  sharingVisibility(pattern: string, id: number): string | null;

  /** The `_publications` config row for `path` (any visibility), or null. The caller
   *  enforces the private→not-served rule, exactly as the DO did inline. */
  publicationByPath(path: string): PublicationConfig | null;

  /** The `_outputs` row for `path` (agent-authored egress content + its visibility),
   *  or null. This row IS the served answer (no user-pattern read involved). */
  outputByPath(path: string): { content: string; mime_type: string; visibility: string; updated_at: string } | null;

  /** The `_inputs` visibility for `path`, or null. */
  inputVisibility(path: string): string | null;

  /** Of `ids`, which are superseded targets in `pattern` (a `supersedes` _links
   *  row points at them). Used to drop superseded entries from a publication. */
  supersededIds(pattern: string, ids: number[]): Set<number>;

  /** Facet metadata (name+type) for `pattern`, for the publication template/label. */
  facetMeta(pattern: string): { name: string; type: string }[];

  /** This instance's host, for publication absolute URLs. Configuration, never
   *  request data (currentHost ignores the inbound Host). */
  host(): string;

  /** The shared error-JSON shape. */
  errorJson(message: string): string;
}

/** Aggregate rows for a block (reuses the query engine: group_by x, agg y).
 *  Still used by the metric block (no x) — chart blocks go through chartData. */
async function aggRows(
  ctx: ServedContext, pattern: string, x: string | undefined, y: string | undefined,
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
async function chartData(ctx: ServedContext, b: any): Promise<ChartPayload> {
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

async function renderBlockHtml(ctx: ServedContext, b: any): Promise<string> {
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

export async function renderPublicPage(ctx: ServedContext, row: any, path: string): Promise<string> {
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

export async function renderPageOgSvg(ctx: ServedContext, row: any): Promise<string | null> {
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

// === Shared entries (/o/entry/{pattern}/{id}) ===

/** Serve a single entry marked public/unlisted in `_shared`. The user-pattern
 *  entry read goes through `servedQuery` — the kernel-refusing chokepoint — so
 *  there is NO hand-rolled `isKernelPattern` guard here: a kernel pattern reads
 *  back empty at the engine (data.ts query()'s `!trusted` check), exactly as a
 *  kernel-named page block does. `servedQuery` also refuses a non-existent pattern
 *  and BINDS the id (no SQL-identifier injection), so the old `patternExists` +
 *  `Number.isInteger(id)` checks survive only as a clean early not-found, never as
 *  the security gate. The sharing visibility is a kernel-config lookup the DO owns
 *  (sharingVisibility), so served.ts never touches `_shared` directly. seal strips
 *  any sensitive column before the entry leaves over this public route. */
export async function getSharedEntry(ctx: ServedContext, pattern: string, id: number): Promise<string> {
  // Early not-found (servedQuery would also refuse these; this skips the work).
  if (!ctx.patternExists(pattern)) return JSON.stringify({ found: false });
  if (!Number.isInteger(id)) return JSON.stringify({ found: false });

  // Must be shared (kernel-config answer from the DO; null = not served).
  const visibility = ctx.sharingVisibility(pattern, id);
  if (visibility == null) return JSON.stringify({ found: false });

  // The entry itself, through the kernel-refusing served reader. id is bound
  // (parseFilter binds the value), so a kernel/garbage pattern can only read empty.
  let entry: Record<string, unknown> | undefined;
  try {
    const res = JSON.parse(ctx.servedQuery(pattern, JSON.stringify([`id=${id}`]), "", "", 1, false, "", ""));
    if (res.error || !Array.isArray(res.entries) || res.entries.length === 0)
      return JSON.stringify({ found: false });
    entry = res.entries[0] as Record<string, unknown>;
  } catch {
    return JSON.stringify({ found: false });
  }

  // seal: served publicly at /o/entry — strip any sensitive column.
  return JSON.stringify({ found: true, visibility, pattern, entry: seal(pattern, entry) });
}

// === Publications (/p/{path}) ===

/** Render a live publication projection. The source query runs through
 *  `servedQuery` (refuses a kernel source), rows are sealed, superseded entries
 *  drop out (via the DO's narrow supersededIds lookup), and the publication is
 *  rendered by the pubs adapter with DO-supplied facet metadata + host. */
export async function resolvePublication(ctx: ServedContext, path: string): Promise<string> {
  const pub = ctx.publicationByPath(path);
  if (!pub) return JSON.stringify({ found: false });

  // private = staged, not served (route layer never sees it)
  if (pub.visibility === "private") return JSON.stringify({ found: false });
  if (!ctx.patternExists(pub.source_pattern)) return JSON.stringify({ found: false });

  // Live projection through the served boundary: refuses a kernel source.
  const queryRaw = ctx.servedQuery(
    pub.source_pattern, pub.filters || "", pub.facets || "",
    pub.sort || "-updated_at", pub.limit || 50, false, "", "",
  );
  const queryResult = JSON.parse(queryRaw);
  if (queryResult.error) return JSON.stringify({ found: false });
  // seal: these rows render into a public /p projection — strip any sensitive column.
  let entries = sealAll(pub.source_pattern, queryResult.entries as Record<string, unknown>[]);

  // Publications project current truth: superseded entries drop out unless opted in.
  if (!pub.include_superseded && entries.length > 0) {
    const ids = entries.map((e) => e.id as number);
    const superseded = ctx.supersededIds(pub.source_pattern, ids);
    if (superseded.size > 0) entries = entries.filter((e) => !superseded.has(e.id as number));
  }

  const rendered = renderPublication(pub, entries, {
    facets: ctx.facetMeta(pub.source_pattern),
    host: ctx.host(),
  });

  // ETag source: content changes when the publication config OR any served entry changes.
  let latest = pub.updated_at;
  for (const e of entries) {
    const u = e.updated_at as string | undefined;
    if (u && u > latest) latest = u;
  }

  return JSON.stringify({
    found: true,
    visibility: pub.visibility,
    body: rendered.body,
    content_type: rendered.contentType,
    updated_at: latest,
  });
}

// === Outputs (/o/{path}) ===

/** Serve agent-constructed content at an arbitrary path. The `_outputs` row IS the
 *  answer (content + mime + visibility), reached through the DO's narrow lookup —
 *  no user-pattern read involved. */
export function resolveOutput(ctx: ServedContext, path: string): string {
  const row = ctx.outputByPath(path);
  if (!row) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, ...row });
}

// === Inputs (/i/{path}) visibility probe ===

/** Report an input endpoint's visibility (the route layer gates token access on
 *  it). Not-found when no active endpoint exists at `path`. */
export function getInputVisibility(ctx: ServedContext, path: string): string {
  const visibility = ctx.inputVisibility(path);
  if (visibility == null) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, visibility });
}
