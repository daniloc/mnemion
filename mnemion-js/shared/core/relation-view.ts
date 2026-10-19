// Relation view — the pure, registry-driven shapes the web app renders for
// relations: the create form's relation fields, the `_relate` payload it posts,
// and an entry's relations grouped for display.
//
// @why Like format-palette.ts / view-palette.ts: pure data in, data out, ZERO
// imports, bundled into BOTH the worker suite (tested there) and the SPA. The
// React layer stays a thin renderer of these shapes, so no per-pattern code
// exists anywhere: which pickers a create form shows is read off the registry
// (mnemion://relations), and what it posts is exactly the Phase 2 `_relate` value.

/** An item of `mnemion://relations` (the Phase 2 read shape) — the fields read here. */
export interface RelationItem {
  name: string;
  inverse: string;
  source: string[];
  target: string[];
  cardinality: "one" | "many" | string;
  required?: boolean;
  derived?: boolean;
  [k: string]: unknown;
}

/** One relation picker on a create form. */
export interface RelationField {
  relation: string;
  target_patterns: string[];
  cardinality: "one" | "many";
  /** The relation name with hyphens as spaces ("belongs to"). */
  label: string;
}

/** The pickers a create form for `pattern` needs: one per REQUIRED, stored
 *  relation whose source lists the pattern explicitly, sorted by relation name.
 *  (A required relation's source is always an explicit list.) */
export function createRelationFields(pattern: string, relations: RelationItem[]): RelationField[] {
  return relations
    .filter((r) => r.required === true && !r.derived && Array.isArray(r.source) && r.source.includes(pattern))
    .map((r) => ({
      relation: r.name,
      target_patterns: [...r.target],
      cardinality: (r.cardinality === "one" ? "one" : "many") as "one" | "many",
      label: r.name.replace(/-/g, " "),
    }))
    .sort((a, b) => (a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0));
}

/** The `_relate` value for a create: strings pass through, arrays are deduplicated
 *  (and stay arrays), and empty values ("", null, undefined, []) are omitted. */
export function buildRelatePayload(values: Record<string, string | string[] | null | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [relation, v] of Object.entries(values)) {
    if (Array.isArray(v)) {
      const refs = [...new Set(v.filter((x) => typeof x === "string" && x !== ""))];
      if (refs.length) out[relation] = refs;
    } else if (typeof v === "string" && v !== "") {
      out[relation] = v;
    }
  }
  return out;
}

/** One linked item from resolve — the fields read here. */
export interface LinkedItem {
  pattern: string;
  id: number;
  uri: string;
  direction?: "out" | "in";
  relation?: string;
  label?: string;
  derived?: boolean;
  [k: string]: unknown;
}

/** One section of an entry's relations: the relation as read from this entry's
 *  side, its direction, whether it is derived, and the entries it reaches. */
export interface RelationGroup {
  relation: string;
  direction: "out" | "in";
  derived: boolean;
  items: { pattern: string; id: number; uri: string }[];
}

/** Group resolve's `linked` items by (reader-side relation, direction, derived):
 *  outgoing groups first, then by relation name; items keep resolve's order. */
export function entryRelationsView(linked: LinkedItem[] | undefined): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const l of linked ?? []) {
    const relation = l.relation ?? l.label;
    if (!relation) continue;
    const direction = l.direction === "in" ? "in" : "out";
    const derived = l.derived === true;
    const key = `${direction}|${relation}|${derived}`;
    const g = groups.get(key) ?? { relation, direction, derived, items: [] };
    g.items.push({ pattern: l.pattern, id: l.id, uri: l.uri });
    groups.set(key, g);
  }
  const rank = (d: string) => (d === "out" ? 0 : 1);
  return [...groups.values()].sort((a, b) =>
    rank(a.direction) - rank(b.direction) || (a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0) || Number(a.derived) - Number(b.derived));
}
