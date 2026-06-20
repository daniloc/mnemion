// Kernel columns — single canonical home for the auto-provided column set.
//
// Every pattern table carries these columns regardless of its declared facets
// (CLAUDE.md "Key conventions"). They cannot be defined via propose_change;
// created_by/updated_by are stamped from the session actor, never caller input.
//
// This is a dependency-free leaf (no imports) so it can be referenced from the
// schema/DDL layer, the data engine, the evolution engine, and the DO kernel
// without introducing an import cycle. Every call site that needs "the kernel
// columns" — or a named slice of them — references this module instead of
// re-listing the literals. Subsets are DERIVED from the master list (filter),
// never re-listed, so the slices can't drift from the source of truth.
//
// The ordering is canonical (matches the agent-facing schema display and the
// integrity check): id, version, then the timestamp + attribution columns.

/** The full kernel column set, in canonical order. The source of truth. */
export const KERNEL_COLUMNS = [
  "id",
  "version",
  "created_at",
  "updated_at",
  "archived_at",
  "created_by",
  "updated_by",
] as const;

/** Membership set over the full kernel column list. */
export const KERNEL_COLUMN_SET: ReadonlySet<string> = new Set(KERNEL_COLUMNS);

const without = (...drop: string[]): readonly string[] =>
  KERNEL_COLUMNS.filter((c) => !drop.includes(c));

// === Named subsets (all derived from KERNEL_COLUMNS above) ===

// Kernel columns a user MAY redefine as a facet. `version` alone: create_pattern's
// apply detects a user `version` facet and SKIPS the kernel default column, so a
// pattern can carry user-meaningful version semantics (e.g. semver on packages)
// instead of the kernel auto-increment. Every OTHER kernel column is added
// unconditionally — a same-named facet would be a duplicate column (a CREATE/ALTER
// DDL error), so they MUST be reserved. This set is the SINGLE home for "which
// kernel columns are overridable"; the facet reservation below derives from it
// (and create_pattern's skip references it), so the two can't disagree about which
// column is special.
export const USER_OVERRIDABLE_KERNEL_COLUMNS: ReadonlySet<string> = new Set(["version"]);

// Facet-name reservation (evolution.ts validateFacets — the chokepoint for BOTH
// create_pattern and add_facet): a proposed facet may not be named after a kernel
// column it would COLLIDE with — i.e. every kernel column EXCEPT the user-overridable
// ones. DERIVED from the two sets above, never hand-listed, so it can't under-cover.
// The historical bug was a hand-narrowed subset that omitted created_by/updated_by
// (which are NOT overridable → must be reserved) AND version (which IS). Splitting
// "overridable" out as its own declaration fixes both: reserved ∪ overridable =
// KERNEL_COLUMNS, and adding a kernel column auto-reserves it unless explicitly
// declared overridable. The `facet-kernel-collision totality` oracle iterates THIS
// set (each rejected) and the complement (each overridable allowed) — both halves
// checked, so the partition can't silently drift.
export const FACET_RESERVED_COLUMNS: ReadonlySet<string> = new Set(
  KERNEL_COLUMNS.filter((c) => !USER_OVERRIDABLE_KERNEL_COLUMNS.has(c)),
);

// Columns excluded from the caller-supplied field set on CREATE (data.ts): id is
// autoincrement, the timestamps + attribution are system-managed. `version` is
// not in this set because callers never supply it on create either (it's the
// kernel auto-increment), and excluding it here would be redundant — preserved as
// master-minus-version.
export const CALLER_EXCLUDED_ON_CREATE: ReadonlySet<string> = new Set(
  without("version"),
);

// Columns skipped during facet validation / shown as the kernel column list in
// the agent-facing schema (data.ts SKIP_KEYS + hive.ts schema display): every
// auto-provided structural column except the attribution columns, which are not
// surfaced as schema and were already stripped upstream by executeMutate.
export const STRUCTURAL_KERNEL_COLUMNS: readonly string[] = without(
  "created_by",
  "updated_by",
);
