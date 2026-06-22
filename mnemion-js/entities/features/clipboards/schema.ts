// clipboards/schema.ts — the clipboards feature's PATTERN STRUCTURE, as PURE DATA:
// the _clipboards kernel-pattern declaration (DDL + facet metadata + the
// one-clipboard-per-pattern partial unique index). Same discipline as
// documents/pages schema.ts — pure data + TYPES only — so composePatterns folds it
// into schema.ts's KERNEL_TABLES verbatim and verifyFieldsIntegrity sees no drift.
//
// A _clipboards row is a JOB-DISPATCH form: it binds a reusable, validated form to a
// target user pattern. The JSON columns (fields / unique_on / cross_field / completion)
// are the form's contract; they're validated at definition time by the sibling
// hooks.ts and enforced per-submission at the mutate chokepoint (entities/Hive/data.ts).
// Progress against `completion` is DERIVED from the target pattern's entries, never
// stored here (entities/Hive/completion.ts).
//
// No feature migration: every column lives in the base DDL (a fresh pattern, no prior
// _clipboards ALTER ever lived in schema.ts's pile). The pre-mutation DEFINITION hooks
// live in the sibling hooks.ts and compose into kernel.ts's ON_CREATE/ON_WRITE.

import type { FeaturePattern } from "../feature";

export const patterns: FeaturePattern[] = [
  {
    name: "_clipboards",
    description: `Clipboards — validated job-dispatch forms for repetitive data-gathering. A clipboard binds a reusable form to a target dataset pattern: each create on that pattern becomes a SUBMISSION, deterministically validated (regex, numeric range, string length, cross-field comparisons, composite uniqueness) with ALL violations reported at once, and counted toward a composable numeric completion contract ("50 rows", "≥1 from each of 10 sources", "fresh within 7 days"). The submission response carries live progress, so a fanout of agents each learns the running tally and when the job is done. Define one to dispatch a bounded, validated collection job across one or many agents.`,
    doctrine: `Create a _clipboards row to dispatch a validated collection job. target_pattern must be an existing DATASET-class user pattern (so field types are coerced). fields is a JSON array of per-facet rules [{facet, required?, pattern?, min?, max?, min_length?, max_length?}]; unique_on is a JSON array of facet-name arrays for composite dedupe-on-fill; cross_field is a JSON array of [{left_facet, op, right_facet|literal}]; completion is {require: "all"|"any", conditions: [{metric, op, value, ...params}]} over the metrics count / distinct_sources / sources_covered / count_per_source / days_since_last / distinct_periods. To FILL the clipboard, mutate-create into target_pattern: a malformed row is rejected with a per-field violations list; an accepted row returns progress {complete, conditions:[{metric, current, target, satisfied}]}. One clipboard per pattern. Patch is rejected on a clipboard-bound pattern — edit via mutate update so the whole row re-validates.`,
    ddl: `CREATE TABLE IF NOT EXISTS "_clipboards" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "target_pattern" TEXT NOT NULL,
      "description" TEXT,
      "fields" TEXT,
      "unique_on" TEXT,
      "cross_field" TEXT,
      "completion" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      // One active clipboard per target pattern — the enforcement seam (clipboardFor)
      // assumes LIMIT 1, and the definition hook also checks this; the index is the
      // fail-closed floor.
      `CREATE UNIQUE INDEX IF NOT EXISTS "_clipboards_target_active" ON "_clipboards" ("target_pattern") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "name", type: "text", required: true },
      { name: "target_pattern", type: "text", required: true },
      { name: "description", type: "text", required: false },
      { name: "fields", type: "text", required: false },
      { name: "unique_on", type: "text", required: false },
      { name: "cross_field", type: "text", required: false },
      { name: "completion", type: "text", required: false },
    ],
  },
];
