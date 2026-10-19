// Facet references — everything outside a pattern's DDL that names one of its
// facets by name.
//
// @why drop_facet refuses while anything still names the facet (owner decision
// O3): no cascade, no dangling reference. The kinds of reference are a declared
// table keyed by kind, so the drop, its preview and its apply re-check all read
// the same finders, and a new kind of facet-naming config is one row here.
// Matching is by exact name (a JSON string value or key equal to the facet, a
// filter's field, a {{facet}} placeholder): conservative, so a coincidental
// value blocks a drop rather than a real reference slipping through.

import { quoteIdent } from "../../shared/core/sql";

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

export interface FacetReference { kind: string; reason: string; [k: string]: unknown }

const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** Does any string value or object key in `v` equal `facet`? */
function names(v: unknown, facet: string): boolean {
  if (typeof v === "string") return v === facet;
  if (Array.isArray(v)) return v.some((x) => names(x, facet));
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k === facet || names(x, facet));
  return false;
}

const FILTER_FIELD_RE = /^([a-zA-Z_][\w-]*)(\|=|=|!=|>=|<=|>|<|~)/;

function rows(db: DB, sql: string, ...params: unknown[]): any[] {
  try { return db.exec(sql, ...params).toArray() as any[]; } catch { return []; }
}

/** Each kind of reference → its finder over (pattern, facet). */
export const FACET_REFERENCE_FINDERS: Record<string, (db: DB, pattern: string, facet: string) => FacetReference[]> = {
  memory_policy(db, pattern, facet) {
    const policy = parse(rows(db, `SELECT memory_policy FROM _objects WHERE name = ?`, pattern)[0]?.memory_policy) as any;
    return Array.isArray(policy?.exclusive_facets) && policy.exclusive_facets.includes(facet)
      ? [{ kind: "memory_policy", pattern, reason: `the memory policy of "${pattern}" lists "${facet}" in exclusive_facets — set a policy without it first` }]
      : [];
  },
  view(db, pattern, facet) {
    return rows(db, `SELECT id, name, config FROM "_views" WHERE pattern = ? AND archived_at IS NULL ORDER BY id`, pattern)
      .filter((v) => names(parse(v.config), facet))
      .map((v) => ({ kind: "view", id: v.id, name: v.name, reason: `view "${v.name}" (_views/${v.id}) names "${facet}" in its config — edit or archive it first` }));
  },
  publication(db, pattern, facet) {
    return rows(db, `SELECT id, path, filters, facets, sort, template FROM "_publications" WHERE source_pattern = ? AND archived_at IS NULL ORDER BY id`, pattern)
      .filter((p) => {
        const filters = parse(p.filters);
        const inFilters = Array.isArray(filters) && filters.some((f) => typeof f === "string" && f.match(FILTER_FIELD_RE)?.[1] === facet);
        const inFacets = typeof p.facets === "string" && p.facets.split(",").map((f: string) => f.trim()).includes(facet);
        const inSort = typeof p.sort === "string" && p.sort.replace(/^-/, "") === facet;
        const inTemplate = typeof p.template === "string" && p.template.includes(`{{${facet}}}`);
        return inFilters || inFacets || inSort || inTemplate;
      })
      .map((p) => ({ kind: "publication", id: p.id, path: p.path, reason: `publication "/p/${p.path}" (_publications/${p.id}) names "${facet}" (filters, facets, sort or template) — edit or archive it first` }));
  },
  input(db, pattern, facet) {
    return rows(db, `SELECT id, path, body_facet, facet_mapping FROM "_inputs" WHERE target_pattern = ? AND archived_at IS NULL ORDER BY id`, pattern)
      .filter((i) => {
        const mapping = parse(i.facet_mapping);
        return i.body_facet === facet || (!!mapping && typeof mapping === "object" && !Array.isArray(mapping) && Object.prototype.hasOwnProperty.call(mapping, facet));
      })
      .map((i) => ({ kind: "input", id: i.id, path: i.path, reason: `ingress endpoint "/i/${i.path}" (_inputs/${i.id}) writes "${facet}" (body_facet or facet_mapping) — edit or archive it first` }));
  },
  upload_token(db, pattern, facet) {
    // A live (unarchived, unconsumed, unexpired) upload token still targets the
    // facet; the token value is never echoed. Expiry is compared as a DATE, the
    // way credentials.ts judges it — never as text, where "YYYY-MM-DD HH:MM:SS"
    // sorts before an ISO "…T…" now and a live token would look expired.
    return rows(db, `SELECT id, constraints, expires_at FROM "_access_tokens"
        WHERE (scope = 'upload' OR scope LIKE 'upload:%') AND archived_at IS NULL AND consumed_at IS NULL ORDER BY id`)
      .filter((t) => !(t.expires_at && new Date(t.expires_at) < new Date()))
      .filter((t) => {
        const c = parse(t.constraints) as any;
        return c?.target_pattern === pattern && c?.target_facet === facet;
      })
      .map((t) => ({ kind: "upload_token", id: t.id, reason: `upload token _access_tokens/${t.id} targets "${facet}" — let it be consumed or archive it first` }));
  },
  clipboard(db, pattern, facet) {
    return rows(db, `SELECT id, name, fields, unique_on, cross_field, completion FROM "_clipboards" WHERE target_pattern = ? AND archived_at IS NULL ORDER BY id`, pattern)
      .filter((c) => ["fields", "unique_on", "cross_field", "completion"].some((col) => names(parse(c[col]), facet)))
      .map((c) => ({ kind: "clipboard", id: c.id, name: c.name, reason: `clipboard "${c.name}" (_clipboards/${c.id}) has a rule naming "${facet}" — edit or archive it first` }));
  },
};

/** Every reference to `pattern.facet`, all kinds. */
export function facetReferences(db: DB, pattern: string, facet: string): FacetReference[] {
  return Object.values(FACET_REFERENCE_FINDERS).flatMap((find) => find(db, pattern, facet));
}

/** Rows (active and archived) whose value for the facet is non-NULL — the data a
 *  drop would lose. */
export function nonNullValues(db: DB, pattern: string, facet: string): number {
  try {
    return (db.exec(`SELECT COUNT(*) AS n FROM ${quoteIdent(pattern)} WHERE ${quoteIdent(facet)} IS NOT NULL`).one() as { n: number }).n;
  } catch { return 0; }
}
