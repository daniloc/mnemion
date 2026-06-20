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

export type KernelColumn = (typeof KERNEL_COLUMNS)[number];

/** Membership set over the full kernel column list. */
export const KERNEL_COLUMN_SET: ReadonlySet<string> = new Set(KERNEL_COLUMNS);

const without = (...drop: string[]): readonly string[] =>
  KERNEL_COLUMNS.filter((c) => !drop.includes(c));

// === Named subsets (all derived from KERNEL_COLUMNS above) ===

// NOTE on facet-name reservation: a proposed facet may not collide with a kernel
// column (it would shadow the auto-provided column on the same table). That guard
// (evolution.ts validateFacets, the chokepoint for create_pattern + add_facet)
// reserves the FULL `KERNEL_COLUMN_SET` directly — there is deliberately NO
// narrowed "facet-reserved" subset here. A subset is the bug: it once omitted
// version/created_by/updated_by, so those three were nameable as facets. With the
// reservation == the kernel column set, adding a kernel column auto-reserves it,
// and `facet-kernel-collision totality` (evolution.test) asserts every kernel
// column is rejected — the under-coverage is impossible to reintroduce.

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
