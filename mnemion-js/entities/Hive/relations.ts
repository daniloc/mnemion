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
import { dropColumn } from "./audit-triggers";

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
  containment: {
    performs: "The source is part of the target. Archiving a target that still has active members is refused unless the same batch archives or moves them; archive_pattern on a container pattern is refused while members in other patterns link in. Recall goes upward only: prime follows member → container, never container → members.",
    where: "endStateViolations (the mutate/batch end state), containmentHolders (archive_pattern), and followLinks' recall mode.",
  },
} as const;

export type Behavior = keyof typeof BEHAVIOR_PALETTE;

function isBehavior(b: unknown): b is Behavior {
  return typeof b === "string" && Object.prototype.hasOwnProperty.call(BEHAVIOR_PALETTE, b);
}

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
    name: "part-of", inverse: "has-part", behaviors: ["containment", "acyclic"],
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
  /** A derived relation's ends are its first step's source and last step's target. */
  source: string[];
  target: string[];
  cardinality: Cardinality;
  behaviors: string[];
  /** Every active entry of a listed source pattern must hold one. */
  required: boolean;
  /** True exactly when `chain` is set: computed at read time, never stored. */
  derived: boolean;
  chain?: string[];
  kernel: boolean;
  /** `legacy_debt.length > 0`. */
  legacy: boolean;
  /** Which legacy debts remain — derived from the current values (legacyDebt). */
  legacy_debt: string[];
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

// === Legacy debt (derived, never stored) ===
//
// A relation the v17 migration declared carries up to two debts, each read from
// its CURRENT values against a code-owned template — so nothing can drift:
// a placeholder description, and a migration-generated inverse. Paying both
// (amend_relation) clears legacy. The generated-inverse form is reserved, so an
// owner-chosen inverse never looks generated.

/** The v17 migration's placeholder description. FROZEN: changing this text would
 *  silently clear the debt on every old row that still carries it. */
export function legacyPlaceholder(name: string): string {
  return `Legacy relation "${name}", declared automatically from links written before the relations registry. Its meaning was never recorded. Amend it with amend_relation: say what it asserts, when to use it rather than its nearest neighbour, and give an example.`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `inverse` have the migration's generated form for `name`? */
function isGeneratedInverse(name: string, inverse: string): boolean {
  return new RegExp(`^${escapeRe(name)}-inverse(-\\d+)?$`).test(inverse);
}

export const LEGACY_DEBTS = ["placeholder description", "generated inverse"] as const;

function legacyDebt(r: { name: string; description: string; inverse: string }): string[] {
  const debt: string[] = [];
  if (r.description === legacyPlaceholder(r.name)) debt.push(LEGACY_DEBTS[0]);
  if (isGeneratedInverse(r.name, r.inverse)) debt.push(LEGACY_DEBTS[1]);
  return debt;
}

function toRelation(r: any): Relation {
  const chain = r.chain != null ? parseList(r.chain) : null;
  const debt = legacyDebt(r);
  return {
    name: r.name,
    inverse: r.inverse,
    description: r.description,
    source: parseList(r.source),
    target: parseList(r.target),
    cardinality: r.cardinality === "one" ? "one" : "many",
    behaviors: parseList(r.behaviors),
    required: !!r.required,
    derived: chain != null,
    ...(chain != null ? { chain } : {}),
    kernel: !!r.kernel,
    legacy: debt.length > 0,
    legacy_debt: debt,
  };
}

/** Every active relation, kernel defaults first. Empty before the table exists.
 *  A derived relation's ends are read off its steps here (never stored). */
export function activeRelations(db: DB): Relation[] {
  let rels: Relation[];
  try {
    rels = (db.exec(
      `SELECT name, inverse, description, source, target, cardinality, behaviors, required, chain, kernel
       FROM "_relations" WHERE archived_at IS NULL ORDER BY kernel DESC, name`,
    ).toArray() as any[]).map(toRelation);
  } catch {
    return [];
  }
  const byName = new Map(rels.map((r) => [r.name, r]));
  for (const r of rels) {
    if (!r.chain) continue;
    r.source = [...(byName.get(r.chain[0])?.source ?? [])];
    r.target = [...(byName.get(r.chain[r.chain.length - 1])?.target ?? [])];
  }
  return rels;
}

/** The read surface: index `relations` and `mnemion://relations`. */
export const listRelations = activeRelations;

/** Stored (writable) relations only — a derived relation never admits a write. */
const stored = (rels: Relation[]) => rels.filter((r) => !r.derived);

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
  return stored(rels)
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
 * 2. The label names an active STORED relation (a derived relation is refused,
 *    naming its steps); an inverse name swaps the endpoints.
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
  if (relation.chain)
    return refuse(`"${label}" names the derived relation "${relation.name}" (${relation.chain.join(" ∘ ")}), which is computed at read time and never stored. Write its stored steps instead: ${relation.chain.join(", ")}.`);
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

/** Is `pattern/id` live — its pattern active and its row present and unarchived?
 *  Dormant links (to an archived entry or pattern) never derive, contain or hold. */
function entryActive(db: DB, pattern: string, id: number): boolean {
  if (db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NULL`, pattern).toArray().length === 0) return false;
  try {
    return db.exec(`SELECT 1 FROM ${quoteIdent(pattern)} WHERE id = ? AND archived_at IS NULL`, id).toArray().length > 0;
  } catch { return false; }
}

/** One derived (chain) connection of an entry, read from that entry's side. */
export interface DerivedLink { pattern: string; id: number; direction: "out" | "in"; relation: string }

/**
 * The entries a derived relation reaches from `pattern/id`, computed at read time
 * and never stored. Out: walk the chain's steps forward from the entry (the name);
 * in: walk them backward (the inverse). Only active links between active entries
 * count. Deduplicated per (relation, entry).
 */
export function derivedLinksOf(db: DB, pattern: string, id: number): DerivedLink[] {
  const out: DerivedLink[] = [];
  const seen = new Set<string>();
  const step = (frontier: string[], label: string, forward: boolean): string[] => {
    const next = new Set<string>();
    for (const node of frontier) {
      const at = parseEntryRef(node)!;
      const rows = db.exec(
        forward
          ? `SELECT target_pattern AS p, target_id AS i FROM "_links" WHERE archived_at IS NULL AND label = ? AND source_pattern = ? AND source_id = ?`
          : `SELECT source_pattern AS p, source_id AS i FROM "_links" WHERE archived_at IS NULL AND label = ? AND target_pattern = ? AND target_id = ?`,
        label, at.pattern, at.id,
      ).toArray() as { p: string; i: number }[];
      for (const r of rows) if (entryActive(db, r.p, r.i)) next.add(ref(r.p, r.i));
    }
    return [...next];
  };
  if (!entryActive(db, pattern, id)) return out;
  for (const rel of activeRelations(db)) {
    if (!rel.chain) continue;
    for (const direction of ["out", "in"] as const) {
      const steps = direction === "out" ? rel.chain : [...rel.chain].reverse();
      let frontier = [ref(pattern, id)];
      for (const label of steps) frontier = step(frontier, label, direction === "out");
      const relation = direction === "out" ? rel.name : rel.inverse;
      for (const node of frontier) {
        const key = `${relation}|${node}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const at = parseEntryRef(node)!;
        out.push({ pattern: at.pattern, id: at.id, direction, relation });
      }
    }
  }
  return out;
}

// === End state: required relations and containment ===
//
// Both rules are judged on the END STATE of a write — a single mutate, or a whole
// batch — so a move (archive the old link, create the new one) or archiving a
// container together with its members succeeds in either order. The mutate
// engine records what each write touched; endStateViolations judges it once, at
// the end, inside the same transaction, and a violation rolls the write back.

/** Why an entry is being judged at the end of a write — shapes the message. */
export type TouchCause = "created" | "archived" | "unarchived" | "link-removed";
/** Entries a write touched, keyed `pattern/id`, with the first cause seen. */
export type Touched = Map<string, TouchCause>;

export function touch(touched: Touched, pattern: string, id: number, cause: TouchCause): void {
  const key = ref(pattern, id);
  if (!touched.has(key)) touched.set(key, cause);
}

/** Active required relations whose source explicitly lists `pattern`. */
function requiredFor(rels: Relation[], pattern: string): Relation[] {
  return rels.filter((r) => r.required && !r.derived && r.source.includes(pattern));
}

function holdsLink(db: DB, pattern: string, id: number, label: string): boolean {
  return db.exec(
    `SELECT 1 FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND label = ? LIMIT 1`,
    pattern, id, label,
  ).toArray().length > 0;
}

/** Active members (`pattern/id`) holding an active containment link into `pattern/id`. */
function activeMembers(db: DB, rels: Relation[], pattern: string, id: number): { member: string; label: string }[] {
  const containment = rels.filter((r) => r.behaviors.includes("containment")).map((r) => r.name);
  if (!containment.length) return [];
  return (db.exec(
    `SELECT source_pattern, source_id, label FROM "_links" WHERE archived_at IS NULL AND target_pattern = ? AND target_id = ? AND label IN (${containment.map(() => "?").join(",")}) ORDER BY id`,
    pattern, id, ...containment,
  ).toArray() as any[])
    .filter((l) => entryActive(db, l.source_pattern, l.source_id))
    .map((l) => ({ member: ref(l.source_pattern, l.source_id), label: l.label }));
}

/** The containers (`pattern/id`) an active member links into through a
 *  containment relation while they are inactive — the entry archived or its
 *  pattern archived. `selfActive` names a pattern to treat as active (an
 *  unarchive_pattern being judged before it applies). */
function inactiveContainers(db: DB, rels: Relation[], pattern: string, id: number, selfActive?: string): { container: string; label: string }[] {
  const containment = rels.filter((r) => r.behaviors.includes("containment")).map((r) => r.name);
  if (!containment.length) return [];
  return (db.exec(
    `SELECT target_pattern, target_id, label FROM "_links" WHERE archived_at IS NULL AND source_pattern = ? AND source_id = ? AND label IN (${containment.map(() => "?").join(",")}) ORDER BY id`,
    pattern, id, ...containment,
  ).toArray() as any[])
    .filter((l) => l.target_pattern === selfActive ? !rowActive(db, l.target_pattern, l.target_id) : !entryActive(db, l.target_pattern, l.target_id))
    .map((l) => ({ container: ref(l.target_pattern, l.target_id), label: l.label }));
}

function rowActive(db: DB, pattern: string, id: number): boolean {
  try { return db.exec(`SELECT 1 FROM ${quoteIdent(pattern)} WHERE id = ? AND archived_at IS NULL`, id).toArray().length > 0; } catch { return false; }
}

/** The first end-state violation among the touched entries, as an engine-authored
 *  refusal message — or null when the end state is sound.
 *  - required: an ACTIVE entry of a required relation's source pattern holds at
 *    least one active link of it (an archived entry is exempt while archived);
 *  - containment: an ARCHIVED entry is not the container of any active member,
 *    and an entry brought back (unarchived) is not a member of an inactive
 *    container. */
export function endStateViolations(db: DB, touched: Touched): string | null {
  if (!touched.size) return null;
  const rels = activeRelations(db);
  for (const [key, cause] of touched) {
    const at = parseEntryRef(key);
    if (!at || isKernelPattern(at.pattern)) continue;
    if (entryActive(db, at.pattern, at.id)) {
      for (const r of requiredFor(rels, at.pattern)) {
        if (holdsLink(db, at.pattern, at.id, r.name)) continue;
        const targets = r.target.join(", ");
        switch (cause) {
          case "link-removed":
            return `${key} must keep its "${r.name}" link to ${targets} (the relation is required). To change it, move it: archive this link and create the new one in the same batch.`;
          case "unarchived":
            return `${key} cannot be unarchived without a "${r.name}" link to ${targets} (the relation is required). Unarchive it and link it in the same batch.`;
          default:
            return `"${r.name}" is required for "${at.pattern}": every entry must hold one, to ${targets}. Create it with the link inline — _relate: {"${r.name}": "<${r.target[0] ?? "pattern"}>/<id>"} — or in the same batch.`;
        }
      }
      if (cause === "unarchived") {
        const under = inactiveContainers(db, rels, at.pattern, at.id);
        if (under.length) {
          const by = [...new Set(under.map((u) => u.label))].join(", ");
          return `"${by}" is a containment relation: ${key} can't be active while its container ${under.map((u) => u.container).join(", ")} is archived. Unarchive the container too (the same batch is fine), or move the member first.`;
        }
      }
    } else {
      const members = activeMembers(db, rels, at.pattern, at.id);
      if (members.length) {
        const by = [...new Set(members.map((m) => m.label))].join(", ");
        return `"${by}" is a containment relation: ${key} still contains active member(s) ${members.map((m) => m.member).join(", ")}. Archive or move the members first (the same batch is fine).`;
      }
    }
  }
  return null;
}

/** archive_pattern on a container: the active members in OTHER patterns that
 *  hold a containment link into the pattern's active entries. */
export function containmentHolders(db: DB, pattern: string): RelationViolation[] {
  const containment = relationsWith(db, "containment");
  if (!containment.length) return [];
  return (db.exec(
    `SELECT id, source_pattern, source_id, target_pattern, target_id, label FROM "_links"
     WHERE archived_at IS NULL AND target_pattern = ? AND source_pattern != ? AND label IN (${containment.map(() => "?").join(",")}) ORDER BY id`,
    pattern, pattern, ...containment,
  ).toArray() as any[])
    .filter((l) => entryActive(db, l.source_pattern, l.source_id) && entryActive(db, l.target_pattern, l.target_id))
    .map((l) => ({
      link_id: l.id, source: ref(l.source_pattern, l.source_id), target: ref(l.target_pattern, l.target_id), label: l.label,
      reason: `"${l.label}" is a containment relation: ${ref(l.source_pattern, l.source_id)} is an active member of ${ref(l.target_pattern, l.target_id)} — archive or move it first`,
    }));
}

/** unarchive_pattern: what the pattern's active entries would violate once the
 *  pattern is live again — members under an archived container (containment), and
 *  entries lacking the link of a required relation it is a source of. */
export function unarchivePatternViolations(db: DB, pattern: string): RelationViolation[] {
  if (typeof pattern !== "string") return [];
  const rels = activeRelations(db);
  const out: RelationViolation[] = [];
  let ids: number[] = [];
  try { ids = (db.exec(`SELECT id FROM ${quoteIdent(pattern)} WHERE archived_at IS NULL ORDER BY id`).toArray() as any[]).map((r) => r.id); } catch { return []; }
  for (const id of ids)
    for (const u of inactiveContainers(db, rels, pattern, id, pattern))
      out.push({ source: ref(pattern, id), target: u.container, label: u.label,
        reason: `"${u.label}" is a containment relation: ${ref(pattern, id)} would be active under its archived container ${u.container} — unarchive the container or move the member first` });
  for (const r of requiredFor(rels, pattern)) out.push(...lacking(db, { name: r.name, source: [pattern] }, pattern));
  return out;
}

/** Active source entries lacking a link of `relation` (if it were required).
 *  `includeArchived` judges a pattern that is archived now (an unarchive_pattern
 *  being judged before it applies). */
function lacking(db: DB, relation: Pick<Relation, "name" | "source">, includeArchived?: string): RelationViolation[] {
  const out: RelationViolation[] = [];
  for (const p of relation.source) {
    if (p === ANY) continue;
    if (p !== includeArchived && db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NULL`, p).toArray().length === 0) continue;
    let rows: { id: number }[];
    try { rows = db.exec(`SELECT id FROM ${quoteIdent(p)} WHERE archived_at IS NULL ORDER BY id`).toArray() as any[]; } catch { continue; }
    for (const { id } of rows)
      if (!holdsLink(db, p, id, relation.name))
        out.push({ source: ref(p, id), label: relation.name, reason: `${ref(p, id)} holds no "${relation.name}" link — backfill it before making the relation required` });
  }
  return out;
}

/** Boot input: every active entry lacking a link of an active required relation. */
export function requiredGaps(db: DB): { relation: string; entry: string }[] {
  return stored(activeRelations(db)).filter((r) => r.required)
    .flatMap((r) => lacking(db, r).map((v) => ({ relation: r.name, entry: v.source })));
}

/** Boot findings: one line per active entry missing a required link (pre-existing
 *  data). Pure and report-only — nothing is repaired. */
export function findRequiredGaps(gaps: { relation: string; entry: string }[]): string[] {
  return gaps.map((g) => `${g.entry} lacks a link of required relation "${g.relation}" — pre-existing data, left in place; link it (or archive the entry)`);
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
        `UPDATE "_relations" SET inverse = ?, description = ?, source = ?, target = ?, cardinality = 'many', behaviors = ?, required = 0, chain = NULL, kernel = 1, updated_at = datetime('now') WHERE id = ?
         AND (inverse != ? OR description != ? OR source != ? OR target != ? OR cardinality != 'many' OR behaviors != ? OR required != 0 OR chain IS NOT NULL OR kernel != 1)`,
        k.inverse, k.description, star, star, behaviors, row.id,
        k.inverse, k.description, star, star, behaviors,
      );
    } else {
      db.exec(
        `INSERT INTO "_relations" (name, inverse, description, source, target, cardinality, behaviors, kernel) VALUES (?, ?, ?, ?, ?, 'many', ?, 1)`,
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
      `INSERT INTO "_relations" (name, inverse, description, source, target, cardinality, behaviors, kernel) VALUES (?, ?, ?, ?, ?, 'many', '[]', 0)`,
      name, inverse, legacyPlaceholder(name),
      JSON.stringify([...ends.source].sort()), JSON.stringify([...ends.target].sort()),
    );
  }
}

/** Boot findings: one line per legacy relation, naming its remaining debt
 *  (e.g. `refines: generated inverse`). Pure, so the boot warning and any test
 *  read the same rule. */
export function findLegacyRelations(relations: Pick<Relation, "name" | "legacy_debt">[]): string[] {
  return relations.filter((r) => r.legacy_debt.length).map((r) =>
    `legacy relation ${r.name}: ${r.legacy_debt.join(", ")} — pay it with amend_relation (a real description; an owner-chosen inverse)`);
}

/** v18: legacy status became two derived facts (legacyDebt); the stored flag,
 *  which lied once a description amend cleared it, is dropped. Idempotent. */
function dropStoredLegacyFlag(db: DB): void {
  // Trigger-safe: a Phase 1 boot built _relations' audit triggers over `legacy`,
  // and SQLite refuses DROP COLUMN on a column a trigger names (the v18 failure).
  dropColumn(db, "_relations", "legacy");
  db.exec(`DELETE FROM _fields WHERE object_name = '_relations' AND name = 'legacy'`);
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
  // v18 is isolated: no later step reads or writes the stored flag (legacy is
  // derived, and every INSERT omits the column, which defaults), so a failed drop
  // must never skip the code-owned refresh, rewrite, sweep and declarations. It
  // fails LOUD instead — and, the column surviving, its restore point and this
  // warning recur on every boot until it succeeds.
  try { dropStoredLegacyFlag(db); }
  catch (err) { console.warn("[schema] relations v18 (drop the stored legacy flag) failed — the other relation steps still run", err); }
  seedKernelRelations(db);    // 1. kernel defaults (so supersedes etc. resolve below)
  rewriteLegacyLabels(db);    // 2. NULL → references; inverse wording → canonical
  sweepDanglingLinks(db);     // 3. gone or inadmissible endpoints (incl. ones the rewrite exposed)
  declareLegacyRelations(db); // 4. what remains undeclared becomes a legacy relation
}

// === Vocabulary evolution: declare / amend / retire ===

/** One active link that an amend or retire would strand. */
export interface RelationViolation { link_id?: number; source: string; target?: string; label: string; reason: string }

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

function checkHandle(kind: "name" | "inverse", value: unknown, taken: Map<string, string>, forName?: string): string | null {
  if (typeof value !== "string" || !value) return `${kind} is required for a relation`;
  if (value.startsWith("_")) return `Relation ${kind} "${value}" is reserved — names starting with "_" belong to the kernel.`;
  if (!NAME_RE.test(value)) return `Relation ${kind} "${value}" must be kebab-case: lowercase letters and digits joined by single hyphens (e.g. "cites", "cited-by").`;
  const owner = taken.get(value);
  if (owner) return `Relation ${kind} "${value}" is already taken by the active relation "${owner}" (names and inverses share one vocabulary).`;
  // The migration's generated form is reserved, so an owner-chosen inverse never
  // reads as legacy debt and a relation declared from scratch is never legacy.
  if (kind === "inverse" && typeof forName === "string" && isGeneratedInverse(forName, value))
    return `Inverse "${value}" is reserved: the form "${forName}-inverse" is what the legacy migration generates. Choose how the relation reads from the target's side (e.g. "cited-by").`;
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
    if (!ctx.patternExists(p)) {
      const archived = ctx.db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NOT NULL`, p).toArray().length > 0;
      return `${end} names pattern "${p}", which ${archived ? "is archived — unarchive it first" : "does not exist"}.`;
    }
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
  if (change.cardinality !== undefined && !(CARDINALITIES as readonly string[]).includes(change.cardinality))
    return `cardinality must be "one" or "many", got ${JSON.stringify(change.cardinality)}.`;
  if (change.behaviors !== undefined) {
    if (!Array.isArray(change.behaviors)) return `behaviors must be an array, a subset of: ${Object.keys(BEHAVIOR_PALETTE).join(", ")}.`;
    for (const b of change.behaviors)
      if (!isBehavior(b)) return `Unknown behavior "${b}". The palette: ${Object.keys(BEHAVIOR_PALETTE).join(", ")}.`;
  }
  if (change.required !== undefined && typeof change.required !== "boolean")
    return `required must be true or false, got ${JSON.stringify(change.required)}.`;
  return null;
}

/** A required relation needs an explicit source list: "every entry of a listed
 *  source pattern holds one" means nothing over `*`. */
function checkRequired(db: DB, required: unknown, source: string[]): string | null {
  if (required !== true) return null;
  if (source.includes(ANY) || !source.length)
    return `A required relation needs an explicit source list (not "*"): name the source patterns whose every entry must hold one.`;
  // An archived source pattern's entries can't be linked, so they could never be
  // backfilled: refuse rather than deadlock. Unarchive, backfill, then flip.
  const archived = source.filter((p) => db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NOT NULL`, p).toArray().length > 0);
  return archived.length
    ? `required can't be set while source pattern ${archived.map((p) => `"${p}"`).join(", ")} is archived — its entries can't be linked to backfill. Unarchive it, backfill the links, then make the relation required.`
    : null;
}

/** Does a link that ENDS at `targets` compose with one that STARTS at `sources`?
 *  `*` matches any user pattern. */
function composes(targets: string[], sources: string[]): boolean {
  const users = (l: string[]) => l.filter((p) => p !== ANY && !isKernelPattern(p));
  if (targets.includes(ANY)) return sources.includes(ANY) || users(sources).length > 0;
  if (sources.includes(ANY)) return users(targets).length > 0;
  return targets.some((p) => sources.includes(p));
}

/** Fields a derived relation never declares: its ends come from its steps, and a
 *  computed connection has no cardinality, behavior or requirement of its own. */
const CHAIN_EXCLUDES = ["source", "target", "cardinality", "behaviors", "required"] as const;

function checkChain(rels: Relation[], change: any): string | null {
  for (const f of CHAIN_EXCLUDES)
    if (change[f] !== undefined)
      return `A derived relation (chain) declares no ${f}: its ends are its first step's source and its last step's target, and it is computed, never stored. Remove "${f}".`;
  const chain = change.chain;
  if (!Array.isArray(chain) || chain.length < 2 || !chain.every((x) => typeof x === "string"))
    return `A chain is a list of at least two stored relation names, composed in order (e.g. ["belongs-to", "serves"]).`;
  const steps: Relation[] = [];
  for (const name of chain) {
    const step = rels.find((r) => r.name === name);
    if (!step) return `Chain step "${name}" is not an active relation (name it canonically, not by its inverse).`;
    if (step.derived) return `Chain step "${name}" is itself derived — a chain composes stored relations only.`;
    steps.push(step);
  }
  for (let i = 0; i + 1 < steps.length; i++)
    if (!composes(steps[i].target, steps[i + 1].source))
      return `Chain steps "${steps[i].name}" → "${steps[i + 1].name}" do not compose: "${steps[i].name}" ends at ${steps[i].target.join(", ")} but "${steps[i + 1].name}" starts at ${steps[i + 1].source.join(", ")}.`;
  return null;
}

/** The relation a declare_relation change would create (ends of a chain read off
 *  its steps in `rels`). */
export function declaredRelation(change: any, rels: Relation[] = []): Relation {
  const chain = Array.isArray(change.chain) ? (change.chain as string[]) : null;
  const byName = new Map(rels.map((r) => [r.name, r]));
  return {
    name: change.name,
    inverse: change.inverse,
    description: change.description,
    source: chain ? [...(byName.get(chain[0])?.source ?? [])] : normList(change.source) ?? [],
    target: chain ? [...(byName.get(chain[chain.length - 1])?.target ?? [])] : normList(change.target) ?? [],
    cardinality: change.cardinality === "one" ? "one" : "many",
    behaviors: [...new Set<string>(change.behaviors ?? [])],
    required: change.required === true,
    derived: chain != null,
    ...(chain ? { chain } : {}),
    kernel: false,
    legacy: false,
    legacy_debt: [],
  };
}

/** The relation an amend_relation change would leave (legacy debt re-derived). */
export function amendedRelation(current: Relation, change: any): Relation {
  const next: Relation = {
    ...current,
    ...(change.inverse !== undefined ? { inverse: change.inverse } : {}),
    ...(change.description !== undefined ? { description: change.description } : {}),
    ...(change.cardinality !== undefined ? { cardinality: change.cardinality } : {}),
    ...(change.behaviors !== undefined ? { behaviors: [...new Set<string>(change.behaviors)] } : {}),
    ...(change.required !== undefined ? { required: change.required === true } : {}),
  };
  next.legacy_debt = legacyDebt(next);
  next.legacy = next.legacy_debt.length > 0;
  return next;
}

export function validateDeclare(ctx: RelationsContext, change: any): string | null {
  const rels = activeRelations(ctx.db);
  const taken = vocabulary(rels);
  const handles = checkNoNulls(change)
    ?? checkHandle("name", change.name, taken)
    ?? checkHandle("inverse", change.inverse, taken, change.name)
    ?? (change.inverse === change.name ? `The inverse must differ from the name "${change.name}".` : null)
    ?? checkDescription(change.description, [change.name, change.inverse]);
  if (handles) return handles;
  if (change.chain !== undefined) return checkChain(rels, change);
  return checkEnd(ctx, "source", change.source)
    ?? checkEnd(ctx, "target", change.target)
    ?? checkShape(change)
    ?? checkRequired(ctx.db, change.required, normList(change.source) ?? []);
}

const AMENDABLE = ["description", "inverse", "behaviors", "cardinality", "required"] as const;

export function validateAmend(ctx: RelationsContext, change: any): string | null {
  const current = activeRelation(ctx.db, change.name);
  if (!current) return `No active relation named ${JSON.stringify(change.name)} to amend. Read ${uri("relations")} for the vocabulary.`;
  if (current.kernel) return `"${current.name}" is a kernel default — its meaning is owned by code and cannot be amended. Declare a new relation instead.`;
  const nulls = checkNoNulls(change);
  if (nulls) return nulls;
  if (change.new_name !== undefined) return `A relation's name is immutable ("${current.name}"). Declare a new relation and move the links to it instead.`;
  for (const f of ["source", "target", "chain"] as const)
    if (change[f] !== undefined) return `A relation's ${f} is not amendable. Declare a new relation with the ${f} you need.`;
  if (current.derived)
    for (const f of ["behaviors", "cardinality", "required"] as const)
      if (change[f] !== undefined) return `"${current.name}" is derived (a chain): it has no ${f} to amend — only description and inverse.`;
  if (!AMENDABLE.some((f) => change[f] !== undefined)) return `amend_relation changes at least one of: ${AMENDABLE.join(", ")}.`;
  const next = amendedRelation(current, change);
  if (change.inverse !== undefined) {
    const err = checkHandle("inverse", change.inverse, vocabulary(activeRelations(ctx.db), current.name), current.name)
      ?? (change.inverse === current.name ? `The inverse must differ from the name "${current.name}".` : null);
    if (err) return err;
  }
  if (change.description !== undefined) {
    const err = checkDescription(change.description, [next.name, next.inverse]);
    if (err) return err;
  }
  return checkShape(change) ?? checkRequired(ctx.db, change.required, current.source);
}

export function validateRetire(ctx: RelationsContext, change: any): string | null {
  const rels = activeRelations(ctx.db);
  const current = rels.find((r) => r.name === change.name);
  if (!current) return `No active relation named ${JSON.stringify(change.name)} to retire.`;
  if (current.kernel) return `"${current.name}" is a kernel default and cannot be retired.`;
  const chains = rels.filter((r) => r.chain?.includes(current.name)).map((r) => r.name);
  if (chains.length) return `"${current.name}" is a step of the derived relation(s) ${chains.join(", ")} — retire ${chains.length > 1 ? "those chains" : "that chain"} first.`;
  return null;
}

/** A declare with `required: true` strands every active source entry with no link
 *  (a new relation has none yet). */
export function declareViolations(db: DB, change: any): RelationViolation[] {
  if (change.required !== true || change.chain !== undefined) return [];
  const source = normList(change.source) ?? [];
  if (source.includes(ANY)) return [];
  return lacking(db, { name: change.name, source });
}

/** Active links the amended relation would no longer admit: a second link from
 *  one source under cardinality one, a link on a cycle under acyclic, or an
 *  active source entry with no link once the relation is required. */
export function amendViolations(db: DB, change: any): RelationViolation[] {
  const current = activeRelation(db, change.name);
  if (!current || current.derived) return [];
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
  if (next.required && !next.source.includes(ANY)) out.push(...lacking(db, next));
  if (next.behaviors.includes("containment") && !current.behaviors.includes("containment")) {
    for (const l of links)
      if (entryActive(db, l.source_pattern, l.source_id) && !entryActive(db, l.target_pattern, l.target_id))
        out.push(v(l, `${ref(l.source_pattern, l.source_id)} is an active member of the archived container ${ref(l.target_pattern, l.target_id)}`));
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
  // A chain stores no ends (they are read off its steps); "[]" admits nothing.
  ctx.db.exec(
    `INSERT INTO "_relations" (name, inverse, description, source, target, cardinality, behaviors, required, chain, kernel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    r.name, r.inverse, r.description,
    JSON.stringify(r.chain ? [] : r.source), JSON.stringify(r.chain ? [] : r.target),
    r.cardinality, JSON.stringify(r.behaviors), r.required ? 1 : 0, r.chain ? JSON.stringify(r.chain) : null,
  );
}

export function amendRelation(ctx: RelationsContext, change: any): void {
  const err = validateAmend(ctx, change);
  if (err) throw new Error(err);
  const next = amendedRelation(activeRelation(ctx.db, change.name)!, change);
  ctx.db.exec(
    `UPDATE "_relations" SET inverse = ?, description = ?, cardinality = ?, behaviors = ?, required = ?, version = version + 1, updated_at = datetime('now')
     WHERE name = ? AND archived_at IS NULL`,
    next.inverse, next.description, next.cardinality, JSON.stringify(next.behaviors), next.required ? 1 : 0, next.name,
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
