// reports.ts — read-orchestration reporting, evicted from HiveDO.
//
// These are pure read+format builders for agent-facing JSON/markdown: recent
// activity, the maintenance-status nag, the stale-review surface, the system-doc
// readers, and the instance/storage doc. None of them write, none are a security
// boundary (they run in the owner/trusted DO context and only SELECT), and none
// are bound to the DO lifecycle/websocket — so they decompose cleanly out of the
// kernel shell.
//
// ReportsContext is deliberately narrow. Raw `db` is acceptable here (every read
// is owner-context and read-only), but the bits that DO need DO state — the host
// (`currentHost`, which reads the live `Host` header / WORKER_HOST off the DO
// instance) and `patternClass`/`errorJson` (already-bound helpers) — are injected
// as functions so this module never reaches back into `this`. The DO keeps thin
// RPC wrappers with identical signatures; this holds the logic.
import { uri } from "../../shared/core/constants";
import { parseDbDate, getMemoryPolicy } from "./prime";
import { IMMUTABLE } from "./kernel";

export interface ReportsContext {
  db: any;
  /** A pattern's class: "dataset" (records, never stale) vs "knowledge". Bound by
   *  the DO over prime.getPatternClass. */
  patternClass(name: string): "knowledge" | "dataset";
  /** The authoritative instance host (WORKER_HOST, else the live Host header).
   *  Bound by the DO because it reads DO instance state — kept off this module. */
  currentHost(): string;
  errorJson(message: string): string;
  /** Whether the R2 document store is enabled (env.DOCUMENTS bound). Drives the
   *  index's _documents "unavailable" annotation; injected as a boolean so this
   *  module never reaches `env`. */
  hasDocuments: boolean;
}

// === Master index (the live "what is this hive" projection) ===

export interface StoreIndex {
  version: number;
  updated_at: string;
  charter: Record<string, string>;
  patterns: IndexPatternEntry[];
  guidance: string;
}

export interface IndexPatternEntry {
  name: string;
  description: string;
  doctrine: string;
  pattern_class?: "knowledge" | "dataset";
  memory_policy?: Record<string, unknown> | null;
  unavailable?: string;
  facets: IndexFacetEntry[];
  entry_count: number;
  latest_activity: string | null;
}

export interface IndexFacetEntry {
  name: string;
  type: string;
  required: boolean;
  default?: string | number | boolean | null;
  links?: string | null;
  options?: string[];
  readonly?: boolean;
  format?: string;
}

/** The structural index: schema + charter + facet metadata, entry counts zeroed.
 *  Pure structure — `getIndex` enriches it with live counts/activity. Also handed
 *  to the evolution previewer (which mutates a copy to show a proposed change). */
export function getCurrentIndex(ctx: ReportsContext): StoreIndex {
  const meta = ctx.db.exec("SELECT * FROM _meta WHERE id = 1").one() as any;
  const objects = ctx.db.exec("SELECT name, description, doctrine, memory_policy, pattern_class FROM _objects WHERE archived_at IS NULL ORDER BY name").toArray() as any[];
  const allFields = ctx.db.exec("SELECT * FROM _fields ORDER BY object_name, id").toArray() as any[];
  const charterRows = ctx.db.exec(
    `SELECT "key", "value" FROM "_charter" WHERE archived_at IS NULL ORDER BY id`
  ).toArray() as any[];
  const charter: Record<string, string> = {};
  for (const r of charterRows) charter[r.key] = r.value;

  // Group facets by pattern
  const facetsByPattern = new Map<string, IndexFacetEntry[]>();
  for (const f of allFields) {
    if (!facetsByPattern.has(f.object_name)) facetsByPattern.set(f.object_name, []);
    const facet: IndexFacetEntry = {
      name: f.name,
      type: f.type,
      required: !!f.required,
      default: f.default_value != null ? JSON.parse(f.default_value) : null,
    };
    if (f.references_object) facet.links = f.references_object;
    if (f.options) facet.options = JSON.parse(f.options);
    if (f.format) facet.format = f.format;
    if (IMMUTABLE[f.object_name]?.fields.includes(f.name)) facet.readonly = true;
    facetsByPattern.get(f.object_name)!.push(facet);
  }

  return {
    version: meta.version,
    updated_at: meta.updated_at,
    patterns: objects.map((o: any) => {
      let memoryPolicy: Record<string, unknown> | null = null;
      if (o.memory_policy) {
        try { memoryPolicy = JSON.parse(o.memory_policy); } catch { /* malformed — omit */ }
      }
      return {
        name: o.name,
        description: o.description,
        doctrine: o.doctrine || "",
        ...(o.pattern_class === "dataset" ? { pattern_class: "dataset" as const } : {}),
        ...(memoryPolicy ? { memory_policy: memoryPolicy } : {}),
        facets: facetsByPattern.get(o.name) || [],
        entry_count: 0,
        latest_activity: null,
      };
    }),
    charter,
    guidance: meta.guidance,
  };
}

/** The agent-facing master index: the structural index enriched with live entry
 *  counts + latest activity (computed per call, never stored — data is destiny),
 *  sorted by recency, plus agent-authored view/page specs. */
export function getIndex(ctx: ReportsContext): string {
  const index = getCurrentIndex(ctx);

  // Flag the document store when R2 isn't enabled, so agents reading the
  // index know files can't be stored (and can tell the human how to enable it).
  if (!ctx.hasDocuments) {
    const docs = index.patterns.find((p) => p.name === "_documents");
    if (docs) docs.unavailable = "Cloudflare R2 is not enabled on this instance — _documents entries can be created but file upload/serve is unavailable. To enable: turn on R2 (dashboard → Storage & databases → R2), then run `npm run enable-documents` and redeploy.";
  }

  // Enrich with live entry counts and latest activity
  for (const pat of index.patterns) {
    try {
      const r = ctx.db.exec(
        `SELECT COUNT(*) as count, MAX(updated_at) as latest FROM "${pat.name}" WHERE archived_at IS NULL`
      ).one() as { count: number; latest: string | null };
      pat.entry_count = r.count;
      pat.latest_activity = r.latest;
    } catch {
      try {
        const r = ctx.db.exec(
          `SELECT COUNT(*) as count, MAX(updated_at) as latest FROM "${pat.name}"`
        ).one() as { count: number; latest: string | null };
        pat.entry_count = r.count;
        pat.latest_activity = r.latest;
      } catch {
        pat.entry_count = 0;
        pat.latest_activity = null;
      }
    }
  }

  // Sort by latest activity (most recent first), nulls last
  index.patterns.sort((a, b) => {
    if (!a.latest_activity && !b.latest_activity) return a.name.localeCompare(b.name);
    if (!a.latest_activity) return 1;
    if (!b.latest_activity) return -1;
    return b.latest_activity.localeCompare(a.latest_activity);
  });

  // Agent-authored view specs (web app renders patterns per these).
  let views: any[] = [];
  try {
    views = ctx.db.exec(
      `SELECT pattern, name, view_type, config FROM "_views" WHERE archived_at IS NULL`
    ).toArray() as any[];
  } catch { /* table may not exist on a very old install */ }

  // Agent-authored pages (block compositions / dashboards).
  let pages: any[] = [];
  try {
    pages = ctx.db.exec(
      `SELECT name, path, title, blocks FROM "_pages" WHERE archived_at IS NULL ORDER BY id`
    ).toArray() as any[];
  } catch { /* table may not exist on a very old install */ }

  return JSON.stringify({
    ...index,
    views,
    pages,
    system_docs: uri("_system/"),
  }, null, 2);
}

// === Recent activity ===

/** Most recently modified entries across all non-kernel patterns, summarized from
 *  each pattern's first text/select facet. */
export async function getRecentActivity(ctx: ReportsContext, limit: number = 10): Promise<string> {
  const patterns = ctx.db.exec(
    "SELECT name FROM _objects WHERE archived_at IS NULL AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"
  ).toArray() as { name: string }[];

  const all: { pattern: string; id: number; summary: string; updated_at: string }[] = [];

  for (const pat of patterns) {
    try {
      // Get text/select facets to build a summary
      const facets = ctx.db.exec(
        "SELECT name FROM _fields WHERE object_name = ? AND type IN ('text', 'select') ORDER BY id",
        pat.name
      ).toArray() as { name: string }[];

      const firstFacet = facets[0]?.name;
      const selectCols = firstFacet ? `, "${firstFacet}"` : "";

      const rows = ctx.db.exec(
        `SELECT id, updated_at${selectCols} FROM "${pat.name}" WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
        limit
      ).toArray() as any[];

      for (const row of rows) {
        const preview = firstFacet && row[firstFacet]
          ? String(row[firstFacet]).slice(0, 120)
          : "";
        all.push({
          pattern: pat.name,
          id: row.id,
          summary: preview,
          updated_at: row.updated_at,
        });
      }
    } catch { /* table may not exist */ }
  }

  // Sort by recency, take top N
  all.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return JSON.stringify(all.slice(0, limit));
}

// === Memory maintenance ===

export async function getMaintenanceStatus(ctx: ReportsContext): Promise<string> {
  return JSON.stringify(computeMaintenanceStatus(ctx), null, 2);
}

export function computeMaintenanceStatus(ctx: ReportsContext): {
  last_pass_at: string | null;
  days_since_last_pass: number | null;
  interval_days: number;
  overdue: boolean;
} {
  const DAY = 86_400_000;

  let intervalDays = 14;
  try {
    const r = ctx.db.exec(
      `SELECT "value" FROM "_charter" WHERE "key" = 'maintenance_interval_days' AND archived_at IS NULL`
    ).toArray() as any[];
    const v = Number(r[0]?.value);
    if (Number.isFinite(v) && v > 0) intervalDays = v;
  } catch { /* charter may not exist yet */ }

  let lastPass: string | null = null;
  try {
    const r = ctx.db.exec(
      `SELECT MAX(created_at) as t FROM "_maintenance_passes" WHERE archived_at IS NULL`
    ).toArray() as any[];
    lastPass = r[0]?.t ?? null;
  } catch { /* table may not exist yet */ }

  if (lastPass) {
    const t = parseDbDate(lastPass);
    const days = t != null ? Math.floor((Date.now() - t) / DAY) : null;
    return {
      last_pass_at: lastPass,
      days_since_last_pass: days,
      interval_days: intervalDays,
      overdue: days != null && days >= intervalDays,
    };
  }

  // Never run — only nag once the hive is older than the interval, using the
  // first schema change as its birth. Fresh hives stay quiet.
  let overdue = false;
  try {
    const r = ctx.db.exec(`SELECT MIN(created_at) as t FROM _schema_history`).toArray() as any[];
    const birth = parseDbDate(r[0]?.t ?? undefined);
    overdue = birth != null && (Date.now() - birth) / DAY >= intervalDays;
  } catch { /* no history — fresh hive */ }

  return { last_pass_at: null, days_since_last_pass: null, interval_days: intervalDays, overdue };
}

export async function getStaleEntries(ctx: ReportsContext, days?: number): Promise<string> {
  const patterns = ctx.db.exec(
    "SELECT name FROM _objects WHERE archived_at IS NULL AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"
  ).toArray() as { name: string }[];

  const stale: any[] = [];
  for (const pat of patterns) {
    // Dataset patterns don't go stale — a recorded observation is history, not
    // memory awaiting review. Skip them in the maintenance surface.
    if (ctx.patternClass(pat.name) === "dataset") continue;
    const policy = getMemoryPolicy(ctx.db, pat.name);
    const horizon = days ?? (policy.half_life_days != null ? policy.half_life_days * 3 : 90);
    const modifier = `-${Math.round(horizon)} days`;

    try {
      // Preview from the first text/select facet (same convention as getRecentActivity)
      const facets = ctx.db.exec(
        "SELECT name FROM _fields WHERE object_name = ? AND type IN ('text', 'select') ORDER BY id",
        pat.name
      ).toArray() as { name: string }[];
      const firstFacet = facets[0]?.name;
      const selectCols = firstFacet ? `, e."${firstFacet}"` : "";

      // Stale = neither updated nor recalled inside the horizon
      const rows = ctx.db.exec(
        `SELECT e.id, e.updated_at, MAX(l.accessed_at) as last_primed${selectCols}
         FROM "${pat.name}" e
         LEFT JOIN "_entry_access_log" l ON l.pattern = ? AND l.entry_id = e.id
         WHERE e.archived_at IS NULL
         GROUP BY e.id
         HAVING e.updated_at < datetime('now', ?) AND COALESCE(MAX(l.accessed_at), e.updated_at) < datetime('now', ?)
         ORDER BY e.updated_at ASC`,
        pat.name, modifier, modifier
      ).toArray() as any[];

      for (const row of rows) {
        const item: any = {
          pattern: pat.name,
          id: row.id,
          uri: uri(`entry/${pat.name}/${row.id}`),
          preview: firstFacet && row[firstFacet] ? String(row[firstFacet]).slice(0, 120) : "",
          updated_at: row.updated_at,
          last_primed: row.last_primed ?? null,
          horizon_days: horizon,
        };
        try {
          const sup = ctx.db.exec(
            `SELECT source_pattern, source_id FROM "_links" WHERE label = 'supersedes' AND archived_at IS NULL AND target_pattern = ? AND target_id = ? LIMIT 1`,
            pat.name, row.id
          ).toArray() as any[];
          if (sup.length > 0) item.superseded_by = uri(`entry/${sup[0].source_pattern}/${sup[0].source_id}`);
        } catch { /* _links may not exist */ }
        stale.push(item);
      }
    } catch { /* table may not exist */ }
  }

  stale.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  const capped = stale.slice(0, 100);
  return JSON.stringify({
    stale: capped,
    count: capped.length,
    total: stale.length,
    guidance: "Read-only review surface. Propose supersession or archival to the human; never bulk-archive unprompted. See the memory-maintenance system doc.",
  }, null, 2);
}

// === System docs ===

export function getSystemDocList(ctx: ReportsContext): string {
  const rows = ctx.db.exec(
    `SELECT slug, title FROM "_system_docs" ORDER BY slug`
  ).toArray() as { slug: string; title: string }[];
  return JSON.stringify({
    docs: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      uri: uri(`_system/${r.slug}`),
    })),
  }, null, 2);
}

export function getSystemDoc(ctx: ReportsContext, slug: string, returnDefault: boolean): string {
  const rows = ctx.db.exec(
    `SELECT * FROM "_system_docs" WHERE slug = ?`,
    slug
  ).toArray() as any[];
  if (rows.length === 0) return ctx.errorJson(`No system doc with slug: ${slug}`);
  const doc = rows[0];
  let content = returnDefault ? doc.default_content : (doc.content ?? doc.default_content);

  // Instance doc is fully computed at resolve time — regenerate host-related
  // lines from the most recently observed Host header rather than serving the
  // seed-time snapshot, which baked in a possibly-stale env.WORKER_HOST.
  if (slug === "instance" && !returnDefault) {
    content = renderInstanceDoc(ctx) + computeStorageStats(ctx);
  }

  return JSON.stringify({
    slug: doc.slug,
    title: doc.title,
    content,
    // Instance content is always freshly computed, so the seed-vs-customized
    // distinction doesn't apply — the flag would only ever compare the
    // placeholder to itself and lie. Other docs use the normal check.
    is_default: slug === "instance"
      ? false
      : (doc.content === null || doc.content === doc.default_content),
    uri: uri(`_system/${doc.slug}`),
  }, null, 2);
}

export function renderInstanceDoc(ctx: ReportsContext): string {
  const host = ctx.currentHost();
  return `# Instance Info

- **Host**: ${host}
- **Base URL**: https://${host}
- **MCP endpoint**: https://${host}/mcp
- **Upload endpoint**: https://${host}/upload/{token}
- **Shared entries**: https://${host}/o/entry/{pattern}/{id}
- **Egress outputs**: https://${host}/o/{path}
- **Ingress inputs**: https://${host}/i/{path}`;
}

export function computeStorageStats(ctx: ReportsContext): string {
  try {
    const tables = ctx.db.exec(
      "SELECT name FROM _objects WHERE archived_at IS NULL ORDER BY name"
    ).toArray() as { name: string }[];
    let totalEntries = 0;
    let totalBytes = 0;
    for (const t of tables) {
      try {
        const cols = ctx.db.exec(`PRAGMA table_info("${t.name}")`).toArray() as any[];
        const textCols = cols.filter((c: any) => c.type === "TEXT" || c.type === "").map((c: any) => c.name);
        const sumExpr = textCols.length
          ? textCols.map((c: string) => `COALESCE(LENGTH("${c}"), 0)`).join(" + ")
          : "0";
        const r = ctx.db.exec(
          `SELECT COUNT(*) as c, SUM(${sumExpr}) as bytes FROM "${t.name}" WHERE archived_at IS NULL`
        ).one() as any;
        totalEntries += r.c;
        totalBytes += r.bytes || 0;
      } catch { /* table may be missing */ }
    }
    const mutations = (ctx.db.exec("SELECT COUNT(*) as c FROM _mutation_log").one() as any).c;
    const fmt = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `\n\n## Storage\n\n- **Data**: ${fmt(totalBytes)} · **Patterns**: ${tables.length} · **Active entries**: ${totalEntries} · **Mutations logged**: ${mutations}`;
  } catch {
    return "";
  }
}
