// completion.ts — the CLIPBOARD COMPLETION engine: derive a job's progress from the
// submission log at read time.
//
// @why One declarative home for "what numeric success conditions exist." A clipboard's
// completion contract is a conjunction/disjunction of `metric op threshold` predicates;
// COMPLETION_METRICS is the table keyed by metric name, each computing a number from a
// narrow aggregate over the target pattern's entries. Per data-is-destiny, NOTHING is
// stored — `count`, `sources_covered`, `days_since_last` … are all SQL-derived every
// call (mirrors _fragment_access_log COUNT-promotion / _maintenance_passes days-since).
// The definition hook (clipboards/hooks.ts) DERIVES its "known metric" set and per-metric
// required/facet params from this registry; the totality oracle asserts the keysets match,
// so a metric that can be stored but isn't computed (fail-open) fails the suite.
//
// Near-leaf: imports only quoteIdent (the SQL-identifier chokepoint). It takes `db` as a
// parameter — no import of data.ts/hive.ts — so there's no cycle. Identifiers (table,
// source facet) are interpolated via quoteIdent; thresholds/required values are bound.

import { quoteIdent } from "../../shared/core/sql";
import { compareValues } from "./constraints";

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

/** What a metric needs to read the submission log: the raw db + the target table
 *  (= the pattern name; user patterns are `CREATE TABLE "<name>"`). */
export interface MetricContext {
  db: DB;
  table: string;
}

/** A condition is `{ metric, op, value, ...params }`. params (source_facet, required,
 *  period_days) ride alongside and are read by the metric's compute fn. */
export type Condition = Record<string, unknown> & { metric: string; op: string; value: number };

interface MetricDef {
  /** Compute the metric's current numeric value from the submission log. */
  compute: (mctx: MetricContext, cond: Condition) => number;
  /** Param keys that name a facet on the target pattern — the definition hook
   *  validates each exists. */
  facetParams: string[];
  /** Param keys that must be present on the condition (the definition hook checks). */
  required: string[];
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const placeholders = (n: number): string => Array(n).fill("?").join(",");

export const COMPLETION_METRICS: Record<string, MetricDef> = {
  // Total valid submissions. "collect this data x times" → count >= x.
  count: {
    facetParams: [],
    required: [],
    compute: (mctx) =>
      Number(
        mctx.db
          .exec(`SELECT COUNT(*) AS n FROM ${quoteIdent(mctx.table)} WHERE archived_at IS NULL`)
          .one().n,
      ),
  },

  // How many DISTINCT source values have been seen. distinct_sources >= y.
  distinct_sources: {
    facetParams: ["source_facet"],
    required: ["source_facet"],
    compute: (mctx, cond) => {
      const sf = quoteIdent(String(cond.source_facet));
      return Number(
        mctx.db
          .exec(
            `SELECT COUNT(DISTINCT ${sf}) AS n FROM ${quoteIdent(mctx.table)} WHERE archived_at IS NULL AND ${sf} IS NOT NULL`,
          )
          .one().n,
      );
    },
  },

  // How many of a REQUIRED source set are covered (≥1 submission each).
  // "from each of these y sources" → sources_covered >= y.
  sources_covered: {
    facetParams: ["source_facet"],
    required: ["source_facet", "required"],
    compute: (mctx, cond) => {
      const required = asArray(cond.required);
      if (!required.length) return 0;
      const sf = quoteIdent(String(cond.source_facet));
      return Number(
        mctx.db
          .exec(
            `SELECT COUNT(DISTINCT ${sf}) AS n FROM ${quoteIdent(mctx.table)} WHERE archived_at IS NULL AND ${sf} IN (${placeholders(required.length)})`,
            ...required,
          )
          .one().n,
      );
    },
  },

  // The WORST-covered required source's count (0 if a required source is absent).
  // "at least k submissions from EVERY source" → count_per_source >= k.
  count_per_source: {
    facetParams: ["source_facet"],
    required: ["source_facet", "required"],
    compute: (mctx, cond) => {
      const required = asArray(cond.required);
      if (!required.length) return 0;
      const sf = quoteIdent(String(cond.source_facet));
      const rows = mctx.db
        .exec(
          `SELECT ${sf} AS s, COUNT(*) AS n FROM ${quoteIdent(mctx.table)} WHERE archived_at IS NULL AND ${sf} IN (${placeholders(required.length)}) GROUP BY ${sf}`,
          ...required,
        )
        .toArray();
      const counts = new Map<string, number>(rows.map((r: any) => [String(r.s), Number(r.n)]));
      return Math.min(...required.map((s) => counts.get(s) ?? 0));
    },
  },

  // Days since the most recent submission. Freshness/recurrence: days_since_last <= N
  // is "healthy"; it flips to UNSATISFIED (→ overdue) when collection goes stale. No
  // rows → a large number (never collected = maximally overdue).
  days_since_last: {
    facetParams: [],
    required: [],
    compute: (mctx) => {
      const d = mctx.db
        .exec(
          `SELECT julianday('now') - julianday(MAX(created_at)) AS d FROM ${quoteIdent(mctx.table)} WHERE archived_at IS NULL`,
        )
        .one().d;
      return d == null ? Number.MAX_SAFE_INTEGER : Number(d);
    },
  },

  // Distinct time-buckets of `period_days` that have ≥1 submission. "collect weekly
  // for n weeks" → distinct_periods >= n (with period_days: 7).
  distinct_periods: {
    facetParams: [],
    required: ["period_days"],
    compute: (mctx, cond) => {
      const period = Number(cond.period_days) || 1;
      return Number(
        mctx.db
          .exec(
            `SELECT COUNT(DISTINCT CAST(julianday(created_at) / ? AS INTEGER)) AS n FROM ${quoteIdent(mctx.table)} WHERE archived_at IS NULL`,
            period,
          )
          .one().n,
      );
    },
  },
};

/** The canonical metric vocabulary — one home, derived by the definition hook + the
 *  totality oracle. */
export const COMPLETION_METRIC_KEYS: string[] = Object.keys(COMPLETION_METRICS);

/** A metric whose unsatisfied state means "overdue" (collection has gone stale),
 *  distinct from "not yet reached a quota." */
const FRESHNESS_METRICS = new Set(["days_since_last"]);

export interface ConditionProgress {
  metric: string;
  current: number;
  op: string;
  target: number;
  satisfied: boolean;
}

export interface CompletionProgress {
  complete: boolean;
  overdue: boolean;
  require: "all" | "any";
  conditions: ConditionProgress[];
}

export interface CompletionSpec {
  require?: "all" | "any";
  conditions?: Condition[];
}

/** Evaluate a clipboard's completion contract against the live submission log.
 *  Pure-derived: every metric is recomputed here, nothing is cached or stored. */
export function evaluateCompletion(mctx: MetricContext, spec: CompletionSpec | null | undefined): CompletionProgress {
  const require: "all" | "any" = spec?.require === "any" ? "any" : "all";
  const conditions = Array.isArray(spec?.conditions) ? spec!.conditions! : [];

  const reports: ConditionProgress[] = conditions.map((cond) => {
    const def = COMPLETION_METRICS[cond.metric];
    const current = def ? def.compute(mctx, cond) : Number.NaN;
    const target = Number(cond.value);
    const satisfied = def != null && compareValues(cond.op, current, target);
    return { metric: cond.metric, current, op: cond.op, target, satisfied };
  });

  // No conditions → an open-ended clipboard (always "complete" in the trivial sense;
  // it's a validated form with no quota). `any` over an empty set is false, so guard.
  const complete = reports.length === 0
    ? true
    : require === "any"
      ? reports.some((r) => r.satisfied)
      : reports.every((r) => r.satisfied);

  const overdue = reports.some((r) => !r.satisfied && FRESHNESS_METRICS.has(r.metric));

  return { complete, overdue, require, conditions: reports };
}
