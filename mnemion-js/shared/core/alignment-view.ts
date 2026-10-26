// Alignment view — the weekly review's "unaligned" read (project-docs/relations.md,
// decision 2 and open question 5): which projects serve no goal, and which goals
// no project serves. Derived at read time from `serves` links; nothing stored.
//
// @why Like relation-view.ts: pure data in, data out, type-only imports, bundled into
// BOTH the worker suite (tested there) and the SPA. The ends are read off the
// relation registry (the relation's own source/target lists), so only the
// relation's name is vocabulary here; the Swift client's Portfolio mirrors it.

import type { RelationItem } from "./relation-view";

/** The relation whose absence makes an entry unaligned. */
export const ALIGNMENT_RELATION = "serves";

/** An entry reference. */
export interface EntryRef { pattern: string; id: number }

/** One `_links` row — the fields read here. */
export interface LinkRow {
  source_pattern: string;
  source_id: number;
  target_pattern: string;
  target_id: number;
  label: string;
  [k: string]: unknown;
}

export interface AlignmentView {
  relation: string;
  sources: string[];
  targets: string[];
  /** Active source entries holding no link of the relation (projects serving no goal). */
  unaligned: EntryRef[];
  /** Active target entries no active source links to (goals nothing serves). */
  unserved: EntryRef[];
}

/** The stored alignment relation with explicit ends, or null when the hive
 *  declares none (the view then doesn't apply). A `*` end has no "every entry of
 *  this pattern" to judge, so it doesn't qualify. */
export function alignmentRelation(relations: RelationItem[] | undefined): RelationItem | null {
  const r = (relations ?? []).find((x) => x.name === ALIGNMENT_RELATION);
  if (!r || r.derived) return null;
  const explicit = (l: unknown) => Array.isArray(l) && l.length > 0 && !l.includes("*");
  return explicit(r.source) && explicit(r.target) ? r : null;
}

/** Judge every active source and target entry against the relation's active
 *  links. A link counts only when both its ends are in the given (active) sets,
 *  so a goal served only by an archived project is still unserved. Entries keep
 *  the order they were given in. */
export function alignmentView(relation: Pick<RelationItem, "name" | "source" | "target">, sources: EntryRef[], targets: EntryRef[], links: LinkRow[]): AlignmentView {
  const key = (p: string, id: number) => `${p}/${id}`;
  const activeSources = new Set(sources.map((e) => key(e.pattern, e.id)));
  const activeTargets = new Set(targets.map((e) => key(e.pattern, e.id)));
  const serving = new Set<string>();
  const served = new Set<string>();
  for (const l of links) {
    if (l.label !== relation.name) continue;
    const s = key(l.source_pattern, Number(l.source_id));
    const t = key(l.target_pattern, Number(l.target_id));
    if (!activeSources.has(s) || !activeTargets.has(t)) continue;
    serving.add(s);
    served.add(t);
  }
  return {
    relation: relation.name,
    sources: [...relation.source],
    targets: [...relation.target],
    unaligned: sources.filter((e) => !serving.has(key(e.pattern, e.id))),
    unserved: targets.filter((e) => !served.has(key(e.pattern, e.id))),
  };
}
