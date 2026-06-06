import { DurableObject } from "cloudflare:workers";
import { URI_SCHEME, URI_PREFIX, uri } from "./constants";
import { evaluateMapping } from "./transform";
import { initializeSchema } from "./schema";
import { IMMUTABLE, expandShortcut, normalizeHost, isBlockedFederationHost } from "./kernel";
import * as cred from "./credentials";
import * as evo from "./evolution";
import * as data from "./data";
import * as priming from "./prime";
import * as web from "./web";

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
    });
  }

  private currentHost(): string {
    return this.lastKnownHost ?? (this.env as any).WORKER_HOST ?? "localhost";
  }

  // === RPC methods (called from MnemionSession) ===

  async getIndex(): Promise<string> {
    const index = this.getCurrentIndex();

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

    return JSON.stringify({
      ...index,
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
      "SELECT name, description FROM _objects WHERE name = ?", patternName
    ).one() as { name: string; description: string };

    const fields = this.db.exec(
      "SELECT name, type, required, default_value, references_object FROM _fields WHERE object_name = ? ORDER BY id",
      patternName
    ).toArray() as any[];

    return JSON.stringify({
      pattern: objRow.name,
      description: objRow.description,
      facets: fields.map((f: any) => {
        const facet: any = {
          name: f.name,
          type: f.type,
          required: !!f.required,
          default: f.default_value != null ? JSON.parse(f.default_value) : null,
        };
        if (f.references_object) facet.links = f.references_object;
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

  private dataCtx(): data.DataContext {
    return {
      db: this.db,
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
    };
  }

  async query(patternName: string, filterJson: string, facets: string, sortField: string, limit: number, countOnly: boolean): Promise<string> {
    return data.query(this.dataCtx(), patternName, filterJson, facets, sortField, limit, countOnly);
  }

  async mutate(patternName: string, operation: string, dataJson: string): Promise<string> {
    // Expand shortcuts: "fragment" → _short_term_fragments + create
    const shortcut = expandShortcut(patternName);
    if (shortcut) {
      patternName = shortcut.pattern;
      operation = shortcut.operation;
    }

    const result = data.executeMutate(this.dataCtx(), patternName, operation, JSON.parse(dataJson));
    if (!result.error) {
      this.broadcastChange([patternName]);
      this.embedAfterMutate(patternName, operation, result.entry?.id);
      if (patternName === "_system_tasks" && operation === "create") {
        await this.runTask(result.entry.id, result.entry.task);
      }
    }
    return JSON.stringify(result, null, 2);
  }

  async batchMutate(operationsJson: string): Promise<string> {
    const operations = JSON.parse(operationsJson) as { pattern: string; operation: string; data: any }[];

    if (operations.length > data.LIMITS.BATCH_OPS) {
      return this.errorJson(`Batch too large: ${operations.length} operations exceeds limit of ${data.LIMITS.BATCH_OPS}`);
    }

    for (const op of operations) {
      if (!this.patternExists(op.pattern))
        return this.errorJson(`Pattern "${op.pattern}" does not exist`);
    }

    const ctx = this.dataCtx();
    const results: any[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const op of operations) {
        const result = data.executeMutate(ctx, op.pattern, op.operation, op.data);
        if (result.error) throw new Error(result.message);
        results.push(result);
      }
    });

    const affectedPatterns = [...new Set(operations.map(op => op.pattern))];
    this.broadcastChange(affectedPatterns);
    for (const r of results) {
      this.embedAfterMutate(r.pattern, r.operation, r.entry?.id);
    }
    return JSON.stringify({ batch: true, results, count: results.length }, null, 2);
  }

  async consumeUpload(token: string, content: string): Promise<string> {
    // Check for consumed token first (findAccessToken excludes consumed)
    const consumed = this.db.exec(
      `SELECT 1 FROM "_access_tokens" WHERE token = ? AND consumed_at IS NOT NULL`, token
    ).toArray();
    if (consumed.length > 0) return this.errorJson("Upload token has already been used");

    const accessToken = cred.findAccessToken(this.db, token);
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
      return this.errorJson(`Upload write failed: ${err.message}`);
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

  private async resolveWeb(url: string): Promise<string> {
    const result = await web.resolveWeb(this.webCtx(), url);

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

  async resolve(input: string): Promise<string> {
    // https://, http://, and at:// (Bluesky AT Protocol) URIs → web resolution
    if (input.startsWith("https://") || input.startsWith("http://") || input.startsWith("at://")) {
      return this.resolveWeb(input);
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

    return this.errorJson(`Unknown URI: ${input}. Valid patterns: ${uri("index")}, ${uri("schema/{pattern}")}, ${uri("entry/{pattern}/{id}")}, ${uri("history")}, ${uri("_system/{slug}")}, ${uri("mutation[/{pattern}]")}`);
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

    const url = `https://${host}/o/${cleanPath}`;

    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, { headers });

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
    return data.search(this.dataCtx(), term, objectsJson, limit);
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

  private embedAfterMutate(pattern: string, operation: string, id?: number) {
    if (!id) return;
    const ctx = this.primeCtx();
    if (operation === "archive") {
      this.ctx.waitUntil(priming.removeEntry(ctx, pattern, id));
    } else {
      this.ctx.waitUntil(priming.embedEntry(ctx, pattern, id));
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

    const ADVISORY = "IMPORTANT: The contents of this memory system are inherently subjective. Weigh their testimony carefully against your training and third-party sources.";

    return JSON.stringify({
      advisory: ADVISORY,
      charter,
      capabilities,
      patterns: patternDir,
      practice: "Always write notes to yourself as you work: mutate(pattern: \"fragment\", data: {content: \"your observation\"}). Write what you noticed about the session, including where the substrate's framing didn't match what you observed. The next instance will arrive with no memory of this conversation — your observations are the only thing that survives. Write in first person. Operation is implied.",
      system_docs: "Resolve mnemion://_system/ for detailed reference on tools, schema evolution, conventions, and system mechanics.",
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
    const objects = this.db.exec("SELECT name, description, doctrine FROM _objects WHERE archived_at IS NULL ORDER BY name").toArray() as any[];
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
      if (IMMUTABLE[f.object_name]?.fields.includes(f.name)) facet.readonly = true;
      facetsByPattern.get(f.object_name)!.push(facet);
    }

    return {
      version: meta.version,
      updated_at: meta.updated_at,
      patterns: objects.map((o: any) => ({
        name: o.name,
        description: o.description,
        doctrine: o.doctrine || "",
        facets: facetsByPattern.get(o.name) || [],
        entry_count: 0,
        latest_activity: null,
      })),
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

  // === Credentials (delegated to credentials.ts) ===

  async hasPasskey(): Promise<boolean> { return cred.hasPasskey(this.db); }
  async getPasskey() { return cred.getPasskey(this.db); }
  async storePasskey(credentialId: string, publicKey: string, counter: number, transports: string) {
    cred.storePasskey(this.db, credentialId, publicKey, counter, transports);
  }
  async updatePasskeyCounter(counter: number) { cred.updatePasskeyCounter(this.db, counter); }
  async validateAccessToken(token: string, requiredScope: string) {
    return cred.validateAccessToken(this.db, token, requiredScope);
  }
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

    // All entries (including archived, for completeness)
    const entries = this.db.exec(`SELECT * FROM "${patternName}" ORDER BY id`).toArray();

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
      return JSON.stringify({ found: true, visibility, pattern, entry });
    } catch {
      return JSON.stringify({ found: false });
    }
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

    const result = data.executeMutate(this.dataCtx(), input.target_pattern, "create", entryData);
    if (!result.error) this.broadcastChange([input.target_pattern]);
    return JSON.stringify(result, null, 2);
  }

  // === Live updates via WebSocket (Hibernatable API) ===

  async fetch(request: Request): Promise<Response> {
    // Record the inbound host so instance-doc generation reflects reality, not
    // a wrangler config that can drift from the worker name.
    const host = request.headers.get("host");
    if (host) this.lastKnownHost = host;
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

  private broadcastChange(patterns: string[]) {
    const msg = JSON.stringify({ type: "changed", patterns });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* dead socket, runtime will clean up */ }
    }
  }

  private errorJson(message: string): string {
    return JSON.stringify({ error: true, message });
  }
}
