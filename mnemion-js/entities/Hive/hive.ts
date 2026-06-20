// HiveDO — the single per-user Durable Object that owns all SQLite data.
//
// @why Every agent write funnels through hive's
// mutate/batchMutate/processInput/consumeUpload methods so the kernel-write
// boundary is enforced at one chokepoint instead of re-derived per call site.
// It stays a thin shell over the pure-function domain modules (data, kernel,
// policy, prime, evolution, schema) with db/context injected — but the
// per-pattern lifecycle reactions (R2 blob delete on archive, _system_tasks
// dispatch, _documents upload-token mint) remain hardcoded `patternName ===
// "_x"` branches here: a consciously-retained imperative seam, since lifting
// them into the registry was judged a larger refactor with no security payoff
// and they fail loudly in tests on rename.

import { DurableObject } from "cloudflare:workers";
import { URI_SCHEME, URI_PREFIX, uri, OWNER_ACTOR } from "../../shared/core/constants";
import { evaluateMapping } from "./transform";
import { initializeSchema } from "./schema";
import { IMMUTABLE, expandShortcut, normalizeHost, isBlockedFederationHost } from "./kernel";
import { isKernelPattern, isValidWriteTarget, writeClass, seal, sealAll, secretColumn, SENSITIVE_COLUMNS, primeIncluded } from "./policy";
import { deriveLabel } from "./labels";
import { renderChartSvg, chartOgSvg, type ChartPayload } from "../../shared/core/chart-svg";
import { pivotSeries, resolveChart, chartQuery, aggSpec } from "../../shared/core/chart-spec";
import { escapeXml } from "../../shared/core/escape";
import PUBLIC_PAGE_CSS from "./public-page.css";
import * as cred from "../../shared/Auth/credentials";
import * as evo from "./evolution";
import * as data from "./data";
import * as eff from "./effects";
import * as priming from "./prime";
import * as pubs from "../../shared/IO/publications";
import * as web from "../../shared/IO/web";
import { capText, extractPdfText } from "../../shared/IO/extract";

// === Types ===

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


// === Constants ===


// === Hive: per-user data storage ===

export class HiveDO extends DurableObject {
  // Most recently observed HTTP Host header (from fetch() — WebSocket upgrades,
  // direct route hits). Authoritative source for the instance doc; env.WORKER_HOST
  // is only a cold-start fallback. Not persisted; resets on DO eviction.
  private lastKnownHost: string | null = null;

  private get db() {
    return this.ctx.storage.sql;
  }

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      initializeSchema(this.db, env);
      await this.migrateTokenHashes();
    });
  }

  /** One-time cleanup of secrets that leaked BEFORE born-hashing: hash any legacy
   *  plaintext token still in `_access_tokens` (raw = 32 hex, digest = 64), and
   *  scrub any raw token the old post-insert path left in the `_mutation_log`
   *  audit trail. Idempotent; a near-no-op after the first cold start. */
  private async migrateTokenHashes(): Promise<void> {
    try {
      const rows = this.db.exec(`SELECT id, token FROM "_access_tokens" WHERE length(token) != 64`).toArray() as any[];
      for (const r of rows) {
        if (typeof r.token !== "string") continue;
        try { this.db.exec(`UPDATE "_access_tokens" SET token = ? WHERE id = ?`, await cred.hashToken(r.token), r.id); }
        catch { /* a bad row must not brick construction — skip it */ }
      }
    } catch { /* table may not exist yet on a brand-new hive */ }
    // Audit-log scrub: NULL out every sensitive value the pre-recreate audit
    // triggers captured (raw tokens, passkey material). Derived from SENSITIVE_COLUMNS
    // so it covers every classified column; idempotent (once null, the guard skips it).
    try {
      for (const [table, cols] of Object.entries(SENSITIVE_COLUMNS)) {
        for (const c of cols) {
          for (const field of ["new_data", "old_data"]) {
            this.db.exec(
              `UPDATE _mutation_log SET ${field} = json_set(${field}, '$.${c.column}', null)
               WHERE table_name = ? AND json_extract(${field}, '$.${c.column}') IS NOT NULL`,
              table,
            );
          }
        }
      }
    } catch { /* best effort */ }
  }

  /** Born-hashed secrets: for a CREATE of a pattern with a `secret` column
   *  (SENSITIVE_COLUMNS), generate the preimage in app code and set the column to
   *  its DIGEST *before* the row is inserted — so the audit trigger, the broadcast,
   *  and any read only ever see the hash. Returns the raw preimage for the one-time
   *  response (the only place it exists). Mutates `data` in place; returns null for
   *  non-secret patterns / non-create ops. */
  private async mintSecrets(pattern: string, data: Record<string, unknown>, operation: string): Promise<Record<string, string> | null> {
    if (operation !== "create") return null;
    const col = secretColumn(pattern);
    if (!col) return null;
    const raw = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    data[col] = await cred.hashToken(raw); // store only the digest; raw never lands in a column
    return { [col]: raw };
  }

  private currentHost(): string {
    // Prefer a meaningfully-configured WORKER_HOST and IGNORE the inbound Host
    // header when it's set — generated URLs (upload_url / page_url / og_image /
    // the instance doc) must not be poisoned by an attacker-controlled Host on
    // an unauthenticated request (e.g. a /ws upgrade). Only fall back to the
    // observed host (then the placeholder/localhost) when WORKER_HOST isn't a
    // real value — i.e. local dev, where the inbound host is the right answer.
    const configured = (this.env as any).WORKER_HOST;
    if (configured && configured !== "your-worker.workers.dev") return configured;
    return this.lastKnownHost ?? configured ?? "localhost";
  }

  /** A public URL on this instance — the one place upload_url / page_url /
   *  og_image hand-build `https://{host}/{path}` from the live host. */
  private instanceUrl(path: string): string {
    return `https://${this.currentHost()}/${path}`;
  }

  // === RPC methods (called from MnemionSession) ===

  async getIndex(): Promise<string> {
    const index = this.getCurrentIndex();

    // Flag the document store when R2 isn't enabled, so agents reading the
    // index know files can't be stored (and can tell the human how to enable it).
    if (!this.env.DOCUMENTS) {
      const docs = index.patterns.find((p) => p.name === "_documents");
      if (docs) docs.unavailable = "Cloudflare R2 is not enabled on this instance — _documents entries can be created but file upload/serve is unavailable. To enable: turn on R2 (dashboard → Storage & databases → R2), then run `npm run enable-documents` and redeploy.";
    }

    // Enrich with live entry counts and latest activity
    for (const pat of index.patterns) {
      try {
        const r = this.db.exec(
          `SELECT COUNT(*) as count, MAX(updated_at) as latest FROM "${pat.name}" WHERE archived_at IS NULL`
        ).one() as { count: number; latest: string | null };
        pat.entry_count = r.count;
        pat.latest_activity = r.latest;
      } catch {
        try {
          const r = this.db.exec(
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
      views = this.db.exec(
        `SELECT pattern, name, view_type, config FROM "_views" WHERE archived_at IS NULL`
      ).toArray() as any[];
    } catch { /* table may not exist on a very old install */ }

    // Agent-authored pages (block compositions / dashboards).
    let pages: any[] = [];
    try {
      pages = this.db.exec(
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

  async getCharter(): Promise<Record<string, string>> {
    const rows = this.db.exec(
      `SELECT "key", "value" FROM "_charter" WHERE archived_at IS NULL ORDER BY id`
    ).toArray() as any[];
    const charter: Record<string, string> = {};
    for (const r of rows) charter[r.key] = r.value;
    return charter;
  }

  async getRecentActivity(limit: number = 10): Promise<string> {
    // Most recently modified entries across all non-kernel patterns
    const patterns = this.db.exec(
      "SELECT name FROM _objects WHERE archived_at IS NULL AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"
    ).toArray() as { name: string }[];

    const all: { pattern: string; id: number; summary: string; updated_at: string }[] = [];

    for (const pat of patterns) {
      try {
        // Get text/select facets to build a summary
        const facets = this.db.exec(
          "SELECT name FROM _fields WHERE object_name = ? AND type IN ('text', 'select') ORDER BY id",
          pat.name
        ).toArray() as { name: string }[];

        const firstFacet = facets[0]?.name;
        const selectCols = firstFacet ? `, "${firstFacet}"` : "";

        const rows = this.db.exec(
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

  async getMaintenanceStatus(): Promise<string> {
    return JSON.stringify(this.computeMaintenanceStatus(), null, 2);
  }

  private computeMaintenanceStatus(): {
    last_pass_at: string | null;
    days_since_last_pass: number | null;
    interval_days: number;
    overdue: boolean;
  } {
    const DAY = 86_400_000;

    let intervalDays = 14;
    try {
      const r = this.db.exec(
        `SELECT "value" FROM "_charter" WHERE "key" = 'maintenance_interval_days' AND archived_at IS NULL`
      ).toArray() as any[];
      const v = Number(r[0]?.value);
      if (Number.isFinite(v) && v > 0) intervalDays = v;
    } catch { /* charter may not exist yet */ }

    let lastPass: string | null = null;
    try {
      const r = this.db.exec(
        `SELECT MAX(created_at) as t FROM "_maintenance_passes" WHERE archived_at IS NULL`
      ).toArray() as any[];
      lastPass = r[0]?.t ?? null;
    } catch { /* table may not exist yet */ }

    if (lastPass) {
      const t = priming.parseDbDate(lastPass);
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
      const r = this.db.exec(`SELECT MIN(created_at) as t FROM _schema_history`).toArray() as any[];
      const birth = priming.parseDbDate(r[0]?.t ?? undefined);
      overdue = birth != null && (Date.now() - birth) / DAY >= intervalDays;
    } catch { /* no history — fresh hive */ }

    return { last_pass_at: null, days_since_last_pass: null, interval_days: intervalDays, overdue };
  }

  async getStaleEntries(days?: number): Promise<string> {
    const patterns = this.db.exec(
      "SELECT name FROM _objects WHERE archived_at IS NULL AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"
    ).toArray() as { name: string }[];

    const stale: any[] = [];
    for (const pat of patterns) {
      // Dataset patterns don't go stale — a recorded observation is history, not
      // memory awaiting review. Skip them in the maintenance surface.
      if (this.patternClass(pat.name) === "dataset") continue;
      const policy = priming.getMemoryPolicy(this.db, pat.name);
      const horizon = days ?? (policy.half_life_days != null ? policy.half_life_days * 3 : 90);
      const modifier = `-${Math.round(horizon)} days`;

      try {
        // Preview from the first text/select facet (same convention as getRecentActivity)
        const facets = this.db.exec(
          "SELECT name FROM _fields WHERE object_name = ? AND type IN ('text', 'select') ORDER BY id",
          pat.name
        ).toArray() as { name: string }[];
        const firstFacet = facets[0]?.name;
        const selectCols = firstFacet ? `, e."${firstFacet}"` : "";

        // Stale = neither updated nor recalled inside the horizon
        const rows = this.db.exec(
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
            const sup = this.db.exec(
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

  // === Schema evolution (delegated to evolution.ts) ===

  private evoCtx(): evo.EvolutionContext {
    return {
      db: this.db,
      patternExists: (name) => this.patternExists(name),
      entryExists: (pattern, id) => this.entryExists(pattern, id),
    };
  }

  async proposeChange(description: string, changeJson: string): Promise<string> {
    return evo.proposeChange(description, changeJson, this.evoCtx(), () => this.getCurrentIndex());
  }

  // Peek at a pending change's spec without applying it — lets the SessionDO
  // decide whether the change needs a consent round-trip (e.g. set_sharing to a
  // non-private visibility, which publishes an entry over HTTP).
  async getPendingChange(changeId: string): Promise<string | null> {
    try {
      const rows = this.db.exec(
        "SELECT change_spec FROM _pending_changes WHERE id = ?", changeId
      ).toArray() as any[];
      return rows.length > 0 ? (rows[0].change_spec as string) : null;
    } catch {
      return null;
    }
  }

  async applyChange(changeId: string): Promise<string> {
    return evo.applyChange(
      changeId, this.evoCtx(), () => this.getCurrentIndex(),
      async () => { try { return await this.ctx.storage.getCurrentBookmark(); } catch { return null; } },
      (patterns) => this.broadcastChange(patterns),
    );
  }

  async revertChange(historyId: number): Promise<string> {
    return evo.revertChange(
      historyId, this.evoCtx(),
      (bookmark) => this.ctx.storage.onNextSessionRestoreBookmark(bookmark),
      () => this.ctx.abort(),
    );
  }

  // === Resource RPC methods ===

  async getSchema(patternName: string): Promise<string> {
    if (!this.patternExists(patternName))
      return this.errorJson(`Pattern "${patternName}" does not exist`);

    const objRow = this.db.exec(
      "SELECT name, description, pattern_class FROM _objects WHERE name = ?", patternName
    ).one() as { name: string; description: string; pattern_class: string };

    const fields = this.db.exec(
      "SELECT name, type, required, default_value, references_object FROM _fields WHERE object_name = ? ORDER BY id",
      patternName
    ).toArray() as any[];

    return JSON.stringify({
      pattern: objRow.name,
      description: objRow.description,
      pattern_class: objRow.pattern_class === "dataset" ? "dataset" : "knowledge",
      // Derived at read time from the write-class registry (policy.ts) — never
      // stored, so it can't drift from the enforced policy. Tells an agent which
      // writes a pattern admits and why a refusal happened.
      write_class: writeClass(patternName),
      facets: fields.map((f: any) => {
        const facet: any = {
          name: f.name,
          type: f.type,
          required: !!f.required,
          default: f.default_value != null ? JSON.parse(f.default_value) : null,
        };
        if (f.references_object) facet.links = f.references_object;
        if (f.format) facet.format = f.format;
        return facet;
      }),
      kernel_columns: ["id", "version", "created_at", "updated_at", "archived_at"],
    }, null, 2);
  }

  async getHistory(limit: number): Promise<string> {
    const rows = this.db.exec(
      "SELECT * FROM _schema_history ORDER BY id DESC LIMIT ?",
      limit
    ).toArray();
    return JSON.stringify({ history: rows, count: rows.length }, null, 2);
  }

  async getEntry(patternName: string, entryId: number): Promise<string> {
    if (!this.patternExists(patternName))
      return this.errorJson(`Pattern "${patternName}" does not exist`);

    try {
      const rows = this.db.exec(
        `SELECT * FROM "${patternName}" WHERE id = ?`,
        entryId
      ).toArray();
      if (rows.length === 0) return this.errorJson(`Entry ${entryId} not found in "${patternName}"`);

      const entry = rows[0] as Record<string, unknown>;
      const result: any = { pattern: patternName, entry };

      // Superseded entries are annotated, never hidden — the chain stays navigable
      try {
        const sup = this.db.exec(
          `SELECT source_pattern, source_id FROM "_links" WHERE label = 'supersedes' AND archived_at IS NULL AND target_pattern = ? AND target_id = ? LIMIT 1`,
          patternName, entryId
        ).toArray() as any[];
        if (sup.length > 0) result.superseded_by = uri(`entry/${sup[0].source_pattern}/${sup[0].source_id}`);
      } catch { /* _links may not exist */ }

      // One-hop link following
      const linked = priming.followLinks(this.primeCtx(), patternName, entry);
      if (linked.length > 0) result.linked = linked;

      return JSON.stringify(result, null, 2);
    } catch (err: any) {
      return this.errorJson(`Failed to read entry: ${err.message}`);
    }
  }

  async listPatterns(): Promise<string[]> {
    const rows = this.db.exec("SELECT name FROM _objects WHERE archived_at IS NULL ORDER BY name").toArray() as any[];
    return rows.map((r: any) => r.name);
  }

  // === Data operations (delegated to data.ts) ===

  /** Shared DataContext fields, trust-AGNOSTIC. The trust flag is deliberately NOT
   *  a parameter here — it is fixed by the named constructor a caller chooses
   *  (`ownerDataCtx` / `servedDataCtx`), so trust can never be dialed at a call
   *  site — there is no trust boolean to misremember. */
  private ctxFields(actor: string = OWNER_ACTOR): Omit<data.DataContext, "trusted"> {
    return {
      db: this.db,
      actor,
      patternExists: (name) => this.patternExists(name),
      listPatterns: () => this.db.exec("SELECT name FROM _objects WHERE archived_at IS NULL ORDER BY name").toArray().map((r: any) => r.name as string),
      entryExists: (pattern, id) => this.entryExists(pattern, id),
      hasKernelVersion: (name) => this.hasKernelVersion(name),
      facetMeta: (pattern, facet) => {
        const rows = this.db.exec(
          "SELECT type, options FROM _fields WHERE object_name = ? AND name = ?", pattern, facet
        ).toArray() as any[];
        if (!rows.length) return null;
        const meta: { type: string; options?: string[] } = { type: rows[0].type };
        if (rows[0].options) meta.options = JSON.parse(rows[0].options);
        return meta;
      },
      patternClass: (name) => this.patternClass(name),
    };
  }

  /** TRUSTED context — full kernel read + write. The owner/agent path (MCP session,
   *  browser session, internal writes). The ONLY constructor that sets `trusted: true`;
   *  if you are handed this you can reach kernel data, so it is never given to
   *  orchestration that serves untrusted surfaces. */
  private ownerDataCtx(actor: string = OWNER_ACTOR): data.DataContext {
    return { ...this.ctxFields(actor), trusted: true };
  }

  /** UNTRUSTED context for SERVED surfaces (public page, /o, /p, OG, federation)
   *  AND untrusted WRITES (ingress, upload). `trusted: false` is the SAME flag the
   *  engine uses to refuse any kernel pattern, symmetric across read and write — so
   *  a serve/ingress path physically cannot reach `_access_tokens`/`_members`/etc.
   *  Orchestration handed only this constructor cannot forge a trusted write: the
   *  boundary is a capability, not a per-call-site convention. */
  private servedDataCtx(actor: string = OWNER_ACTOR): data.DataContext {
    return { ...this.ctxFields(actor), trusted: false };
  }

  /** The DO's narrowed hands handed to a pattern effect (effects.ts) — capabilities,
   *  never `this` and never a raw trusted `executeMutate`. The one sanctioned trusted
   *  write is `internalCreate`. */
  private effectCtx(actor: string): eff.EffectContext {
    return {
      env: this.env,
      instanceUrl: (p) => this.instanceUrl(p),
      schedule: (pr) => this.ctx.waitUntil(pr),
      runTask: (id, task) => this.runTask(id, task),
      readField: (pattern, id, field) => {
        // literal pattern/field only — effects pass constants; guard against any drift.
        if (!/^[a-z_]+$/i.test(pattern) || !/^[a-z_]+$/i.test(field)) return null;
        try {
          const r = this.db.exec(`SELECT ${field} FROM "${pattern}" WHERE id = ?`, id).toArray() as any[];
          return r[0]?.[field] ?? null;
        } catch { return null; }
      },
      internalCreate: (pattern, d) => this.internalCreate(pattern, d, actor),
    };
  }

  /** The ONLY trusted write an effect may perform: a born-hashed create through the
   *  owner context (mint the secret digest, then write). Effects never hold a raw
   *  `executeMutate`, so this stays the single audited internal write path. */
  private async internalCreate(
    pattern: string, d: Record<string, unknown>, actor: string,
  ): Promise<{ entry?: any; error?: boolean; once?: Record<string, string> | null }> {
    const once = await this.mintSecrets(pattern, d, "create");
    const r = data.executeMutate(this.ownerDataCtx(actor), pattern, "create", d);
    return { entry: r.entry, error: r.error, once };
  }

  /** query() for a served/untrusted surface — refuses kernel patterns at the
   *  engine. Every public/OG/publication read goes through this, so the kernel
   *  read-boundary lives at one chokepoint instead of a check per serve sink. */
  private servedQuery(patternName: string, filterJson: string, facets: string, sortField: string, limit: number, countOnly: boolean, groupBy: string, aggregateJson: string): string {
    return data.query(this.servedDataCtx(), patternName, filterJson, facets, sortField, limit, countOnly, groupBy, aggregateJson);
  }

  /** A pattern's class: "dataset" (structured records) or "knowledge" (default). */
  private patternClass(name: string): "knowledge" | "dataset" {
    return priming.getPatternClass(this.db, name);
  }

  async query(patternName: string, filterJson: string, facets: string, sortField: string, limit: number, countOnly: boolean, groupBy: string = "", aggregateJson: string = ""): Promise<string> {
    return data.query(this.ownerDataCtx(), patternName, filterJson, facets, sortField, limit, countOnly, groupBy, aggregateJson);
  }

  async mutate(patternName: string, operation: string, dataJson: string, actor: string = OWNER_ACTOR): Promise<string> {
    // Expand shortcuts: "fragment" → _short_term_fragments + create
    const shortcut = expandShortcut(patternName);
    if (shortcut) {
      patternName = shortcut.pattern;
      operation = shortcut.operation;
    }

    const parsed = JSON.parse(dataJson);

    // Write-time conflict surfacing: semantic neighbors for single creates in
    // user patterns (policy-gated, advisory only). The embedding computed here
    // is reused for the post-write upsert — no second AI call.
    let conflictCheck: { neighbors: priming.NeighborMatch[]; vector: number[] | null } | null = null;
    if (operation === "create" && !isKernelPattern(patternName) && this.patternExists(patternName)
        && this.patternClass(patternName) !== "dataset") {
      const policy = priming.getMemoryPolicy(this.db, patternName);
      if (policy.conflict_check !== "off") {
        conflictCheck = await priming.findNeighbors(this.primeCtx(), patternName, parsed);
      }
    }

    // Pattern effects (effects.ts): the side-effecting twin of the kernel's pure
    // pre-mutation hooks. `before` runs pre-commit (e.g. capture a document's R2 key
    // before archive so `after` can free the blob); `after` runs post-commit.
    const effects = eff.PATTERN_EFFECTS[patternName];
    const effectCtx = this.effectCtx(actor);
    const scratch = effects?.before ? (effects.before(parsed, operation, effectCtx) || {}) : {};

    // Born-hashed secrets: a `secret` column (e.g. _access_tokens.token) is set to
    // its digest BEFORE insert, so the raw never lands in the row/audit/broadcast.
    const minted = await this.mintSecrets(patternName, parsed, operation);

    const result = data.executeMutate(this.ownerDataCtx(actor), patternName, operation, parsed);
    if (!result.error) {
      if (conflictCheck?.neighbors.length) {
        result.possible_overlap = [
          ...(result.possible_overlap ?? []),
          ...conflictCheck.neighbors.map(n => ({ ...n, reason: "semantic_similarity" })),
        ];
        result.overlap_guidance = "Advisory only — the entry was created. If it duplicates or replaces an existing entry, consider updating that entry instead, or link supersession: mutate(pattern: \"link\", data: {source: \"" + patternName + "/" + result.entry?.id + "\", target: \"" + patternName + "/{old_id}\", label: \"supersedes\"}).";
      }
      // Granular delta so the UI can patch one element instead of refetching the
      // whole pattern — the heart of "only the element the agent changed redraws".
      this.broadcastChange([patternName], { op: operation, id: result.entry?.id ?? parsed.id, entry: result.entry ?? null });
      this.embedAfterMutate(patternName, operation, result.entry?.id, conflictCheck?.vector ?? undefined);
      // The raw preimage exists ONLY here — placed on the response AFTER the
      // (sealed) broadcast above, so the one-time mint value reaches the caller
      // while the DB, the audit log, and the /ws delta hold only the digest.
      if (minted && result.entry) {
        for (const [c, raw] of Object.entries(minted)) result.entry[c] = raw;
        result._once = minted;
      }
      // Post-commit pattern effects: document upload ticket, page links, run task,
      // R2 blob free on archive. One dispatch instead of a per-pattern if-pile.
      if (effects?.after) await effects.after(result.entry, result, parsed, operation, scratch, effectCtx);
    }
    return JSON.stringify(result, null, 2);
  }

  // === Document store (R2-backed blobs) ===

  /** Record a completed upload: bind the R2 key + metadata to the document entry
   *  and burn the single-use token. The route has already streamed the bytes to
   *  R2; on any failure here it deletes that orphaned object. */
  async consumeDocumentUpload(token: string, r2Key: string, contentType: string, size: number): Promise<string> {
    const accessToken = await cred.findAccessToken(this.db, token);
    if (!accessToken) return this.errorJson("Invalid or expired upload token");
    if (!cred.scopeMatches(accessToken.scope, "document")) return this.errorJson("Token does not have document scope");

    let documentId: number;
    try {
      documentId = JSON.parse(accessToken.constraints ?? "{}").document_id;
    } catch { return this.errorJson("Upload token has invalid constraints"); }
    if (documentId == null) return this.errorJson("Upload token missing document_id");

    const rows = this.db.exec(
      `SELECT id FROM "_documents" WHERE id = ? AND archived_at IS NULL`, documentId
    ).toArray();
    if (rows.length === 0) return this.errorJson("Document not found");

    this.db.exec(
      `UPDATE "_documents" SET r2_key = ?, "size" = ?, content_type = ?, stored_at = datetime('now'), updated_at = datetime('now'), version = version + 1 WHERE id = ?`,
      r2Key, size, contentType, documentId
    );
    cred.consumeToken(this.db, accessToken.id);
    this.broadcastChange(["_documents"]);

    const entry = this.db.exec(`SELECT * FROM "_documents" WHERE id = ?`, documentId).one();
    return JSON.stringify({ uploaded: true, id: documentId, bytes: size, content_type: contentType, entry });
  }

  /** Record extracted text + status on a document, then re-embed so the text
   *  joins prime recall (search already covers the facet). Called by the upload
   *  route after it pulls text from the bytes (inline for text, async for PDF). */
  async recordExtraction(documentId: number, text: string, status: string): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT id FROM "_documents" WHERE id = ? AND archived_at IS NULL`, documentId
      ).toArray();
      if (rows.length === 0) return this.errorJson("Document not found");

      this.db.exec(
        `UPDATE "_documents" SET extracted_text = ?, extraction_status = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?`,
        text || null, status, documentId
      );
      this.broadcastChange(["_documents"]);
      // Re-embed with the extracted text included (buildEmbedText reads text facets).
      this.ctx.waitUntil(priming.embedEntry(this.primeCtx(), "_documents", documentId));
      return JSON.stringify({ recorded: true, id: documentId, status, chars: (text || "").length });
    } catch (err: any) {
      return this.errorJson(`Failed to record extraction: ${err.message}`);
    }
  }

  /** Schedule async PDF text extraction inside the DO (which has a real
   *  waitUntil — the route ctx does not). Marks pending, then reads the blob
   *  back from R2, extracts, and records. Returns immediately; the work
   *  outlives the RPC via ctx.waitUntil. Best-effort: failures land as status. */
  async extractDocument(id: number): Promise<string> {
    const rows = this.db.exec(
      `SELECT r2_key FROM "_documents" WHERE id = ? AND archived_at IS NULL`, id
    ).toArray() as any[];
    if (rows.length === 0 || !rows[0].r2_key) return this.errorJson("Document not found or not uploaded");
    const r2Key = rows[0].r2_key as string;

    this.db.exec(`UPDATE "_documents" SET extraction_status = 'pending', updated_at = datetime('now') WHERE id = ?`, id);

    this.ctx.waitUntil((async () => {
      try {
        const obj = this.env.DOCUMENTS ? await this.env.DOCUMENTS.get(r2Key) : null;
        if (!obj) { await this.recordExtraction(id, "", "failed"); return; }
        const text = capText(await extractPdfText(await obj.arrayBuffer()));
        await this.recordExtraction(id, text, text.trim() ? "done" : "empty");
      } catch {
        await this.recordExtraction(id, "", "failed");
      }
    })());

    return JSON.stringify({ scheduled: true, id });
  }

  /** Resolve a document for serving. Returns found:false until bytes exist. */
  async resolveDocument(id: number): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT title, visibility, r2_key, content_type, stored_at FROM "_documents" WHERE id = ? AND archived_at IS NULL`, id
      ).toArray() as any[];
      if (rows.length === 0 || !rows[0].r2_key) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, ...rows[0] });
    } catch {
      return JSON.stringify({ found: false });
    }
  }

  async batchMutate(operationsJson: string, actor: string = OWNER_ACTOR): Promise<string> {
    const operations = JSON.parse(operationsJson) as { pattern: string; operation: string; data: any }[];

    if (operations.length > data.LIMITS.BATCH_OPS) {
      return this.errorJson(`Batch too large: ${operations.length} operations exceeds limit of ${data.LIMITS.BATCH_OPS}`);
    }

    for (const op of operations) {
      if (!this.patternExists(op.pattern))
        return this.errorJson(`Pattern "${op.pattern}" does not exist`);
    }

    // Born-hashed secrets must be hashed BEFORE the sync transaction (crypto is
    // async). Pre-hash each secret-creating op's column and keep the raw to attach
    // to its result afterward — so a batch-minted token is digest-at-rest too.
    const onces: (Record<string, string> | null)[] = [];
    for (const op of operations) onces.push(await this.mintSecrets(op.pattern, op.data, op.operation));

    const ctx = this.ownerDataCtx(actor);
    const results: any[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const op of operations) {
        const result = data.executeMutate(ctx, op.pattern, op.operation, op.data);
        if (result.error) throw new Error(result.message);
        results.push(result);
      }
    });
    // Attach each one-time raw preimage to its result (DB holds only the digest).
    results.forEach((r, i) => { const o = onces[i]; if (o && r.entry) { for (const [c, raw] of Object.entries(o)) r.entry[c] = raw; r._once = o; } });

    const affectedPatterns = [...new Set(operations.map(op => op.pattern))];
    this.broadcastChange(affectedPatterns);
    for (const r of results) {
      this.embedAfterMutate(r.pattern, r.operation, r.entry?.id);
    }
    return JSON.stringify({ batch: true, results, count: results.length }, null, 2);
  }

  async consumeUpload(token: string, content: string): Promise<string> {
    // Tokens are stored hashed; hash the presented value to look it up.
    const tokenHash = await cred.hashToken(token);
    // Check for consumed token first (findAccessToken excludes consumed)
    const consumed = this.db.exec(
      `SELECT 1 FROM "_access_tokens" WHERE token = ? AND consumed_at IS NOT NULL`, tokenHash
    ).toArray();
    if (consumed.length > 0) return this.errorJson("Upload token has already been used");

    const accessToken = await cred.findAccessToken(this.db, token);
    if (!accessToken) return this.errorJson("Invalid or expired upload token");
    if (!cred.scopeMatches(accessToken.scope, "upload")) return this.errorJson("Token does not have upload scope");

    const constraints = accessToken.constraints ? JSON.parse(accessToken.constraints) : null;
    if (!constraints) return this.errorJson("Upload token missing constraints");

    // target_pattern / target_facet are interpolated as SQL identifiers below.
    // They were validated when the token was created, but re-check here so a
    // malformed/legacy constraint can never break out of the identifier quoting.
    const IDENT_RE = /^[a-z_][a-z0-9_-]*$/;
    if (typeof constraints.target_pattern !== "string" || !IDENT_RE.test(constraints.target_pattern) || !this.patternExists(constraints.target_pattern))
      return this.errorJson("Upload token has an invalid target pattern");
    // Uploads write user patterns only. consumeUpload uses raw UPDATE (not
    // executeMutate), so it must enforce the kernel/internal-write boundary
    // itself — this catches any token minted before the create-hook guard, and
    // closes the _web_cache / _system_docs poisoning path directly.
    if (!isValidWriteTarget(constraints.target_pattern))
      return this.errorJson("Upload token has an invalid target pattern");
    if (typeof constraints.target_facet !== "string" || !IDENT_RE.test(constraints.target_facet))
      return this.errorJson("Upload token has an invalid target facet");

    const contentBytes = new TextEncoder().encode(content).length;
    if (contentBytes > data.LIMITS.ENTRY_BYTES)
      return this.errorJson(`Content too large: ${Math.round(contentBytes / 1024)}KB exceeds the 1MB limit`);

    try {
      if (constraints.mode === "append") {
        this.db.exec(
          `UPDATE "${constraints.target_pattern}" SET "${constraints.target_facet}" = COALESCE("${constraints.target_facet}", '') || ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
          content, constraints.target_id
        );
      } else {
        this.db.exec(
          `UPDATE "${constraints.target_pattern}" SET "${constraints.target_facet}" = ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
          content, constraints.target_id
        );
      }

      if (this.hasKernelVersion(constraints.target_pattern)) {
        try {
          this.db.exec(`UPDATE "${constraints.target_pattern}" SET version = version + 1 WHERE id = ?`, constraints.target_id);
        } catch { /* No version column — fine */ }
      }
    } catch (err: any) {
      // Don't echo the raw SQLite error to the (low-trust) upload caller — it can
      // leak column names, constraints, and internal table structure.
      console.error("Upload write failed:", err?.message);
      return this.errorJson("Upload write failed");
    }

    cred.consumeToken(this.db, accessToken.id);

    const record = this.db.exec(
      `SELECT * FROM "${constraints.target_pattern}" WHERE id = ?`, constraints.target_id
    ).one();

    this.broadcastChange([constraints.target_pattern]);

    return JSON.stringify({
      uploaded: true, bytes: contentBytes,
      target: { pattern: constraints.target_pattern, id: constraints.target_id, facet: constraints.target_facet },
      mode: constraints.mode, entry: record,
    }, null, 2);
  }

  // === Web resolution (delegated to web.ts) ===

  private webCtx(): web.WebContext {
    return { env: this.env as any, db: this.db };
  }

  private async resolveWeb(url: string, retain?: boolean): Promise<string> {
    const result = await web.resolveWeb(this.webCtx(), url, retain);

    if (result.metadata?.error) {
      return this.errorJson(result.metadata.message as string);
    }

    // Embed fresh fetches for prime recall
    if (!result.cached && result.content) {
      try {
        const cached = this.db.exec(
          `SELECT id FROM "_web_cache" WHERE url = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`, url
        ).toArray() as any[];
        if (cached.length > 0) {
          this.ctx.waitUntil(priming.embedEntry(this.primeCtx(), "_web_cache", cached[0].id));
        }
      } catch { /* best-effort */ }
    }

    return JSON.stringify(result, null, 2);
  }

  // === URI resolution ===

  async resolve(input: string, retain?: boolean): Promise<string> {
    // https://, http://, and at:// (Bluesky AT Protocol) URIs → web resolution.
    // retain pins/unpins the cached snapshot; it's ignored for non-web URIs.
    if (input.startsWith("https://") || input.startsWith("http://") || input.startsWith("at://")) {
      return this.resolveWeb(input, retain);
    }

    const match = input.match(new RegExp(`^${URI_SCHEME}://(.+)$`));
    if (!match) return this.errorJson(`Invalid URI scheme. Expected ${URI_PREFIX} URI or https:// URL, got: ${input}`);

    const path = match[1];

    // Foreign URI: first segment contains a dot → hostname (local paths never do)
    const firstSlash = path.indexOf("/");
    const firstSegment = firstSlash === -1 ? path : path.substring(0, firstSlash);
    if (firstSegment.includes(".")) {
      const remainingPath = firstSlash === -1 ? "" : path.substring(firstSlash + 1);
      return this.federatedResolve(firstSegment, remainingPath);
    }

    if (path === "index") {
      return this.getIndex();
    }

    if (path === "history" || path.startsWith("history?")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const limit = Number(params.get("limit")) || 20;
      return this.getHistory(limit);
    }

    if (path === "stale" || path.startsWith("stale?")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const days = Number(params.get("days")) || undefined;
      return this.getStaleEntries(days);
    }

    const schemaMatch = path.match(/^schema\/(.+)$/);
    if (schemaMatch) {
      return this.getSchema(schemaMatch[1]);
    }

    const entryMatch = path.match(/^entry\/([^/]+)\/(.+)$/);
    if (entryMatch) {
      return this.getEntry(entryMatch[1], Number(entryMatch[2]));
    }

    if (path === "_system/" || path === "_system") {
      return this.getSystemDocList();
    }

    const sysMatch = path.match(/^_system\/([^/]+?)(\/default)?$/);
    if (sysMatch) {
      return this.getSystemDoc(sysMatch[1], !!sysMatch[2]);
    }

    // mutation or mutation/{pattern}?limit=N
    if (path === "mutation" || path.startsWith("mutation")) {
      const parts = path.split("?");
      const pathPart = parts[0];
      const params = new URLSearchParams(parts[1] || "");
      const limit = Number(params.get("limit")) || 50;
      const tableName = pathPart === "mutation" ? null : pathPart.replace("mutation/", "");
      return this.getMutationLog(tableName, limit);
    }

    return this.errorJson(`Unknown URI: ${input}. Valid patterns: ${uri("index")}, ${uri("schema/{pattern}")}, ${uri("entry/{pattern}/{id}")}, ${uri("history")}, ${uri("stale")}, ${uri("_system/{slug}")}, ${uri("mutation[/{pattern}]")}`);
  }

  // === Federated resolve: foreign hive URIs ===

  private async federatedResolve(host: string, path: string): Promise<string> {
    const [cleanPath, queryString] = path.split("?");
    const params = new URLSearchParams(queryString || "");
    const token = params.get("token");

    if (!cleanPath) {
      return this.errorJson(`Foreign URI ${uri(host + "/")} requires a path after the host`);
    }

    // SSRF guard: refuse to fetch loopback / private / link-local / internal
    // targets. Federation is for sovereign public hives; an attacker-influenced
    // URI must not be able to probe internal infrastructure or cloud metadata.
    if (isBlockedFederationHost(host)) {
      return this.errorJson(`Refusing to federate with non-public host: ${host}`);
    }

    // Consent boundary: only federate with hosts the human has explicitly
    // approved (entries in _federation_hosts). This is what stops an agent —
    // possibly acting on untrusted content — from sending this hive's access
    // token (?token=) to an arbitrary attacker-controlled host.
    if (!this.isFederationHostAllowed(host)) {
      return this.errorJson(
        `Host "${normalizeHost(host)}" is not on this hive's federation allow-list, so resolve will not contact it (and will not send any token). ` +
        `If the human approves federating with it, add it: mutate(pattern: "_federation_hosts", data: {host: "${normalizeHost(host)}"}).`
      );
    }

    // Build the fetch URL from the SAME normalized host we authorized above —
    // never the raw segment — so "what we approved" and "what we contact" can't
    // diverge.
    let currentUrl = `https://${normalizeHost(host)}/o/${cleanPath}`;

    // Manual redirect handling. The host block + consent allow-list are only
    // meaningful if every hop is re-validated: with the default redirect:"follow"
    // a compromised or redirecting peer could bounce us to 169.254.169.254 /
    // loopback (SSRF) or carry the owner's token to an un-approved host. We
    // follow at most MAX_REDIRECTS hops, re-checking the block list AND the
    // allow-list on each, and only send the token to allow-listed hosts.
    const MAX_REDIRECTS = 3;

    try {
      let response: Response;
      for (let hop = 0; ; hop++) {
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        response = await fetch(currentUrl, { headers, redirect: "manual" });

        const location = response.headers.get("Location");
        if (response.status >= 300 && response.status < 400 && location) {
          if (hop >= MAX_REDIRECTS) {
            return this.errorJson(`Foreign hive ${host} exceeded the redirect limit for: ${cleanPath}`);
          }
          let next: URL;
          try {
            next = new URL(location, currentUrl);
          } catch {
            return this.errorJson(`Foreign hive ${host} returned an invalid redirect for: ${cleanPath}`);
          }
          if (next.protocol !== "https:") {
            return this.errorJson(`Refusing to follow non-https redirect from ${host} (token not sent).`);
          }
          if (isBlockedFederationHost(next.host) || !this.isFederationHostAllowed(next.host)) {
            return this.errorJson(`Refusing to follow redirect from ${host} to non-allow-listed host ${next.host} (token not sent).`);
          }
          currentUrl = next.toString();
          continue;
        }
        break;
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 401) return this.errorJson(`Foreign hive at ${host} requires authorization for: ${cleanPath}`);
        if (status === 404) return this.errorJson(`Not found on foreign hive ${host}: ${cleanPath}`);
        return this.errorJson(`Foreign hive ${host} returned ${status} for: ${cleanPath}`);
      }

      const content = await response.text();
      const contentType = response.headers.get("Content-Type") || "text/plain";

      // Parse JSON responses so they nest cleanly
      if (contentType.includes("application/json")) {
        try {
          return JSON.stringify({ federated: true, host, path: cleanPath, content: JSON.parse(content) }, null, 2);
        } catch { /* fall through to text */ }
      }

      return JSON.stringify({ federated: true, host, path: cleanPath, content_type: contentType, content }, null, 2);
    } catch (e: any) {
      return this.errorJson(`Failed to reach foreign hive at ${host}: ${e.message}`);
    }
  }

  async search(term: string, objectsJson: string, limit: number): Promise<string> {
    return data.search(this.ownerDataCtx(), term, objectsJson, limit);
  }

  // === Mutation log ===

  private getMutationLog(tableName: string | null, limit: number): string {
    let sql = "SELECT * FROM _mutation_log";
    const bindings: any[] = [];
    if (tableName) {
      sql += " WHERE table_name = ?";
      bindings.push(tableName);
    }
    sql += " ORDER BY id DESC LIMIT ?";
    bindings.push(limit);

    const rows = this.db.exec(sql, ...bindings).toArray();
    return JSON.stringify({ mutations: rows, count: rows.length }, null, 2);
  }

  /** Revision history for one entry, oldest→newest: the audit log scoped to
   *  (pattern, id), with each UPDATE diffed (changed facet: from → to) and
   *  version/timestamp churn filtered out. The create is the first revision. */
  async getEntryHistory(pattern: string, id: number): Promise<string> {
    if (!this.patternExists(pattern)) return this.errorJson(`Pattern "${pattern}" does not exist`);
    const rows = this.db.exec(
      `SELECT operation, old_data, new_data, created_at FROM _mutation_log WHERE table_name = ? AND record_id = ? ORDER BY id ASC`,
      pattern, id
    ).toArray() as any[];
    const IGNORE = new Set(["id", "version", "created_at", "updated_at", "archived_at", "created_by", "updated_by"]);
    const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    const revisions = rows.map((r) => {
      const oldD = parse(r.old_data);
      const newD = parse(r.new_data);
      const snap = newD ?? oldD ?? {};
      const actor = (newD?.updated_by ?? newD?.created_by ?? oldD?.updated_by) || null;
      const changes: { facet: string; from: unknown; to: unknown }[] = [];
      if (r.operation === "UPDATE" && oldD && newD) {
        for (const k of Object.keys(newD)) {
          if (IGNORE.has(k)) continue;
          if (oldD[k] !== newD[k]) changes.push({ facet: k, from: oldD[k] ?? null, to: newD[k] ?? null });
        }
      }
      return { at: r.created_at, operation: r.operation, actor, changes, snapshot: snap };
    });
    return JSON.stringify({ pattern, id, revisions, count: revisions.length }, null, 2);
  }

  /** The display label for one entry — what a reference to it should show
   *  (deriveLabel: title-ish facet, else #id). Used by reference-format chips. */
  async getEntryLabel(pattern: string, id: number): Promise<string> {
    if (!this.patternExists(pattern)) return JSON.stringify({ label: `#${id}` });
    try {
      const row = this.db.exec(`SELECT * FROM "${pattern}" WHERE id = ? AND archived_at IS NULL`, id).toArray()[0];
      if (!row) return JSON.stringify({ label: `#${id}`, missing: true });
      const facets = this.db.exec(`SELECT name, type FROM _fields WHERE object_name = ? ORDER BY id`, pattern).toArray() as any[];
      return JSON.stringify({ label: deriveLabel(row as any, facets) });
    } catch {
      return JSON.stringify({ label: `#${id}` });
    }
  }

  // === Public pages (server-rendered HTML + OG card, for sharing) ===

  /** Aggregate rows for a block (reuses the query engine: group_by x, agg y).
   *  Still used by the metric block (no x) — chart blocks go through chartData. */
  private async aggRows(pattern: string, x: string | undefined, y: string | undefined, agg: string | undefined, sort: string): Promise<any[]> {
    const aggregate = aggSpec(agg || (y ? "sum" : "count"), y);
    try {
      // servedQuery refuses kernel patterns at the engine — the one read-boundary.
      const r = JSON.parse(this.servedQuery(pattern, "", "", sort || "", 200, false, x || "", aggregate));
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
  private async chartData(b: any): Promise<ChartPayload> {
    const rc = resolveChart(b);
    const q = chartQuery(rc);
    try {
      // servedQuery refuses kernel patterns — protects the OG path too, which
      // reaches chartData without renderBlockHtml's per-block guard.
      if (q.kind === "scatter") {
        const r = JSON.parse(this.servedQuery(b.pattern, "", q.facets ?? "", "", q.limit, false, "", ""));
        const data = (r.entries || []).map((e: any) => ({ label: String(e[rc.x!] ?? ""), value: Number(e[rc.y!]) || 0 }));
        return { multi: false, data };
      }
      if (q.kind === "series") {
        const r = JSON.parse(this.servedQuery(b.pattern, "", "", q.sort ?? "", q.limit, false, q.group_by ?? "", q.aggregate ?? ""));
        const { rows, keys } = pivotSeries(r.rows || [], rc.x!, rc.series!);
        return { multi: true, data: { xKey: rc.x!, rows, keys } };
      }
      const r = JSON.parse(this.servedQuery(b.pattern, "", "", q.sort ?? "", q.limit, false, q.group_by ?? "", q.aggregate ?? ""));
      const data = (r.rows || []).map((row: any) => ({ label: String(row[rc.x!] ?? ""), value: Number(row.value) || 0 }));
      return { multi: false, data };
    } catch {
      if (q.kind === "series") return { multi: true, data: { xKey: rc.x ?? "", rows: [], keys: [] } };
      return { multi: false, data: [] };
    }
  }

  private async renderBlockHtml(b: any): Promise<string> {
    const w = b.width === "half" ? "w-half" : b.width === "third" ? "w-third" : "w-full";
    const e = (v: unknown) => escapeXml(String(v ?? ""));
    // Defense-in-depth: a block whose pattern is a kernel control table must
    // never reach an unauthenticated reader (token values as chart labels, etc).
    // Render the empty placeholder instead of querying it — applies to every
    // pattern-reading block type (chart, metric, and any future view/entry/list).
    if (b?.pattern && isKernelPattern(b.pattern)) {
      return `<div class="pb-empty ${w}"></div>`;
    }
    switch (b.type) {
      case "heading": return `<h2 class="pb-h ${w}">${e(b.text)}</h2>`;
      case "text": return `<p class="pb-t ${w}">${e(b.text)}</p>`;
      case "metric": {
        const rows = await this.aggRows(b.pattern, undefined, b.metric, b.agg, "");
        const v = rows[0] ? Number(rows[0].value) : null;
        return `<div class="pb-metric ${w}"><div class="pb-metric-n">${v == null ? "—" : new Intl.NumberFormat("en").format(v)}</div><div class="pb-metric-l">${e(b.label)}</div></div>`;
      }
      case "chart": {
        const payload = await this.chartData(b);
        const has = payload.multi ? payload.data.rows.length : payload.data.length;
        const svg = has ? renderChartSvg(b.mark || "bar", payload, { stack: b.stack === true }) : `<div class="pb-empty">no data</div>`;
        return `<figure class="pb-chart ${w}">${b.title ? `<figcaption class="pb-chart-t">${e(b.title)}</figcaption>` : ""}<div class="pb-chart-c">${svg}</div>${b.caption ? `<figcaption class="pb-chart-cap">${e(b.caption)}</figcaption>` : ""}</figure>`;
      }
      default: return ""; // embeds (view/entry/list) aren't served on public pages yet
    }
  }

  private getPublicPageRow(path: string): any | null {
    try {
      return this.db.exec(`SELECT name, title, description, blocks FROM "_pages" WHERE path = ? AND visibility = 'public' AND archived_at IS NULL`, path).toArray()[0] ?? null;
    } catch { return null; }
  }

  async renderPublicPage(path: string): Promise<string | null> {
    const row = this.getPublicPageRow(path);
    if (!row) return null;
    let blocks: any[] = [];
    try { blocks = JSON.parse(row.blocks || "[]"); } catch { /* */ }
    // DoS backstop: each chart/metric block is a DB aggregate run sequentially
    // on the single-threaded DO, on an unauthenticated edge-cacheable URL. Cap
    // the render so a page with hundreds of heavy blocks can't pin the DO;
    // overflow blocks are silently dropped.
    const MAX_BLOCKS = 32;
    if (Array.isArray(blocks) && blocks.length > MAX_BLOCKS) blocks = blocks.slice(0, MAX_BLOCKS);
    const parts: string[] = [];
    for (const b of blocks) parts.push(await this.renderBlockHtml(b));
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

  async renderPageOgSvg(path: string): Promise<string | null> {
    const row = this.getPublicPageRow(path);
    if (!row) return null;
    let blocks: any[] = [];
    try { blocks = JSON.parse(row.blocks || "[]"); } catch { /* */ }
    const chart = blocks.find((b: any) => b.type === "chart");
    if (!chart) return null;
    const data = await this.chartData(chart);
    // An empty chart would render a blank 1200×630 card — serve no OG image instead.
    const empty = data.multi ? data.data.rows.length === 0 : data.data.length === 0;
    if (empty) return null;
    return chartOgSvg(row.title || row.name, chart.mark || "bar", data, chart.stack === true);
  }

  // === System docs ===

  private getSystemDocList(): string {
    const rows = this.db.exec(
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

  private getSystemDoc(slug: string, returnDefault: boolean): string {
    const rows = this.db.exec(
      `SELECT * FROM "_system_docs" WHERE slug = ?`,
      slug
    ).toArray() as any[];
    if (rows.length === 0) return this.errorJson(`No system doc with slug: ${slug}`);
    const doc = rows[0];
    let content = returnDefault ? doc.default_content : (doc.content ?? doc.default_content);

    // Instance doc is fully computed at resolve time — regenerate host-related
    // lines from the most recently observed Host header rather than serving the
    // seed-time snapshot, which baked in a possibly-stale env.WORKER_HOST.
    if (slug === "instance" && !returnDefault) {
      content = this.renderInstanceDoc() + this.computeStorageStats();
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

  private renderInstanceDoc(): string {
    const host = this.currentHost();
    return `# Instance Info

- **Host**: ${host}
- **Base URL**: https://${host}
- **MCP endpoint**: https://${host}/mcp
- **Upload endpoint**: https://${host}/upload/{token}
- **Shared entries**: https://${host}/o/entry/{pattern}/{id}
- **Egress outputs**: https://${host}/o/{path}
- **Ingress inputs**: https://${host}/i/{path}`;
  }

  private computeStorageStats(): string {
    try {
      const tables = this.db.exec(
        "SELECT name FROM _objects WHERE archived_at IS NULL ORDER BY name"
      ).toArray() as { name: string }[];
      let totalEntries = 0;
      let totalBytes = 0;
      for (const t of tables) {
        try {
          const cols = this.db.exec(`PRAGMA table_info("${t.name}")`).toArray() as any[];
          const textCols = cols.filter((c: any) => c.type === "TEXT" || c.type === "").map((c: any) => c.name);
          const sumExpr = textCols.length
            ? textCols.map((c: string) => `COALESCE(LENGTH("${c}"), 0)`).join(" + ")
            : "0";
          const r = this.db.exec(
            `SELECT COUNT(*) as c, SUM(${sumExpr}) as bytes FROM "${t.name}" WHERE archived_at IS NULL`
          ).one() as any;
          totalEntries += r.c;
          totalBytes += r.bytes || 0;
        } catch { /* table may be missing */ }
      }
      const mutations = (this.db.exec("SELECT COUNT(*) as c FROM _mutation_log").one() as any).c;
      const fmt = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
      return `\n\n## Storage\n\n- **Data**: ${fmt(totalBytes)} · **Patterns**: ${tables.length} · **Active entries**: ${totalEntries} · **Mutations logged**: ${mutations}`;
    } catch {
      return "";
    }
  }

  // === System tasks ===

  private async runTask(taskId: number, task: string) {
    this.db.exec(
      `UPDATE "_system_tasks" SET status = 'running', updated_at = datetime('now') WHERE id = ?`, taskId
    );
    this.broadcastChange(["_system_tasks"]);

    try {
      let result: string;
      switch (task) {
        case "seed_vectors":
          result = await this.seedVectors();
          break;
        default:
          result = JSON.stringify({ error: true, message: `Unknown task: ${task}` });
      }
      this.db.exec(
        `UPDATE "_system_tasks" SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?`,
        result, taskId
      );
    } catch (err: any) {
      this.db.exec(
        `UPDATE "_system_tasks" SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?`,
        JSON.stringify({ error: true, message: err.message }), taskId
      );
    }
    this.broadcastChange(["_system_tasks"]);
  }

  // === Priming (auto-associative memory, delegated to prime.ts) ===

  private primeCtx(): priming.PrimeContext {
    return {
      env: this.env as any,
      db: this.db,
      patternExists: (name) => this.patternExists(name),
    };
  }

  private embedAfterMutate(pattern: string, operation: string, id?: number, precomputed?: number[]) {
    if (!id) return;
    // Local dev: skip the remote AI/Vectorize calls so the loop is fast and
    // self-contained (set via `wrangler dev --var SKIP_EMBED:1`). Recall/search
    // are degraded locally; query/mutate (the UI surface) are unaffected. The
    // test suite leaves this unset so embedding is still exercised.
    if ((this.env as any).SKIP_EMBED) return;
    const ctx = this.primeCtx();
    if (operation === "archive") {
      // Always attempt removal — this also GCs any LEGACY vector left over from
      // before kernel patterns were excluded from embedding (a no-op if none).
      this.ctx.waitUntil(priming.removeEntry(ctx, pattern, id));
    } else {
      // Kernel control tables (_access_tokens, _members, …) are not memory — never
      // embed them for recall (the same set prime excludes). _documents et al. that
      // ARE prime-included still embed. Dataset patterns are records, not memory.
      if (isKernelPattern(pattern) && !primeIncluded(pattern)) return;
      if (this.patternClass(pattern) === "dataset") return;
      this.ctx.waitUntil(priming.embedEntry(ctx, pattern, id, precomputed));
    }
  }

  async prime(context: string, patternsJson: string, limit: number): Promise<string> {
    const patterns = patternsJson ? JSON.parse(patternsJson) as string[] : undefined;
    const [primeResult, charter] = await Promise.all([
      priming.prime(this.primeCtx(), context, patterns, limit),
      this.getCharter(),
    ]);

    // Include capabilities brief if available
    let capabilities: string | undefined;
    try {
      const rows = this.db.exec(
        `SELECT content, default_content FROM "_system_docs" WHERE slug = 'capabilities'`
      ).toArray() as any[];
      if (rows.length > 0) capabilities = rows[0].content ?? rows[0].default_content;
    } catch { /* not seeded yet */ }

    // Pattern directory: non-kernel patterns with counts and descriptions
    const patternDir: { name: string; description: string; entries: number }[] = [];
    try {
      const objs = this.db.exec(
        `SELECT name, description FROM _objects WHERE archived_at IS NULL AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`
      ).toArray() as { name: string; description: string }[];
      for (const obj of objs) {
        try {
          const r = this.db.exec(
            `SELECT COUNT(*) as c FROM "${obj.name}" WHERE archived_at IS NULL`
          ).one() as { c: number };
          patternDir.push({ name: obj.name, description: obj.description, entries: r.c });
        } catch {
          patternDir.push({ name: obj.name, description: obj.description, entries: 0 });
        }
      }
    } catch { /* fresh instance */ }

    // Promote short-term fragments that surface repeatedly. Promotion eligibility
    // is derived from _fragment_access_log (one row per prime hit), not a stored
    // counter — there's no parallel state to disagree with the log.
    //
    // Idempotency guard: if a long-term entry already references this short-term
    // fragment via source_id, we've already promoted; skip.
    const PROMOTION_THRESHOLD = 3;
    try {
      const fragmentHits = primeResult.results
        .filter(r => r.pattern === "_short_term_fragments")
        .map(r => r.id);
      for (const id of fragmentHits) {
        // Append a hit to the log (this is the only mutation; everything else is read-then-decide)
        this.db.exec(
          `INSERT INTO "_fragment_access_log" (fragment_id) VALUES (?)`, id
        );
        // Already promoted? Don't re-promote (and don't re-archive a still-active fragment)
        const existing = this.db.exec(
          `SELECT 1 FROM "_long_term_fragments" WHERE source_id = ? AND archived_at IS NULL LIMIT 1`, id
        ).toArray();
        if (existing.length > 0) continue;
        // Eligible? Count log rows for this fragment
        const hits = (this.db.exec(
          `SELECT COUNT(*) as c FROM "_fragment_access_log" WHERE fragment_id = ?`, id
        ).one() as any).c as number;
        if (hits < PROMOTION_THRESHOLD) continue;
        // Read the source fragment and promote
        const row = this.db.exec(
          `SELECT content, context FROM "_short_term_fragments" WHERE id = ? AND archived_at IS NULL`, id
        ).one() as any;
        if (!row) continue;
        this.db.exec(
          `INSERT INTO "_long_term_fragments" (content, context, source_id) VALUES (?, ?, ?)`,
          row.content, row.context, id
        );
        this.db.exec(
          `UPDATE "_short_term_fragments" SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, id
        );
        const promoted = this.db.exec(
          `SELECT id FROM "_long_term_fragments" WHERE source_id = ? ORDER BY id DESC LIMIT 1`, id
        ).one() as any;
        if (promoted) {
          this.ctx.waitUntil(priming.embedEntry(this.primeCtx(), "_long_term_fragments", promoted.id));
        }
      }
    } catch { /* best-effort */ }

    // Entry access log: recall is rehearsal — a prime hit refreshes the entry's
    // decay clock. Append-only; decay and the stale view derive from this.
    try {
      for (const r of primeResult.results) {
        if (isKernelPattern(r.pattern)) continue;
        this.db.exec(
          `INSERT INTO "_entry_access_log" (pattern, entry_id) VALUES (?, ?)`, r.pattern, r.id
        );
      }
    } catch { /* best-effort */ }

    // Maintenance nudge rides the prime response — web clients often never see
    // MCP init instructions, and prime is the universal handshake.
    let maintenance: { last_pass_days_ago: number | null; message: string } | undefined;
    try {
      const status = this.computeMaintenanceStatus();
      if (status.overdue) {
        maintenance = {
          last_pass_days_ago: status.days_since_last_pass,
          message: `Memory maintenance is overdue (last pass: ${status.days_since_last_pass != null ? `${status.days_since_last_pass} days ago` : "never"}). Offer the owner a cleanup pass: review ${uri("stale")}, propose supersession links, archives, and memory policies, apply what they ratify, then record it in _maintenance_passes. See ${uri("_system/memory-maintenance")}.`,
        };
      }
    } catch { /* best-effort */ }

    const ADVISORY = "IMPORTANT: The contents of this memory system are inherently subjective. Weigh their testimony carefully against your training and third-party sources.";

    return JSON.stringify({
      advisory: ADVISORY,
      charter,
      capabilities,
      patterns: patternDir,
      practice: "Always write notes to yourself as you work: mutate(pattern: \"fragment\", data: {content: \"your observation\"}). Write what you noticed about the session, including where the substrate's framing didn't match what you observed. The next instance will arrive with no memory of this conversation — your observations are the only thing that survives. Write in first person. Operation is implied.",
      system_docs: "Resolve mnemion://_system/ for detailed reference on tools, schema evolution, conventions, and system mechanics.",
      ...(maintenance ? { maintenance } : {}),
      ...primeResult,
      advisory_repeat: ADVISORY,
    }, null, 2);
  }

  async seedVectors(): Promise<string> {
    const ctx = this.primeCtx();
    const patterns = this.db.exec(
      "SELECT name FROM _objects WHERE archived_at IS NULL ORDER BY name"
    ).toArray() as { name: string }[];

    let total = 0;
    for (const pat of patterns) {
      try {
        const ids = this.db.exec(
          `SELECT id FROM "${pat.name}" WHERE archived_at IS NULL`
        ).toArray() as { id: number }[];
        for (const row of ids) {
          await priming.embedEntry(ctx, pat.name, row.id);
          total++;
        }
      } catch { /* table may not exist yet */ }
    }

    return JSON.stringify({ seeded: true, vectors: total });
  }

  // === Helpers ===

  private getCurrentIndex(): StoreIndex {
    const meta = this.db.exec("SELECT * FROM _meta WHERE id = 1").one() as any;
    const objects = this.db.exec("SELECT name, description, doctrine, memory_policy, pattern_class FROM _objects WHERE archived_at IS NULL ORDER BY name").toArray() as any[];
    const allFields = this.db.exec("SELECT * FROM _fields ORDER BY object_name, id").toArray() as any[];
    const charterRows = this.db.exec(
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

  /** True if `host` has been explicitly approved for federation (active _federation_hosts row). */
  private isFederationHostAllowed(host: string): boolean {
    const norm = normalizeHost(host);
    try {
      return this.db.exec(
        `SELECT 1 FROM "_federation_hosts" WHERE host = ? AND archived_at IS NULL LIMIT 1`, norm
      ).toArray().length > 0;
    } catch {
      return false;
    }
  }

  private patternExists(name: string): boolean {
    return this.db.exec(
      "SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NULL", name
    ).toArray().length > 0;
  }

  private entryExists(pattern: string, id: number): boolean {
    try {
      return this.db.exec(
        `SELECT 1 FROM "${pattern}" WHERE id = ? AND archived_at IS NULL`, id
      ).toArray().length > 0;
    } catch { return false; }
  }

  /** True if the table's `version` column is the kernel auto-increment, not a user field. */
  private hasKernelVersion(patternName: string): boolean {
    // If _fields has a user-defined 'version' field for this object,
    // the column is user-managed (e.g. semver text). Otherwise it's kernel.
    return this.db.exec(
      "SELECT 1 FROM _fields WHERE object_name = ? AND name = 'version'",
      patternName
    ).toArray().length === 0;
  }

  // === Consent round-trips ===

  /** Two-phase consent that survives session churn. First call with a key arms
   *  it (10-minute TTL) and returns false — the caller should surface the
   *  confirmation message. Re-issuing the same key while armed consumes it and
   *  returns true — the caller proceeds. Durable in DO storage because
   *  sessionless MCP clients land every call on a fresh SessionDO, where an
   *  in-memory set can never complete the handshake. The consent signal is the
   *  deliberate re-issue of identical arguments; the TTL bounds how long an
   *  armed confirmation can wait. Fails closed: storage errors never confirm. */
  async checkAndArmConsent(key: string): Promise<boolean> {
    try {
      this.db.exec(`DELETE FROM _pending_consent WHERE expires_at < datetime('now')`);
      const armed = this.db.exec(
        `SELECT 1 FROM _pending_consent WHERE key = ?`, key
      ).toArray().length > 0;
      if (armed) {
        this.db.exec(`DELETE FROM _pending_consent WHERE key = ?`, key);
        return true;
      }
      this.db.exec(
        `INSERT OR REPLACE INTO _pending_consent ("key", expires_at) VALUES (?, datetime('now', '+10 minutes'))`, key
      );
      return false;
    } catch {
      return false;
    }
  }

  // === Credentials (delegated to credentials.ts) ===

  async hasPasskey(): Promise<boolean> { return cred.hasPasskey(this.db); }
  async getPasskeys() { return cred.getPasskeys(this.db); }
  async storePasskey(credentialId: string, publicKey: string, counter: number, transports: string, member: string | null = null) {
    cred.storePasskey(this.db, credentialId, publicKey, counter, transports, member);
  }
  async updatePasskeyCounter(credentialId: string, counter: number) { cred.updatePasskeyCounter(this.db, credentialId, counter); }
  async validateAccessToken(token: string, requiredScope: string) {
    return cred.validateAccessToken(this.db, token, requiredScope);
  }
  /** Validate a token's scope AND return its parsed constraints in one hashed
   *  lookup. The token column is a digest at rest, so a raw `WHERE token = ?`
   *  query (as marketplace did) matches nothing — callers needing constraints
   *  must go through this. */
  async resolveTokenConstraints(token: string, requiredScope: string): Promise<string> {
    const t = await cred.findAccessToken(this.db, token);
    if (!t || !cred.scopeMatches(t.scope, requiredScope)) return JSON.stringify({ valid: false });
    // Absent constraints = no scope restriction (intended). Present-but-MALFORMED
    // constraints must fail CLOSED — never widen a scoped token to full access
    // because its constraints JSON couldn't be parsed.
    if (!t.constraints) return JSON.stringify({ valid: true, constraints: null });
    try { return JSON.stringify({ valid: true, constraints: JSON.parse(t.constraints) }); }
    catch { return JSON.stringify({ valid: false }); }
  }
  async resolveTokenActor(token: string, requiredScope: string) {
    return cred.resolveTokenActor(this.db, token, requiredScope);
  }
  async isMemberActive(member: string) { return cred.isMemberActive(this.db, member); }
  async resolveRegisterToken(token: string) { return cred.resolveRegisterToken(this.db, token); }
  async getRegisterToken(token: string) { return cred.getRegisterToken(this.db, token); }
  async approveRegisterToken(token: string) { return cred.approveRegisterToken(this.db, token); }
  async consumeAccessToken(id: number) { cred.consumeToken(this.db, id); }
  async validateAuthCode(code: string) { return cred.validateAuthCode(this.db, code); }
  async consumeAuthCode(code: string) { return cred.consumeAuthCode(this.db, code); }

  // === Export ===

  async exportPattern(patternName: string): Promise<{ error?: string; meta?: any; entries?: any[] }> {
    if (!this.patternExists(patternName))
      return { error: `Pattern "${patternName}" does not exist` };

    // Pattern metadata
    const obj = this.db.exec(
      "SELECT name, description, doctrine FROM _objects WHERE name = ?", patternName
    ).one() as any;
    const facets = this.db.exec(
      "SELECT name, type, required, default_value, references_object, options FROM _fields WHERE object_name = ? ORDER BY id", patternName
    ).toArray() as any[];

    const meta = {
      name: obj.name,
      description: obj.description,
      doctrine: obj.doctrine || "",
      facets: facets.map((f: any) => {
        const facet: any = { name: f.name, type: f.type, required: !!f.required };
        if (f.default_value != null) facet.default = JSON.parse(f.default_value);
        if (f.references_object) facet.links = f.references_object;
        if (f.options) facet.options = JSON.parse(f.options);
        return facet;
      }),
      exported_at: new Date().toISOString(),
    };

    // All entries (including archived, for completeness). seal: export is a raw
    // SELECT that bypasses the engine read-guard, so route rows through the sieve —
    // a sensitive column (token digest, r2_key, passkey material) never leaves via export.
    const entries = sealAll(patternName, this.db.exec(`SELECT * FROM "${patternName}" ORDER BY id`).toArray() as any[]);

    // Links involving this pattern
    try {
      const links = this.db.exec(
        `SELECT * FROM "_links" WHERE (source_pattern = ? OR target_pattern = ?) AND archived_at IS NULL`,
        patternName, patternName
      ).toArray();
      if (links.length > 0) (meta as any).links = links;
    } catch {}

    return { meta, entries };
  }

  // === HTTP I/O ===

  async getSharedEntry(pattern: string, id: number): Promise<string> {
    // Pattern is interpolated as a SQL identifier below — it MUST be validated
    // against the real pattern list first. This route is public and
    // unauthenticated; without this guard a crafted :pattern breaks out of the
    // identifier quoting and exfiltrates arbitrary tables by id (tokens, etc).
    if (!this.patternExists(pattern)) return JSON.stringify({ found: false });
    if (!Number.isInteger(id)) return JSON.stringify({ found: false });
    // Serve-time backstop: kernel control tables (_access_tokens, _passkeys, …)
    // must NEVER be served over this public, unauthenticated route — a _shared
    // row pointing at one would dump tokens. Refuse regardless of any sharing row.
    if (isKernelPattern(pattern)) return JSON.stringify({ found: false });
    try {
      // Single JOIN: check sharing + fetch entry in one query
      const rows = this.db.exec(
        `SELECT e.*, s.visibility FROM "${pattern}" e
         JOIN "_shared" s ON s.source_pattern = ? AND s.source_id = e.id AND s.archived_at IS NULL
         WHERE e.id = ? AND e.archived_at IS NULL`,
        pattern, id
      ).toArray() as any[];
      if (rows.length === 0) return JSON.stringify({ found: false });
      const { visibility, ...entry } = rows[0];
      // seal: this entry is served publicly at /o/entry — strip any sensitive
      // column (covers a future user pattern classified in SENSITIVE_COLUMNS).
      return JSON.stringify({ found: true, visibility, pattern, entry: seal(pattern, entry) });
    } catch {
      return JSON.stringify({ found: false });
    }
  }

  async resolvePublication(path: string): Promise<string> {
    let pub: any;
    try {
      const rows = this.db.exec(
        `SELECT * FROM "_publications" WHERE path = ? AND archived_at IS NULL`, path
      ).toArray() as any[];
      if (rows.length === 0) return JSON.stringify({ found: false });
      pub = rows[0];
    } catch {
      return JSON.stringify({ found: false });
    }

    // private = staged, not served (route layer never sees it)
    if (pub.visibility === "private") return JSON.stringify({ found: false });
    if (!this.patternExists(pub.source_pattern)) return JSON.stringify({ found: false });

    // Live projection: run the stored query against current truth
    const queryRaw = data.query(
      this.servedDataCtx(), pub.source_pattern, // served boundary: refuses a kernel source
      pub.filters || "", pub.facets || "", pub.sort || "-updated_at",
      pub.limit || 50, false,
    );
    const queryResult = JSON.parse(queryRaw);
    if (queryResult.error) return JSON.stringify({ found: false });
    // seal: these rows render into a public /p projection — strip any sensitive
    // column (a future user pattern classified in SENSITIVE_COLUMNS).
    let entries = sealAll(pub.source_pattern, queryResult.entries as Record<string, unknown>[]);

    // Publications project current truth: superseded entries drop out unless opted in
    if (!pub.include_superseded && entries.length > 0) {
      try {
        const ids = entries.map((e) => e.id);
        const placeholders = ids.map(() => "?").join(",");
        const superseded = new Set(
          this.db.exec(
            `SELECT target_id FROM "_links" WHERE label = 'supersedes' AND archived_at IS NULL AND target_pattern = ? AND target_id IN (${placeholders})`,
            pub.source_pattern, ...ids
          ).toArray().map((r: any) => r.target_id)
        );
        entries = entries.filter((e) => !superseded.has(e.id));
      } catch { /* _links may not exist */ }
    }

    const facetMeta = this.db.exec(
      "SELECT name, type FROM _fields WHERE object_name = ? ORDER BY id", pub.source_pattern
    ).toArray() as { name: string; type: string }[];

    const rendered = pubs.renderPublication(pub, entries, {
      facets: facetMeta,
      host: this.currentHost(),
    });

    // ETag source: content changes when the publication config OR any served entry changes
    let latest = pub.updated_at as string;
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

  async resolveOutput(path: string): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT content, mime_type, visibility, updated_at FROM "_outputs" WHERE path = ? AND archived_at IS NULL`,
        path
      ).toArray() as any[];
      if (rows.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, ...rows[0] });
    } catch {
      return JSON.stringify({ found: false });
    }
  }

  async getInputVisibility(path: string): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT visibility FROM "_inputs" WHERE path = ? AND archived_at IS NULL`,
        path
      ).toArray() as any[];
      if (rows.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, visibility: rows[0].visibility });
    } catch {
      return JSON.stringify({ found: false });
    }
  }

  async processInput(path: string, body: string, headersJson: string, queryJson: string): Promise<string> {
    const rows = this.db.exec(
      `SELECT * FROM "_inputs" WHERE path = ? AND archived_at IS NULL`,
      path
    ).toArray() as any[];
    if (rows.length === 0) return this.errorJson("No input endpoint for this path");

    const input = rows[0];
    let entryData: Record<string, unknown>;

    if (input.facet_mapping) {
      const mapping = JSON.parse(input.facet_mapping) as Record<string, string>;
      let parsedBody: unknown = null;
      try { parsedBody = JSON.parse(body); } catch { /* not JSON */ }

      entryData = evaluateMapping(mapping, {
        body: parsedBody,
        rawBody: body,
        headers: JSON.parse(headersJson),
        query: JSON.parse(queryJson),
      });
    } else if (input.body_facet) {
      entryData = { [input.body_facet]: body };
    } else {
      entryData = { body };
    }

    // Untrusted context: this is a public, unauthenticated HTTP path entering
    // below the MCP consent layer. executeMutate refuses any kernel target for
    // an untrusted write, so a repointed/legacy endpoint can't reach _shared et al.
    const result = data.executeMutate(this.servedDataCtx(), input.target_pattern, "create", entryData);
    if (!result.error) this.broadcastChange([input.target_pattern]);
    return JSON.stringify(result, null, 2);
  }

  // === Live updates via WebSocket (Hibernatable API) ===

  async fetch(request: Request): Promise<Response> {
    // Record the inbound host so instance-doc generation reflects reality, not
    // a wrangler config that can drift from the worker name.
    // Only retain a syntactically valid host (no scheme/path/spaces) — a
    // malformed/attacker Host header must never be stored and reflected into
    // generated URLs. (currentHost also prefers WORKER_HOST when configured.)
    const host = request.headers.get("host");
    if (host && /^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) this.lastKnownHost = host;
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // Browser doesn't send meaningful messages — ignore
  }

  webSocketClose(_ws: WebSocket) {
    // Cleanup handled automatically by runtime
  }

  private broadcastChange(patterns: string[], delta?: { op: string; id: unknown; entry: unknown }) {
    // seal: the delta leaves the DO over /ws to every connected client, so strip
    // any sensitive column (the one egress sieve — a secret must never ride a delta).
    const sealedEntry = delta ? seal(patterns[0], delta.entry as Record<string, unknown> | null) : undefined;
    const msg = JSON.stringify({
      type: "changed",
      patterns,
      ...(delta ? { delta: { pattern: patterns[0], op: delta.op, id: delta.id, entry: sealedEntry } } : {}),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* dead socket, runtime will clean up */ }
    }
  }

  private errorJson(message: string): string {
    return JSON.stringify({ error: true, message });
  }
}
