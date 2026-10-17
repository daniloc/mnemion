// Relations registry — the one home of edge vocabulary and its enforcement.
//
// A `_links` row's label names a declared relation (a `_relations` row), never
// free text. This module owns everything that knows what a label MEANS: the
// behavior palette, the kernel defaults, relation lookup (inverse names
// included), pattern admission, the link write checks the `_links` kernel hooks
// call, supersession lookups by behavior, reader-side link naming, the boot
// sweep + legacy-label migration, and the vocabulary rules the
// declare/amend/retire_relation change types delegate to.
//
// @why Behavior attaches to a relation by DECLARATION. Every other module asks
// "which relations carry behavior X" here instead of comparing a label to a
// literal, so this is the only worker file allowed to filter `_links` on a label
// or compare a label to a relation name (the `behavior by declaration`
// invariant; relations.test scans the tree for it). Pure functions over an
// injected db, like data.ts / evolution.ts — HiveDO wires, never decides.

import { uri } from "../../shared/core/constants";
import { quoteIdent } from "../../shared/core/sql";
import { isKernelPattern } from "./policy";

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

/** What the link checks and change types need: the db plus the two existence
 *  probes the engine already exposes (active pattern, active entry). */
export interface RelationsContext {
  db: DB;
  patternExists(name: string): boolean;
  entryExists(pattern: string, id: number): boolean;
}

// === Behavior palette ===
//
// A relation declares behaviors from this fixed table; the engine performs each
// one at a single place. Agents never author code here — declarative data read
// against a fixed palette, like view specs. A behavior joins the palette only
// with its enforcement AND an enforcement test (relations.test `palette
// totality` maps every key to the describe that proves it), so the schema never
// promises what the engine doesn't do.

export const BEHAVIOR_PALETTE = {
  supersession: {
    performs: "The target has been replaced by the source as current truth: prime demotes it ×0.3, resolve and the stale view annotate superseded_by, publications exclude it unless opted in.",
    where: "supersededBy / supersededAmong (this module), read by prime, getEntry, the stale view and publications.",
  },
  acyclic: {
    performs: "A link that would close a cycle across this relation (a self-link included) is refused.",
    where: "checkLinkWrite → closesCycle (recursive CTE) at the `_links` write chokepoint, on create and unarchive.",
  },
} as const;

export type Behavior = keyof typeof BEHAVIOR_PALETTE;

function isBehavior(b: unknown): b is Behavior {
  return typeof b === "string" && Object.prototype.hasOwnProperty.call(BEHAVIOR_PALETTE, b);
}

/** Parts of the design the engine does not perform yet (Phase 2). Declaring one
 *  is refused by name rather than stored as a promise the engine can't keep. */
const NOT_YET_SUPPORTED = {
  behaviors: new Set(["containment"]),
  fields: ["required", "chain"] as const,
};

// === Vocabulary constants ===

/** A relation end that admits any user pattern (and, as a target, the
 *  KERNEL_LINK_TARGETS). Stored as `["*"]`. */
export const ANY = "*";

/** The only kernel patterns a link may TARGET: where cited material lives
 *  (documents, fetched web snapshots). No kernel pattern is ever a SOURCE, and
 *  credentials, the roster and config tables are never targets — links connect
 *  memories, and a control-plane endpoint would be woven into recall
 *  (followLinks) and treated as memory by a supersession link. */
export const KERNEL_LINK_TARGETS: ReadonlySet<string> = new Set(["_documents", "_web_cache"]);

/** The honest generic link: asserts nothing structural. Legacy unlabeled links
 *  become this relation. */
const GENERIC_RELATION = "references";

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CARDINALITIES = ["one", "many"] as const;
type Cardinality = typeof CARDINALITIES[number];
/** The declaration quality bar: a description says what the relation asserts,
 *  when to prefer it over its nearest neighbour, and gives an example. */
const DESCRIPTION_MIN_CHARS = 120;
/** Letters/digits that must remain once the name and inverse are removed — less
 *  than this and the description merely restates the handle. */
const DESCRIPTION_MIN_SUBSTANCE = 40;

// === Kernel defaults ===
//
// Seeded with kernel = 1, source = target = ["*"], cardinality "many". Code owns
// their inverse, behaviors and description: boot refreshes them, the way
// _system_docs defaults are refreshed, and the change types refuse to amend or
// retire them.

interface KernelRelation { name: string; inverse: string; behaviors: Behavior[]; description: string }

export const KERNEL_RELATIONS: readonly KernelRelation[] = [
  {
    name: "supersedes", inverse: "superseded-by", behaviors: ["supersession", "acyclic"],
    description: "The source replaces the target as current truth. The target is kept and demoted, never hidden: prime ranks it at 0.3× and every read annotates it with superseded_by. Use it when a newer entry corrects or replaces an older one; use references when the newer entry only cites it. Example: decisions/12 supersedes decisions/4.",
  },
  {
    name: "references", inverse: "referenced-by", behaviors: [],
    description: "The source cites or draws on the target. This is the honest generic link: it asserts nothing structural (no ordering, provenance or hierarchy), so it never changes recall or lifecycle. Use it when no more specific relation fits. Example: notes/7 references papers/3.",
  },
  {
    name: "depends-on", inverse: "required-by", behaviors: ["acyclic"],
    description: "The source cannot be completed before the target. Dependencies may never loop back on themselves. Use it for ordering between pieces of work; use part-of for hierarchy and references for a mere mention. Example: tasks/8 depends-on tasks/5.",
  },
  {
    name: "derived-from", inverse: "source-of", behaviors: ["acyclic"],
    description: "The source was made from the target: provenance. An idea triaged into a task, or a draft distilled into an axiom. Nothing is its own ancestor. Use it rather than references when the source would not exist without the target. Example: tasks/14 derived-from inbox/42.",
  },
  {
    name: "part-of", inverse: "has-part", behaviors: ["acyclic"],
    description: "Generic hierarchy: the source is a component or member of the target, for hives without a domain-specific containment relation. Nothing contains itself. Use it rather than references when the source only makes sense inside the target. Example: chapters/3 part-of books/1.",
  },
];

// === Relation rows ===

/** An active relation, parsed. This is also the read shape of the index's
 *  `relations` key and of `mnemion://relations` (arrays parsed, flags boolean). */
export interface Relation {
  name: string;
  inverse: string;
  description: string;
  source: string[];
  target: string[];
  cardinality: Cardinality;
  behaviors: string[];
  kernel: boolean;
  legacy: boolean;
}

/** A JSON-array TEXT column. A corrupt value parses to [] — an end that admits
 *  nothing and a relation with no behaviors (fail closed). */
function parseList(v: unknown): string[] {
  try {
    const p = JSON.parse(String(v));
    return Array.isArray(p) ? p.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function toRelation(r: any): Relation {
  return {
    name: r.name,
    inverse: r.inverse,
    description: r.description,
    source: parseList(r.source),
    target: parseList(r.target),
    cardinality: r.cardinality === "one" ? "one" : "many",
    behaviors: parseList(r.behaviors),
    kernel: !!r.kernel,
    legacy: !!r.legacy,
  };
}

/** Every active relation, kernel defaults first. Empty before the table exists. */
export function activeRelations(db: DB): Relation[] {
  try {
    return (db.exec(
      `SELECT name, inverse, description, source, target, cardinality, behaviors, kernel, legacy
       FROM "_relations" WHERE archived_at IS NULL ORDER BY kernel DESC, name`,
    ).toArray() as any[]).map(toRelation);
  } catch {
    return [];
  }
}

/** The read surface: index `relations` and `mnemion://relations`. */
export const listRelations = activeRelations;

/** A written label → the relation it names. An inverse name resolves to its
 *  relation with `inverted` set: the endpoints swap and the canonical name is
 *  stored. */
function resolveLabel(rels: Relation[], label: unknown): { relation: Relation; inverted: boolean } | null {
  if (typeof label !== "string" || !label.trim()) return null;
  const byName = rels.find((r) => r.name === label);
  if (byName) return { relation: byName, inverted: false };
  const byInverse = rels.find((r) => r.inverse === label);
  return byInverse ? { relation: byInverse, inverted: true } : null;
}

/** Active relations carrying `behavior` — how every reader finds supersession. */
export function relationsWith(db: DB, behavior: Behavior): string[] {
  return activeRelations(db).filter((r) => r.behaviors.includes(behavior)).map((r) => r.name);
}

// === Pattern admission ===

/** May `pattern` stand at this end of ANY link? User patterns always; kernel
 *  patterns never as a source, and only KERNEL_LINK_TARGETS as a target. */
function endpointAdmissible(pattern: string, end: "source" | "target"): boolean {
  if (!isKernelPattern(pattern)) return true;
  return end === "target" && KERNEL_LINK_TARGETS.has(pattern);
}

/** Does a relation end (`["*"]` or a pattern list) admit `pattern`? */
function admits(list: string[], pattern: string, end: "source" | "target"): boolean {
  if (!endpointAdmissible(pattern, end)) return false;
  return list.includes(ANY) || list.includes(pattern);
}

/** Canonical names of the active relations declared for a (source, target)
 *  pattern pair — what an undeclared-label refusal offers. */
function availableFor(rels: Relation[], sourcePattern: string, targetPattern: string): string[] {
  return rels
    .filter((r) => admits(r.source, sourcePattern, "source") && admits(r.target, targetPattern, "target"))
    .map((r) => r.name);
}

// === Entry references ===

const ENTRY_REF_RE = /^([^/\s]+)\/(\d+)$/;

/** The `"pattern/id"` shorthand, strictly: exactly one slash and an integer id. */
export function parseEntryRef(raw: unknown): { pattern: string; id: number } | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(ENTRY_REF_RE);
  return m ? { pattern: m[1], id: Number(m[2]) } : null;
}

const ref = (pattern: string, id: number) => `${pattern}/${id}`;

// === The link write chokepoint ===

export interface LinkEnds { source_pattern: string; source_id: number; target_pattern: string; target_id: number }
export interface LinkRefusal { error: true; message: string; available_relations?: string[]; labels?: string[] }
type LinkCheck = (LinkEnds & { label: string }) | LinkRefusal;

function refuse(message: string, extra: Partial<LinkRefusal> = {}): LinkRefusal {
  return { error: true, message, ...extra };
}

function undeclared(rels: Relation[], ends: LinkEnds, label: unknown): LinkRefusal {
  const available = availableFor(rels, ends.source_pattern, ends.target_pattern);
  const written = typeof label === "string" && label.trim() ? `"${label}" is not a declared relation` : "A link needs a label naming a declared relation";
  const offer = available.length
    ? `Relations declared from "${ends.source_pattern}" to "${ends.target_pattern}": ${available.join(", ")} (each relation's inverse name is accepted too, and stored in canonical direction).`
    : `No relation is declared from "${ends.source_pattern}" to "${ends.target_pattern}".`;
  return refuse(
    `${written}. ${offer} Read ${uri("relations")} for what each one asserts, or declare a new relation with propose_change type "declare_relation" (name, inverse, a detailed description, source and target patterns).`,
    { available_relations: available },
  );
}

/**
 * Would `source -[label]-> target` close a cycle? True when the source is
 * reachable from the target across the relation's active links (a self-link is
 * the zero-length case). UNION (not UNION ALL) dedupes visited nodes, so the
 * walk terminates even over a graph that already holds a cycle. `excludeId`
 * leaves one link out of the walk (the row being revalidated or judged).
 */
function closesCycle(db: DB, label: string, link: LinkEnds, excludeId: number): boolean {
  const rows = db.exec(
    `WITH RECURSIVE reach(p, i) AS (
       SELECT ?, ?
       UNION
       SELECT l.target_pattern, l.target_id FROM "_links" l JOIN reach r
         ON l.source_pattern = r.p AND l.source_id = r.i
       WHERE l.label = ? AND l.archived_at IS NULL AND l.id != ?
     )
     SELECT 1 FROM reach WHERE p = ? AND i = ? LIMIT 1`,
    link.target_pattern, link.target_id, label, excludeId, link.source_pattern, link.source_id,
  ).toArray();
  return rows.length > 0;
}

/**
 * Every check a link write must pass, in order. Returns the CANONICAL link
 * (inverse wording swapped, label = the relation's name) or an engine-authored
 * refusal — never a raw SQLite constraint.
 *
 * 1. No endpoint is a kernel pattern outside KERNEL_LINK_TARGETS (before label
 *    resolution, so a credential/roster/config endpoint is refused as such).
 * 2. The label names an active relation; an inverse name swaps the endpoints.
 * 3. The canonical source is not a kernel pattern.
 * 4. Both endpoints' patterns exist and their entries are active.
 * 5. The relation's source and target admit the endpoint patterns.
 * 6. (source, target, relation) is unique among active links.
 * 7. Cardinality `one` admits a single active link per source entry.
 * 8. The `acyclic` behavior refuses a link that would close a cycle.
 *
 * `selfId` excludes the row being revalidated (unarchive) from 6–8;
 * `storedLabel` requires the label to be a canonical name (a stored row is never
 * written in inverse wording).
 */
export function checkLinkWrite(
  ctx: RelationsContext, ends: LinkEnds, label: unknown,
  opts: { selfId?: number; storedLabel?: boolean } = {},
): LinkCheck {
  const selfId = opts.selfId ?? -1;

  for (const p of [ends.source_pattern, ends.target_pattern])
    if (!endpointAdmissible(p, "target"))
      return refuse(`Links connect memories in user patterns, not kernel pattern "${p}".`);

  const rels = activeRelations(ctx.db);
  const resolved = resolveLabel(rels, label);
  if (!resolved || (opts.storedLabel && resolved.inverted)) return undeclared(rels, ends, label);
  const { relation, inverted } = resolved;
  const link: LinkEnds = inverted
    ? { source_pattern: ends.target_pattern, source_id: ends.target_id, target_pattern: ends.source_pattern, target_id: ends.source_id }
    : ends;
  const name = relation.name;

  if (!endpointAdmissible(link.source_pattern, "source"))
    return refuse(`Links run from memories in user patterns; kernel pattern "${link.source_pattern}" can only be a link target. ${inverted ? `("${label}" is the inverse of "${name}", so "${link.source_pattern}" would be the stored source.)` : ""}`.trim());

  for (const [end, pattern, id] of [["Source", link.source_pattern, link.source_id], ["Target", link.target_pattern, link.target_id]] as const) {
    if (!Number.isInteger(id)) return refuse(`${end} id must be an integer, got ${JSON.stringify(id)}.`);
    if (!ctx.patternExists(pattern)) return refuse(`${end} pattern "${pattern}" does not exist.`);
    if (!ctx.entryExists(pattern, id)) return refuse(`${end} entry ${id} not found in "${pattern}" (it does not exist or is archived).`);
  }

  if (!admits(relation.source, link.source_pattern, "source") || !admits(relation.target, link.target_pattern, "target")) {
    const available = availableFor(rels, ends.source_pattern, ends.target_pattern);
    return refuse(
      `"${name}" links ${relation.source.join(", ")} → ${relation.target.join(", ")}; ${ref(link.source_pattern, link.source_id)} → ${ref(link.target_pattern, link.target_id)} is outside it. ` +
      (available.length ? `Relations declared from "${ends.source_pattern}" to "${ends.target_pattern}": ${available.join(", ")}.` : `No relation is declared from "${ends.source_pattern}" to "${ends.target_pattern}"; declare one with propose_change type "declare_relation".`),
      { available_relations: available },
    );
  }

  const duplicate = ctx.db.exec(
    `SELECT id FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND target_pattern = ? AND target_id = ? AND label = ? AND id != ? LIMIT 1`,
    link.source_pattern, link.source_id, link.target_pattern, link.target_id, name, selfId,
  ).toArray() as { id: number }[];
  if (duplicate.length)
    return refuse(`${ref(link.source_pattern, link.source_id)} already "${name}" ${ref(link.target_pattern, link.target_id)} (link ${duplicate[0].id}). A pair holds each relation once.`);

  if (relation.cardinality === "one") {
    const held = ctx.db.exec(
      `SELECT id, target_pattern, target_id FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND label = ? AND id != ? LIMIT 1`,
      link.source_pattern, link.source_id, name, selfId,
    ).toArray() as any[];
    if (held.length)
      return refuse(`"${name}" has cardinality one: ${ref(link.source_pattern, link.source_id)} already holds one (to ${ref(held[0].target_pattern, held[0].target_id)}, link ${held[0].id}). Archive that link first to move it.`);
  }

  if (relation.behaviors.includes("acyclic") && closesCycle(ctx.db, name, link, selfId))
    return refuse(`"${name}" is acyclic: ${ref(link.source_pattern, link.source_id)} ${name} ${ref(link.target_pattern, link.target_id)} would close a cycle.`);

  return { ...link, label: name };
}

/** Unarchive revives a row the registry may no longer admit: re-run every create
 *  check against current data, leaving the row itself out. Null = admit (or
 *  nothing to revive — the engine reports a missing/active row itself). */
export function revalidateLink(ctx: RelationsContext, id: unknown): LinkRefusal | null {
  const row = ctx.db.exec(`SELECT * FROM "_links" WHERE id = ?`, id).toArray()[0] as any;
  if (!row || row.archived_at == null) return null;
  const check = checkLinkWrite(ctx, {
    source_pattern: row.source_pattern, source_id: row.source_id,
    target_pattern: row.target_pattern, target_id: row.target_id,
  }, row.label, { selfId: row.id, storedLabel: true });
  return "error" in check ? refuse(`Cannot unarchive link ${row.id}: ${check.message}`, { available_relations: check.available_relations }) : null;
}

// === Unlink: a selector naming exactly one link ===

/**
 * Resolve `unlink {source, target, label?}` to the one active link it names.
 * A label (canonical or inverse, normalized as on create) targets that relation
 * on the pair; without one, the pair must carry exactly one active link. Never
 * guesses: an absent, ambiguous or malformed selector is refused.
 */
export function resolveUnlink(db: DB, data: Record<string, unknown>): { id: number; source: string; target: string } | LinkRefusal {
  let sp = data.source_pattern as string, si = data.source_id as number;
  let tp = data.target_pattern as string, ti = data.target_id as number;
  for (const end of ["source", "target"] as const) {
    if (data[end] == null) continue;
    const parsed = parseEntryRef(data[end]);
    if (!parsed) return refuse(`Invalid ${end} ${JSON.stringify(data[end])} — use "pattern/id" (e.g. "tasks/6").`);
    if (end === "source") { sp = parsed.pattern; si = parsed.id; } else { tp = parsed.pattern; ti = parsed.id; }
  }
  if (!sp || si == null || !tp || ti == null)
    return refuse(`unlink requires source and target as "pattern/id" (e.g. source: "tasks/6", target: "goals/9").`);

  const pair = `${ref(sp, si)} → ${ref(tp, ti)}`;
  if (data.label != null && data.label !== "") {
    const resolved = resolveLabel(activeRelations(db), data.label);
    if (!resolved) return refuse(`"${data.label}" is not a declared relation, so no link on ${pair} carries it. Read ${uri("relations")} for the vocabulary.`);
    const { relation, inverted } = resolved;
    const [s, sId, t, tId] = inverted ? [tp, ti, sp, si] : [sp, si, tp, ti];
    const hit = db.exec(
      `SELECT id FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND target_pattern = ? AND target_id = ? AND label = ? LIMIT 1`,
      s, sId, t, tId, relation.name,
    ).toArray() as { id: number }[];
    if (!hit.length) return refuse(`No active "${relation.name}" link from ${ref(s, sId)} to ${ref(t, tId)}.`);
    return { id: hit[0].id, source: ref(s, sId), target: ref(t, tId) };
  }

  const links = db.exec(
    `SELECT id, label FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND target_pattern = ? AND target_id = ? ORDER BY id`,
    sp, si, tp, ti,
  ).toArray() as { id: number; label: string }[];
  if (!links.length) return refuse(`No active link from ${ref(sp, si)} to ${ref(tp, ti)}.`);
  if (links.length > 1) {
    const labels = links.map((l) => l.label);
    return refuse(`${pair} carries ${labels.length} relations (${labels.join(", ")}); pass label to name the one to unlink.`, { labels });
  }
  return { id: links[0].id, source: ref(sp, si), target: ref(tp, ti) };
}

// === Reads: supersession by behavior, reader-side link naming ===

/** The entry superseding `pattern/id` through any relation declaring
 *  `supersession`, as a URI — or null. */
export function supersededBy(db: DB, pattern: string, id: number): string | null {
  const names = relationsWith(db, "supersession");
  if (!names.length) return null;
  const rows = db.exec(
    `SELECT source_pattern, source_id FROM "_links" WHERE archived_at IS NULL AND target_pattern = ? AND target_id = ? AND label IN (${names.map(() => "?").join(",")}) ORDER BY id LIMIT 1`,
    pattern, id, ...names,
  ).toArray() as { source_pattern: string; source_id: number }[];
  return rows.length ? uri(`entry/${rows[0].source_pattern}/${rows[0].source_id}`) : null;
}

/** Of `ids` in `pattern`, the ones superseded through a `supersession` relation. */
export function supersededAmong(db: DB, pattern: string, ids: number[]): Set<number> {
  const names = relationsWith(db, "supersession");
  if (!names.length || !ids.length) return new Set();
  return new Set((db.exec(
    `SELECT target_id FROM "_links" WHERE archived_at IS NULL AND target_pattern = ? AND target_id IN (${ids.map(() => "?").join(",")}) AND label IN (${names.map(() => "?").join(",")})`,
    pattern, ...ids, ...names,
  ).toArray() as { target_id: number }[]).map((r) => r.target_id));
}

/** One active link of an entry, read from that entry's side. */
export interface EntryLink {
  link_id: number;
  pattern: string;
  id: number;
  /** The canonical relation name stored on the link. */
  label: string;
  /** "out": the entry is the source; "in": the entry is the target. */
  direction: "out" | "in";
  /** The relation as read from the entry's side: its name out, its inverse in. */
  relation: string;
}

/** Every active link touching `pattern/id`, one item per link, both directions. */
export function linksOf(db: DB, pattern: string, id: number): EntryLink[] {
  const rows = db.exec(
    `SELECT id AS link_id, target_pattern AS pattern, target_id AS eid, label, 'out' AS direction FROM "_links"
       WHERE source_pattern = ? AND source_id = ? AND archived_at IS NULL
     UNION ALL
     SELECT id, source_pattern, source_id, label, 'in' FROM "_links"
       WHERE target_pattern = ? AND target_id = ? AND archived_at IS NULL
     ORDER BY link_id`,
    pattern, id, pattern, id,
  ).toArray() as any[];
  if (!rows.length) return [];
  const inverseOf = new Map(activeRelations(db).map((r) => [r.name, r.inverse]));
  return rows.map((r) => ({
    link_id: r.link_id,
    pattern: r.pattern,
    id: r.eid,
    label: r.label,
    direction: r.direction,
    relation: r.direction === "out" ? r.label : (inverseOf.get(r.label) ?? r.label),
  }));
}

/** SQL predicate (bind the table name as its one parameter): the row is not the
 *  target of an active link. Every GC pass over a link-targetable table ANDs this
 *  in — a link protects its target, derived from the link itself, no stored flag
 *  (the `linked targets survive GC` invariant). */
export const NOT_LINK_TARGET_SQL = `id NOT IN (SELECT target_id FROM "_links" WHERE target_pattern = ? AND archived_at IS NULL)`;

/** SQL predicate over a pattern-name expression (e.g. `_objects.name`): no
 *  active link from an entry OUTSIDE that pattern targets one of its entries.
 *  The archived-pattern drop ANDs this in, so a linked archived pattern is kept
 *  (its links dormant) until those links go; links internal to the pattern don't
 *  protect it. Derived from the links, no stored flag. */
export function notLinkTargetPatternSql(nameExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM "_links" WHERE archived_at IS NULL AND target_pattern = ${nameExpr} AND source_pattern != ${nameExpr})`;
}

/** An archived USER pattern past the 30-day drop horizon (over `_objects`). The
 *  drop (schema.ts GC) and the stale view's held_patterns read this one fragment,
 *  each paired with notLinkTargetPatternSql — dropped when it holds, held when its
 *  negation holds — so "held" and "not dropped" can never disagree. */
export const PAST_DROP_HORIZON_SQL = `archived_at IS NOT NULL AND archived_at < datetime('now', '-30 days') AND name NOT LIKE '\\_%' ESCAPE '\\'`;

/** An archived pattern the drop is keeping only because links from outside it
 *  point in, with every such link — for the owner to resolve (archive or re-point
 *  the links, or unarchive the pattern). Never auto-dropped. */
export interface HeldPattern {
  pattern: string;
  archived_at: string;
  days_archived: number;
  held_by: { source: string; target: string; label: string }[];
}

/** Every archived pattern past the drop horizon that an active inbound link from
 *  outside it holds. Derived on read from the drop's own predicate; nothing stored. */
export function heldPatterns(db: DB): HeldPattern[] {
  const held = db.exec(
    `SELECT name, archived_at, CAST(julianday('now') - julianday(archived_at) AS INTEGER) AS days
     FROM _objects WHERE ${PAST_DROP_HORIZON_SQL} AND NOT ${notLinkTargetPatternSql("_objects.name")} ORDER BY name`,
  ).toArray() as { name: string; archived_at: string; days: number }[];
  return held.map((p) => ({
    pattern: p.name,
    archived_at: p.archived_at,
    days_archived: p.days,
    held_by: (db.exec(
      `SELECT source_pattern, source_id, target_pattern, target_id, label FROM "_links"
       WHERE archived_at IS NULL AND target_pattern = ? AND source_pattern != ? ORDER BY id`,
      p.name, p.name,
    ).toArray() as any[]).map((l) => ({ source: ref(l.source_pattern, l.source_id), target: ref(l.target_pattern, l.target_id), label: l.label })),
  }));
}

/** The relations a pattern may stand in — canonical names whose source (or
 *  target) admits it, `*` relations included. Read by mnemion://schema/<pattern>. */
export function relationsFor(db: DB, pattern: string): { as_source: string[]; as_target: string[] } {
  const rels = activeRelations(db);
  return {
    as_source: rels.filter((r) => admits(r.source, pattern, "source")).map((r) => r.name),
    as_target: rels.filter((r) => admits(r.target, pattern, "target")).map((r) => r.name),
  };
}

// === Boot: kernel seed, label rewrite, integrity sweep, legacy declarations ===

/** Seed the kernel defaults (idempotent) and refresh their code-owned semantics. */
export function seedKernelRelations(db: DB): void {
  for (const k of KERNEL_RELATIONS) {
    const row = db.exec(`SELECT id FROM "_relations" WHERE name = ? AND archived_at IS NULL`, k.name).toArray()[0] as any;
    const star = JSON.stringify([ANY]);
    const behaviors = JSON.stringify(k.behaviors);
    if (row) {
      // Only touch a row that drifted, so a steady boot writes nothing (no audit churn).
      db.exec(
        `UPDATE "_relations" SET inverse = ?, description = ?, source = ?, target = ?, cardinality = 'many', behaviors = ?, kernel = 1, legacy = 0, updated_at = datetime('now') WHERE id = ?
         AND (inverse != ? OR description != ? OR source != ? OR target != ? OR cardinality != 'many' OR behaviors != ? OR kernel != 1 OR legacy != 0)`,
        k.inverse, k.description, star, star, behaviors, row.id,
        k.inverse, k.description, star, star, behaviors,
      );
    } else {
      db.exec(
        `INSERT INTO "_relations" (name, inverse, description, source, target, cardinality, behaviors, kernel, legacy) VALUES (?, ?, ?, ?, ?, 'many', ?, 1, 0)`,
        k.name, k.inverse, k.description, star, star, behaviors,
      );
    }
  }
}

const ARCHIVE_LINKS = `UPDATE "_links" SET archived_at = datetime('now'), updated_at = datetime('now') WHERE archived_at IS NULL`;

/** Archive every active link whose endpoint is GONE, or is a kernel pattern no
 *  relation may admit. "Gone" means the pattern has no `_objects` row or no table,
 *  or the entry row no longer exists — never merely archived.
 *
 *  @why Every Durable Object cold start is a boot, and archive is reversible. A
 *  link to an archived entry or pattern stays active ("dormant"): reads hide it
 *  (followLinks only expands into active endpoints), it still counts for
 *  uniqueness and cardinality, and it is back unchanged on unarchive. Sweeping it
 *  would make a link's survival depend on eviction timing. (An archived
 *  `_web_cache` snapshot is just a dormant link's target, protected from GC by
 *  NOT_LINK_TARGET_SQL.) */
export function sweepDanglingLinks(db: DB): void {
  const exists = (p: string) => {
    if (db.exec(`SELECT 1 FROM _objects WHERE name = ?`, p).toArray().length === 0) return false;
    return db.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, p).toArray().length > 0;
  };
  const patterns = (db.exec(
    `SELECT source_pattern AS p FROM "_links" WHERE archived_at IS NULL
     UNION SELECT target_pattern FROM "_links" WHERE archived_at IS NULL`,
  ).toArray() as { p: string }[]).map((r) => r.p);
  for (const p of patterns) {
    if (!exists(p)) { db.exec(`${ARCHIVE_LINKS} AND (source_pattern = ? OR target_pattern = ?)`, p, p); continue; }
    if (!endpointAdmissible(p, "source")) db.exec(`${ARCHIVE_LINKS} AND source_pattern = ?`, p);
    if (!endpointAdmissible(p, "target")) db.exec(`${ARCHIVE_LINKS} AND target_pattern = ?`, p);
    const table = quoteIdent(p);
    db.exec(`${ARCHIVE_LINKS} AND source_pattern = ? AND source_id NOT IN (SELECT id FROM ${table})`, p);
    db.exec(`${ARCHIVE_LINKS} AND target_pattern = ? AND target_id NOT IN (SELECT id FROM ${table})`, p);
  }
}

/** Boot step 2: rewrite pre-registry labels into canonical form, BEFORE the
 *  sweep — so a link whose canonical form lands on an inadmissible endpoint (e.g.
 *  `notes/1 -[referenced-by]-> _documents/1` becomes a kernel SOURCE) is swept in
 *  the same boot and totality holds after the first one.
 *  1. Unlabeled links become `references` (archived if the pair already has one).
 *  2. Links worded as an active relation's inverse swap ends and take its name
 *     (archived if that duplicates an existing link). This may close a cycle in
 *     an acyclic relation; that is reported at boot (findCycles), never repaired. */
export function rewriteLegacyLabels(db: DB): void {
  const dupOf = `EXISTS (SELECT 1 FROM "_links" d WHERE d.archived_at IS NULL AND d.id != "_links".id
    AND d.source_pattern = "_links".source_pattern AND d.source_id = "_links".source_id
    AND d.target_pattern = "_links".target_pattern AND d.target_id = "_links".target_id AND d.label = ?)`;
  db.exec(`${ARCHIVE_LINKS} AND (label IS NULL OR trim(label) = '') AND ${dupOf}`, GENERIC_RELATION);
  db.exec(`UPDATE "_links" SET label = ?, updated_at = datetime('now') WHERE archived_at IS NULL AND (label IS NULL OR trim(label) = '')`, GENERIC_RELATION);

  const rels = activeRelations(db);
  for (const r of rels) {
    if (rels.some((x) => x.name === r.inverse)) continue; // a name wins over an inverse
    const worded = db.exec(`SELECT id, source_pattern, source_id, target_pattern, target_id FROM "_links" WHERE archived_at IS NULL AND label = ?`, r.inverse).toArray() as any[];
    for (const l of worded) {
      const dup = db.exec(
        `SELECT 1 FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND target_pattern = ? AND target_id = ? AND label = ?`,
        l.target_pattern, l.target_id, l.source_pattern, l.source_id, r.name,
      ).toArray().length > 0;
      if (dup) db.exec(`${ARCHIVE_LINKS} AND id = ?`, l.id);
      else db.exec(
        `UPDATE "_links" SET source_pattern = ?, source_id = ?, target_pattern = ?, target_id = ?, label = ?, updated_at = datetime('now') WHERE id = ?`,
        l.target_pattern, l.target_id, l.source_pattern, l.source_id, r.name, l.id,
      );
    }
  }
}

/** Boot step 4, after the sweep (so no relation names a pattern that is gone):
 *  declare every remaining undeclared label verbatim as a `legacy` relation, its
 *  ends inferred from usage, so the hive stays writable.
 *
 *  @why Generated inverses must avoid every declared name and inverse AND every
 *  in-use label — those labels become names in this same pass. The taken set is
 *  complete before the first inverse is generated, so the result never depends on
 *  the order labels arrive in (an in-use `bar-inverse` can't collide with `bar`'s
 *  generated inverse either way). */
export function declareLegacyRelations(db: DB): void {
  const rels = activeRelations(db);
  const declared = new Set(rels.map((r) => r.name));
  const usage = new Map<string, { source: Set<string>; target: Set<string> }>();
  for (const u of db.exec(
    `SELECT DISTINCT label, source_pattern, target_pattern FROM "_links" WHERE archived_at IS NULL ORDER BY label`,
  ).toArray() as { label: string; source_pattern: string; target_pattern: string }[]) {
    if (declared.has(u.label)) continue;
    const e = usage.get(u.label) ?? { source: new Set(), target: new Set() };
    e.source.add(u.source_pattern); e.target.add(u.target_pattern);
    usage.set(u.label, e);
  }
  const taken = new Set([...rels.flatMap((r) => [r.name, r.inverse]), ...usage.keys()]);
  for (const [name, ends] of usage) {
    let inverse = `${name}-inverse`;
    for (let n = 2; taken.has(inverse); n++) inverse = `${name}-inverse-${n}`;
    taken.add(inverse);
    db.exec(
      `INSERT INTO "_relations" (name, inverse, description, source, target, cardinality, behaviors, kernel, legacy) VALUES (?, ?, ?, ?, ?, 'many', '[]', 0, 1)`,
      name, inverse,
      `Legacy relation "${name}", declared automatically from links written before the relations registry. Its meaning was never recorded. Amend it with amend_relation: say what it asserts, when to use it rather than its nearest neighbour, and give an example.`,
      JSON.stringify([...ends.source].sort()), JSON.stringify([...ends.target].sort()),
    );
  }
}

/** Boot findings: one line per relation still carrying a legacy placeholder
 *  description. Pure, so the boot warning and any test read the same rule. */
export function findLegacyRelations(relations: Pick<Relation, "name" | "legacy">[]): string[] {
  return relations.filter((r) => r.legacy).map((r) =>
    `relation "${r.name}" is legacy (placeholder description) — amend_relation with a real description to clear it`);
}

/** One acyclic relation's active edges, as `pattern/id` endpoints. */
export interface RelationGraph { relation: string; edges: { source: string; target: string }[] }

/** The active links of every relation declaring `acyclic` — the input to findCycles. */
export function acyclicGraphs(db: DB): RelationGraph[] {
  return relationsWith(db, "acyclic").map((relation) => ({
    relation,
    edges: (db.exec(
      `SELECT source_pattern, source_id, target_pattern, target_id FROM "_links" WHERE archived_at IS NULL AND label = ? ORDER BY id`,
      relation,
    ).toArray() as any[]).map((l) => ({ source: ref(l.source_pattern, l.source_id), target: ref(l.target_pattern, l.target_id) })),
  }));
}

/**
 * Boot findings: cycles already present across an acyclic relation. Writes can
 * never create one (checkLinkWrite), but pre-registry data, or the legacy
 * inverse rewrite, can. One line per cycle — each strongly connected group of
 * entries that loops (a self-loop included) — naming the relation and every
 * entry in it. Pure and report-only: maintenance is owner-ratified, so the
 * links stay in place.
 */
export function findCycles(graphs: RelationGraph[]): string[] {
  const out: string[] = [];
  for (const { relation, edges } of graphs) {
    const next = new Map<string, string[]>();
    for (const e of edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
    const selfLoop = new Set(edges.filter((e) => e.source === e.target).map((e) => e.source));
    // Tarjan's strongly connected components.
    const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;
    const visit = (v: string) => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of next.get(v) ?? []) {
        if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) === index.get(v)) {
        const group: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); group.push(w); } while (w !== v);
        if (group.length > 1 || selfLoop.has(v))
          out.push(`cycle across acyclic relation "${relation}": ${group.reverse().join(" → ")} — pre-existing data, left in place; archive a link to break it`);
      }
    };
    for (const v of next.keys()) if (!index.has(v)) visit(v);
  }
  return out;
}

/** The relations migration, in boot order. Each step is idempotent: a second
 *  boot changes nothing. */
export function migrateRelations(db: DB): void {
  db.exec(`DROP INDEX IF EXISTS "_links_pair_active"`); // one pair may now carry several relations
  seedKernelRelations(db);    // 1. kernel defaults (so supersedes etc. resolve below)
  rewriteLegacyLabels(db);    // 2. NULL → references; inverse wording → canonical
  sweepDanglingLinks(db);     // 3. gone or inadmissible endpoints (incl. ones the rewrite exposed)
  declareLegacyRelations(db); // 4. what remains undeclared becomes a legacy relation
}

// === Vocabulary evolution: declare / amend / retire ===

/** One active link that an amend or retire would strand. */
export interface RelationViolation { link_id: number; source: string; target: string; label: string; reason: string }

function activeRelation(db: DB, name: unknown): Relation | null {
  return typeof name === "string" ? (activeRelations(db).find((r) => r.name === name) ?? null) : null;
}

/** Every active name and inverse, mapped to the relation that owns it. */
function vocabulary(rels: Relation[], except?: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rels) {
    if (r.name === except) continue;
    m.set(r.name, r.name);
    m.set(r.inverse, r.name);
  }
  return m;
}

function checkHandle(kind: "name" | "inverse", value: unknown, taken: Map<string, string>): string | null {
  if (typeof value !== "string" || !value) return `${kind} is required for a relation`;
  if (value.startsWith("_")) return `Relation ${kind} "${value}" is reserved — names starting with "_" belong to the kernel.`;
  if (!NAME_RE.test(value)) return `Relation ${kind} "${value}" must be kebab-case: lowercase letters and digits joined by single hyphens (e.g. "cites", "cited-by").`;
  const owner = taken.get(value);
  if (owner) return `Relation ${kind} "${value}" is already taken by the active relation "${owner}" (names and inverses share one vocabulary).`;
  return null;
}

function checkDescription(description: unknown, handles: string[]): string | null {
  if (typeof description !== "string" || description.trim().length < DESCRIPTION_MIN_CHARS)
    return `A relation description must be at least ${DESCRIPTION_MIN_CHARS} characters: say what the relation asserts, when to use it rather than its nearest neighbour, and give one example in canonical direction.`;
  let rest = description.toLowerCase();
  for (const h of [...handles].sort((a, b) => b.length - a.length)) if (h) rest = rest.split(h.toLowerCase()).join(" ");
  if (rest.replace(/[^\p{L}\p{N}]+/gu, "").length < DESCRIPTION_MIN_SUBSTANCE)
    return `The relation description merely restates "${handles[0]}" — say what it asserts, when to use it, and give an example.`;
  return null;
}

function normList(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  return Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null;
}

function checkEnd(ctx: RelationsContext, end: "source" | "target", value: unknown): string | null {
  const list = normList(value);
  if (!list || !list.length) return `${end} is required: a list of pattern names, or ["*"] for any user pattern.`;
  if (list.includes(ANY)) return list.length === 1 ? null : `${end} lists "*" (any user pattern) beside other patterns — use ["*"] alone or name the patterns.`;
  for (const p of list) {
    if (isKernelPattern(p) && !endpointAdmissible(p, end))
      return end === "source"
        ? `${end} names kernel pattern "${p}" — a relation's source must be a user pattern.`
        : `${end} names kernel pattern "${p}" — the only kernel link targets are ${[...KERNEL_LINK_TARGETS].join(" and ")}.`;
    if (!ctx.patternExists(p)) return `${end} names pattern "${p}", which does not exist.`;
  }
  return null;
}

/** Every field a relation change may carry. */
const RELATION_FIELDS = ["name", "inverse", "description", "source", "target", "cardinality", "behaviors", "required", "chain", "new_name"] as const;

/** An explicit null is refused for every field: it never means "use the default"
 *  (declare) or "clear it" (amend) — omit a field to leave it out. */
function checkNoNulls(change: any): string | null {
  const f = RELATION_FIELDS.find((k) => change[k] === null);
  return f ? `"${f}" is null — omit a field to leave it unset; null never means "use the default" or "clear it".` : null;
}

function checkShape(change: any): string | null {
  for (const f of NOT_YET_SUPPORTED.fields)
    if (change[f] !== undefined && change[f] !== false)
      return `"${f}" relations are not yet supported (Phase 2). Declare the relation without it.`;
  if (change.cardinality !== undefined && !(CARDINALITIES as readonly string[]).includes(change.cardinality))
    return `cardinality must be "one" or "many", got ${JSON.stringify(change.cardinality)}.`;
  if (change.behaviors !== undefined) {
    if (!Array.isArray(change.behaviors)) return `behaviors must be an array, a subset of: ${Object.keys(BEHAVIOR_PALETTE).join(", ")}.`;
    for (const b of change.behaviors) {
      if (NOT_YET_SUPPORTED.behaviors.has(b)) return `Behavior "${b}" is not yet supported (Phase 2) — the engine does not perform it yet.`;
      if (!isBehavior(b)) return `Unknown behavior "${b}". The palette: ${Object.keys(BEHAVIOR_PALETTE).join(", ")}.`;
    }
  }
  return null;
}

/** The relation a declare_relation change would create. */
export function declaredRelation(change: any): Relation {
  return {
    name: change.name,
    inverse: change.inverse,
    description: change.description,
    source: normList(change.source) ?? [],
    target: normList(change.target) ?? [],
    cardinality: change.cardinality === "one" ? "one" : "many",
    behaviors: [...new Set<string>(change.behaviors ?? [])],
    kernel: false,
    legacy: false,
  };
}

/** The relation an amend_relation change would leave. */
export function amendedRelation(current: Relation, change: any): Relation {
  return {
    ...current,
    ...(change.inverse !== undefined ? { inverse: change.inverse } : {}),
    ...(change.description !== undefined ? { description: change.description, legacy: false } : {}),
    ...(change.cardinality !== undefined ? { cardinality: change.cardinality } : {}),
    ...(change.behaviors !== undefined ? { behaviors: [...new Set<string>(change.behaviors)] } : {}),
  };
}

export function validateDeclare(ctx: RelationsContext, change: any): string | null {
  const taken = vocabulary(activeRelations(ctx.db));
  return checkNoNulls(change)
    ?? checkHandle("name", change.name, taken)
    ?? checkHandle("inverse", change.inverse, taken)
    ?? (change.inverse === change.name ? `The inverse must differ from the name "${change.name}".` : null)
    ?? checkDescription(change.description, [change.name, change.inverse])
    ?? checkEnd(ctx, "source", change.source)
    ?? checkEnd(ctx, "target", change.target)
    ?? checkShape(change);
}

const AMENDABLE = ["description", "inverse", "behaviors", "cardinality"] as const;

export function validateAmend(ctx: RelationsContext, change: any): string | null {
  const current = activeRelation(ctx.db, change.name);
  if (!current) return `No active relation named ${JSON.stringify(change.name)} to amend. Read ${uri("relations")} for the vocabulary.`;
  if (current.kernel) return `"${current.name}" is a kernel default — its meaning is owned by code and cannot be amended. Declare a new relation instead.`;
  const nulls = checkNoNulls(change);
  if (nulls) return nulls;
  if (change.new_name !== undefined) return `A relation's name is immutable ("${current.name}"). Declare a new relation and move the links to it instead.`;
  for (const f of ["source", "target"] as const)
    if (change[f] !== undefined) return `A relation's ${f} patterns are not amendable yet. Declare a new relation with the ends you need.`;
  if (!AMENDABLE.some((f) => change[f] !== undefined)) return `amend_relation changes at least one of: ${AMENDABLE.join(", ")}.`;
  const next = amendedRelation(current, change);
  if (change.inverse !== undefined) {
    const err = checkHandle("inverse", change.inverse, vocabulary(activeRelations(ctx.db), current.name))
      ?? (change.inverse === current.name ? `The inverse must differ from the name "${current.name}".` : null);
    if (err) return err;
  }
  if (change.description !== undefined) {
    const err = checkDescription(change.description, [next.name, next.inverse]);
    if (err) return err;
  }
  return checkShape(change);
}

export function validateRetire(ctx: RelationsContext, change: any): string | null {
  const current = activeRelation(ctx.db, change.name);
  if (!current) return `No active relation named ${JSON.stringify(change.name)} to retire.`;
  if (current.kernel) return `"${current.name}" is a kernel default and cannot be retired.`;
  return null;
}

/** Active links the amended relation would no longer admit: a second link from
 *  one source under cardinality one, or a link on a cycle under acyclic. */
export function amendViolations(db: DB, change: any): RelationViolation[] {
  const current = activeRelation(db, change.name);
  if (!current) return [];
  const next = amendedRelation(current, change);
  const links = db.exec(
    `SELECT id, source_pattern, source_id, target_pattern, target_id FROM "_links" WHERE archived_at IS NULL AND label = ? ORDER BY id`,
    next.name,
  ).toArray() as any[];
  const out: RelationViolation[] = [];
  const v = (l: any, reason: string): RelationViolation => ({
    link_id: l.id, source: ref(l.source_pattern, l.source_id), target: ref(l.target_pattern, l.target_id), label: next.name, reason,
  });
  if (next.cardinality === "one") {
    const seen = new Set<string>();
    for (const l of links) {
      const s = ref(l.source_pattern, l.source_id);
      if (seen.has(s)) out.push(v(l, `${s} would hold more than one "${next.name}" link under cardinality one`));
      seen.add(s);
    }
  }
  if (next.behaviors.includes("acyclic")) {
    for (const l of links)
      if (closesCycle(db, next.name, l, l.id)) out.push(v(l, `link lies on a "${next.name}" cycle`));
  }
  return out;
}

/** Every active link still using the relation — a retire would strand each one. */
export function retireViolations(db: DB, change: any): RelationViolation[] {
  if (typeof change.name !== "string") return [];
  return (db.exec(
    `SELECT id, source_pattern, source_id, target_pattern, target_id FROM "_links" WHERE archived_at IS NULL AND label = ? ORDER BY id`,
    change.name,
  ).toArray() as any[]).map((l) => ({
    link_id: l.id, source: ref(l.source_pattern, l.source_id), target: ref(l.target_pattern, l.target_id), label: change.name,
    reason: "an active link uses this relation — archive or move it first",
  }));
}

// Apply re-runs validation against current data (a concurrent write between
// propose and apply can make a once-valid change invalid); a throw is reported by
// applyChange as a refusal and nothing is written.

export function declareRelation(ctx: RelationsContext, change: any): void {
  const err = validateDeclare(ctx, change);
  if (err) throw new Error(err);
  const r = declaredRelation(change);
  ctx.db.exec(
    `INSERT INTO "_relations" (name, inverse, description, source, target, cardinality, behaviors, kernel, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    r.name, r.inverse, r.description, JSON.stringify(r.source), JSON.stringify(r.target), r.cardinality, JSON.stringify(r.behaviors),
  );
}

export function amendRelation(ctx: RelationsContext, change: any): void {
  const err = validateAmend(ctx, change);
  if (err) throw new Error(err);
  const next = amendedRelation(activeRelation(ctx.db, change.name)!, change);
  ctx.db.exec(
    `UPDATE "_relations" SET inverse = ?, description = ?, cardinality = ?, behaviors = ?, legacy = ?, version = version + 1, updated_at = datetime('now')
     WHERE name = ? AND archived_at IS NULL`,
    next.inverse, next.description, next.cardinality, JSON.stringify(next.behaviors), next.legacy ? 1 : 0, next.name,
  );
}

export function retireRelation(ctx: RelationsContext, change: any): void {
  const err = validateRetire(ctx, change);
  if (err) throw new Error(err);
  ctx.db.exec(
    `UPDATE "_relations" SET archived_at = datetime('now'), updated_at = datetime('now') WHERE name = ? AND archived_at IS NULL`,
    change.name,
  );
}
