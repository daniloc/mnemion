import { DurableObject } from "cloudflare:workers";
import { URI_SCHEME, URI_PREFIX, uri } from "./constants";
import { evaluateMapping } from "./transform";
import { initializeSchema } from "./schema";
import { applyKernelRules, IMMUTABLE, type KernelContext } from "./kernel";
import * as cred from "./credentials";
import * as evo from "./evolution";

// === Types ===

export interface StoreIndex {
  version: number;
  updated_at: string;
  patterns: IndexPatternEntry[];
  conventions: string[];
  guidance: string;
}

export interface IndexPatternEntry {
  name: string;
  description: string;
  facets: IndexFacetEntry[];
  entry_count: number;
}

export interface IndexFacetEntry {
  name: string;
  type: string;
  required: boolean;
  default?: string | number | boolean | null;
  links?: string | null;
  readonly?: boolean;
}

// === Constants ===

// version is intentionally excluded — it may be a user field (e.g. semver on _plugins).
// Kernel version handling is conditional per-table via hasKernelVersion().
const KERNEL_COLUMNS = new Set(["id", "created_at", "updated_at", "archived_at"]);

// === Guardrails ===

const LIMITS = {
  ENTRY_BYTES: 1_048_576,     // 1 MB per entry
  QUERY_ROWS: 1_000,          // max rows a single query can return
  BATCH_OPS: 100,             // max operations in a single batch mutate
};

function estimateRecordBytes(data: Record<string, unknown>): number {
  let bytes = 0;
  for (const v of Object.values(data)) {
    if (typeof v === "string") bytes += v.length * 2;  // rough UTF-16 estimate
    else if (typeof v === "number") bytes += 8;
    else if (typeof v === "boolean") bytes += 4;
    else if (v === null || v === undefined) bytes += 0;
    else bytes += JSON.stringify(v).length * 2;
  }
  return bytes;
}

// === Hive: per-user data storage ===

export class HiveDO extends DurableObject {
  private get db() {
    return this.ctx.storage.sql;
  }

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      initializeSchema(this.db);
    });
  }

  // === RPC methods (called from MnemionSession) ===

  async getIndex(): Promise<string> {
    const index = this.getCurrentIndex();

    // Enrich with live entry counts
    for (const pat of index.patterns) {
      try {
        const r = this.db.exec(
          `SELECT COUNT(*) as count FROM "${pat.name}" WHERE archived_at IS NULL`
        ).one() as { count: number };
        pat.entry_count = r.count;
      } catch {
        try {
          const r = this.db.exec(
            `SELECT COUNT(*) as count FROM "${pat.name}"`
          ).one() as { count: number };
          pat.entry_count = r.count;
        } catch {
          pat.entry_count = 0;
        }
      }
    }

    return JSON.stringify({
      ...index,
      system_docs: uri("_system/"),
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
      return JSON.stringify({ pattern: patternName, entry: rows[0] }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Failed to read entry: ${err.message}`);
    }
  }

  async listPatterns(): Promise<string[]> {
    const rows = this.db.exec("SELECT name FROM _objects ORDER BY name").toArray() as any[];
    return rows.map((r: any) => r.name);
  }

  // === Data operations ===

  async query(patternName: string, filterJson: string, facets: string, sortField: string, limit: number, countOnly: boolean): Promise<string> {
    if (!this.patternExists(patternName))
      return this.errorJson(`Pattern "${patternName}" does not exist`);

    // Count-only mode: return count without entries
    if (countOnly) {
      let countSql = `SELECT COUNT(*) as count FROM "${patternName}" WHERE archived_at IS NULL`;
      const countBindings: (string | number)[] = [];
      if (filterJson) {
        const filters: string[] = JSON.parse(filterJson);
        for (const expr of filters) {
          const match = expr.match(/^(\w+)(=|!=|>|<|>=|<=|~)(.+)$/);
          if (!match) return this.errorJson(`Invalid filter expression: ${expr}`);
          const [, field, op, value] = match;
          if (op === "~") {
            countSql += ` AND "${field}" LIKE ?`;
            countBindings.push(`%${value}%`);
          } else {
            countSql += ` AND "${field}" ${op} ?`;
            countBindings.push(value);
          }
        }
      }
      try {
        const r = this.db.exec(countSql, ...countBindings).one() as { count: number };
        return JSON.stringify({ pattern: patternName, count: r.count }, null, 2);
      } catch (err: any) {
        return this.errorJson(`Query failed: ${err.message}`);
      }
    }

    let sql = `SELECT`;

    // Projection
    if (facets) {
      const requested = facets.split(",").map((f) => f.trim());
      // Always include id
      if (!requested.includes("id")) requested.unshift("id");
      sql += ` ${requested.map((f) => `"${f}"`).join(", ")}`;
    } else {
      sql += ` *`;
    }

    sql += ` FROM "${patternName}" WHERE archived_at IS NULL`;

    // Filters: facet=value, facet>value, facet<value, facet~text
    const bindings: (string | number)[] = [];
    if (filterJson) {
      const filters: string[] = JSON.parse(filterJson);
      for (const expr of filters) {
        const match = expr.match(/^(\w+)(=|!=|>|<|>=|<=|~)(.+)$/);
        if (!match) return this.errorJson(`Invalid filter expression: ${expr}`);
        const [, field, op, value] = match;
        if (op === "~") {
          sql += ` AND "${field}" LIKE ?`;
          bindings.push(`%${value}%`);
        } else {
          sql += ` AND "${field}" ${op} ?`;
          bindings.push(value);
        }
      }
    }

    if (sortField) {
      const desc = sortField.startsWith("-");
      const col = desc ? sortField.slice(1) : sortField;
      sql += ` ORDER BY "${col}" ${desc ? "DESC" : "ASC"}`;
    }

    const clampedLimit = Math.min(limit || 100, LIMITS.QUERY_ROWS);
    sql += ` LIMIT ${clampedLimit}`;

    try {
      const rows = this.db.exec(sql, ...bindings).toArray();
      return JSON.stringify({ pattern: patternName, entries: rows, count: rows.length }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Query failed: ${err.message}`);
    }
  }

  async mutate(patternName: string, operation: string, dataJson: string): Promise<string> {
    const result = this.executeMutate(patternName, operation, JSON.parse(dataJson));
    if (!result.error) this.broadcastChange([patternName]);
    return JSON.stringify(result, null, 2);
  }

  async batchMutate(operationsJson: string): Promise<string> {
    const operations = JSON.parse(operationsJson) as { pattern: string; operation: string; data: any }[];

    if (operations.length > LIMITS.BATCH_OPS) {
      return this.errorJson(`Batch too large: ${operations.length} operations exceeds limit of ${LIMITS.BATCH_OPS}`);
    }

    // Validate all operations before starting transaction
    for (const op of operations) {
      if (!this.patternExists(op.pattern)) {
        return this.errorJson(`Pattern "${op.pattern}" does not exist`);
      }
    }

    const results: any[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const op of operations) {
        const result = this.executeMutate(op.pattern, op.operation, op.data);
        if (result.error) {
          throw new Error(result.message);
        }
        results.push(result);
      }
    });

    const affectedPatterns = [...new Set(operations.map(op => op.pattern))];
    this.broadcastChange(affectedPatterns);
    return JSON.stringify({ batch: true, results, count: results.length }, null, 2);
  }

  async consumeUpload(token: string, content: string): Promise<string> {
    // Check for consumed token first (findAccessToken excludes consumed)
    const consumed = this.db.exec(
      `SELECT 1 FROM "_access_tokens" WHERE token = ? AND consumed_at IS NOT NULL`, token
    ).toArray();
    if (consumed.length > 0) return this.errorJson("Upload token has already been used");

    // Validate token with upload scope
    const accessToken = cred.findAccessToken(this.db, token);
    if (!accessToken) return this.errorJson("Invalid or expired upload token");
    if (!cred.scopeMatches(accessToken.scope, "upload")) return this.errorJson("Token does not have upload scope");

    // Parse upload constraints
    const constraints = accessToken.constraints ? JSON.parse(accessToken.constraints) : null;
    if (!constraints) return this.errorJson("Upload token missing constraints");

    // Check content size
    const contentBytes = new TextEncoder().encode(content).length;
    if (contentBytes > LIMITS.ENTRY_BYTES) {
      return this.errorJson(`Content too large: ${Math.round(contentBytes / 1024)}KB exceeds the 1MB limit`);
    }

    // Write content to target
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

      // Bump kernel version if applicable
      if (this.hasKernelVersion(constraints.target_pattern)) {
        try {
          this.db.exec(
            `UPDATE "${constraints.target_pattern}" SET version = version + 1 WHERE id = ?`,
            constraints.target_id
          );
        } catch { /* No version column — fine */ }
      }
    } catch (err: any) {
      return this.errorJson(`Upload write failed: ${err.message}`);
    }

    // Mark token consumed
    cred.consumeToken(this.db, accessToken.id);

    // Return the updated record
    const record = this.db.exec(
      `SELECT * FROM "${constraints.target_pattern}" WHERE id = ?`,
      constraints.target_id
    ).one();

    this.broadcastChange([constraints.target_pattern]);

    return JSON.stringify({
      uploaded: true,
      bytes: contentBytes,
      target: { pattern: constraints.target_pattern, id: constraints.target_id, facet: constraints.target_facet },
      mode: constraints.mode,
      entry: record,
    }, null, 2);
  }

  private kernelContext(): KernelContext {
    return {
      patternExists: (name) => this.patternExists(name),
      facetMeta: (pattern, facet) => {
        const rows = this.db.exec(
          "SELECT type FROM _fields WHERE object_name = ? AND name = ?", pattern, facet
        ).toArray() as any[];
        return rows.length ? { type: rows[0].type } : null;
      },
      entryExists: (pattern, id) => this.entryExists(pattern, id),
    };
  }

  private executeMutate(patternName: string, operation: string, data: any): any {
    if (!this.patternExists(patternName))
      return { error: true, message: `Pattern "${patternName}" does not exist` };

    // Apply kernel pattern rules (immutable fields, create hooks)
    const ruled = applyKernelRules(patternName, operation, data, this.kernelContext());
    if ('error' in ruled) return ruled;
    data = ruled;

    // Entry size guard
    if (operation === "create" || operation === "update") {
      const size = estimateRecordBytes(data);
      if (size > LIMITS.ENTRY_BYTES) {
        return { error: true, message: `Entry too large: ~${Math.round(size / 1024)}KB exceeds the 1MB limit` };
      }
    }

    try {
      switch (operation) {
        case "create": {
          const fields = Object.keys(data).filter((k) => !KERNEL_COLUMNS.has(k));
          const cols = fields.map((f) => `"${f}"`).join(", ");
          const placeholders = fields.map(() => "?").join(", ");
          const values = fields.map((f) => data[f]);

          this.db.exec(
            `INSERT INTO "${patternName}" (${cols}) VALUES (${placeholders})`,
            ...values
          );

          const row = this.db.exec(
            `SELECT * FROM "${patternName}" WHERE id = last_insert_rowid()`
          ).one();

          return { operation: "create", pattern: patternName, entry: row };
        }

        case "update": {
          if (!data.id) return { error: true, message: "id is required for update" };
          const kernelVersion = this.hasKernelVersion(patternName);

          // For kernel version tables: strip version from SET (it auto-increments).
          // For user version tables: include version in SET like any other field.
          const stripCols = ["id", "created_at", "archived_at"];
          if (kernelVersion) stripCols.push("version");
          const fields = Object.keys(data).filter((k) => !stripCols.includes(k));
          if (fields.length === 0) return { error: true, message: "No facets to update" };

          const sets = fields.map((f) => `"${f}" = ?`).join(", ");
          const values = fields.map((f) => data[f]);

          if (kernelVersion) {
            // Kernel version: auto-increment + optional optimistic lock
            let where = `id = ? AND archived_at IS NULL`;
            values.push(data.id);
            if (data.version != null) {
              where += ` AND version = ?`;
              values.push(data.version);
            }

            this.db.exec(
              `UPDATE "${patternName}" SET ${sets}, version = version + 1, updated_at = datetime('now') WHERE ${where}`,
              ...values
            );

            if (data.version != null) {
              const changes = this.db.exec("SELECT changes() as c").one() as { c: number };
              if (changes.c === 0) {
                return { error: true, message: `Version conflict: entry ${data.id} in "${patternName}" has been modified. Re-read and retry.` };
              }
            }
          } else {
            // No kernel version: simple update, version is a user field included in SET
            values.push(data.id);
            this.db.exec(
              `UPDATE "${patternName}" SET ${sets}, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
              ...values
            );
          }

          const row = this.db.exec(
            `SELECT * FROM "${patternName}" WHERE id = ?`,
            data.id
          ).one();

          return { operation: "update", pattern: patternName, entry: row };
        }

        case "archive": {
          if (!data.id) return { error: true, message: "id is required for archive" };
          this.db.exec(
            `UPDATE "${patternName}" SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            data.id
          );

          return { operation: "archive", pattern: patternName, id: data.id };
        }

        default:
          return { error: true, message: `Unknown operation: ${operation}. Use create, update, or archive.` };
      }
    } catch (err: any) {
      return { error: true, message: `Mutate failed: ${err.message}` };
    }
  }

  // === URI resolution ===

  async resolve(input: string): Promise<string> {
    const match = input.match(new RegExp(`^${URI_SCHEME}://(.+)$`));
    if (!match) return this.errorJson(`Invalid URI scheme. Expected ${URI_PREFIX} URI, got: ${input}`);

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

  // === Cross-object search ===

  async search(term: string, objectsJson: string, limit_: number): Promise<string> {
    const limit = Math.min(limit_ || 20, LIMITS.QUERY_ROWS);
    const targetObjects = objectsJson
      ? JSON.parse(objectsJson) as string[]
      : (this.db.exec("SELECT name FROM _objects ORDER BY name").toArray() as any[]).map((r: any) => r.name);

    const results: { pattern: string; entry: any; matched_facets: string[] }[] = [];

    for (const objName of targetObjects) {
      if (!this.patternExists(objName)) continue;

      // Get text fields from normalized schema
      const textFields = (this.db.exec(
        "SELECT name FROM _fields WHERE object_name = ? AND type = 'text' ORDER BY id",
        objName
      ).toArray() as any[]).map((r: any) => r.name as string);
      if (textFields.length === 0) continue;

      const conditions = textFields.map((f) => `"${f}" LIKE ?`).join(" OR ");
      const bindings = textFields.map(() => `%${term}%`);

      try {
        const rows = this.db.exec(
          `SELECT * FROM "${objName}" WHERE archived_at IS NULL AND (${conditions}) LIMIT ?`,
          ...bindings,
          limit
        ).toArray();

        for (const row of rows) {
          const matched = textFields.filter((f) => {
            const val = (row as any)[f];
            return typeof val === "string" && val.toLowerCase().includes(term.toLowerCase());
          });
          results.push({ pattern: objName, entry: row, matched_facets: matched });
        }
      } catch {
        // Skip objects that error (e.g., table doesn't exist yet)
      }

      if (results.length >= limit) break;
    }

    return JSON.stringify({
      term,
      results: results.slice(0, limit),
      count: Math.min(results.length, limit),
    }, null, 2);
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
    const content = returnDefault ? doc.default_content : (doc.content ?? doc.default_content);
    return JSON.stringify({
      slug: doc.slug,
      title: doc.title,
      content,
      is_default: doc.content === null || doc.content === doc.default_content,
      uri: uri(`_system/${doc.slug}`),
    }, null, 2);
  }

  // === Helpers ===

  private getCurrentIndex(): StoreIndex {
    const meta = this.db.exec("SELECT * FROM _meta WHERE id = 1").one() as any;
    const objects = this.db.exec("SELECT name, description FROM _objects ORDER BY name").toArray() as any[];
    const allFields = this.db.exec("SELECT * FROM _fields ORDER BY object_name, id").toArray() as any[];
    const conventions = this.db.exec("SELECT text FROM _conventions ORDER BY id").toArray() as any[];

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
      if (IMMUTABLE[f.object_name]?.fields.includes(f.name)) facet.readonly = true;
      facetsByPattern.get(f.object_name)!.push(facet);
    }

    return {
      version: meta.version,
      updated_at: meta.updated_at,
      patterns: objects.map((o: any) => ({
        name: o.name,
        description: o.description,
        facets: facetsByPattern.get(o.name) || [],
        entry_count: 0,
      })),
      conventions: conventions.map((c: any) => c.text),
      guidance: meta.guidance,
    };
  }

  private patternExists(name: string): boolean {
    return this.db.exec(
      "SELECT 1 FROM _objects WHERE name = ?", name
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

  // === HTTP I/O ===

  async getSharedEntry(pattern: string, id: number): Promise<string> {
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
    let data: Record<string, unknown>;

    if (input.facet_mapping) {
      const mapping = JSON.parse(input.facet_mapping) as Record<string, string>;
      let parsedBody: unknown = null;
      try { parsedBody = JSON.parse(body); } catch { /* not JSON */ }

      data = evaluateMapping(mapping, {
        body: parsedBody,
        rawBody: body,
        headers: JSON.parse(headersJson),
        query: JSON.parse(queryJson),
      });
    } else if (input.body_facet) {
      data = { [input.body_facet]: body };
    } else {
      data = { body };
    }

    const result = this.executeMutate(input.target_pattern, "create", data);
    if (!result.error) this.broadcastChange([input.target_pattern]);
    return JSON.stringify(result, null, 2);
  }

  // === Live updates via WebSocket (Hibernatable API) ===

  async fetch(request: Request): Promise<Response> {
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
