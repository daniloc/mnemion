// Auto-associative priming layer
//
// Partial cue → full constellation. Embeds entries on write via Workers AI,
// queries Vectorize for semantic nearest neighbors, follows links one hop.
//
// Pure functions with env/db injected. HiveDO wires the lifecycle.

import { uri } from "./constants";
import { isKernelPattern } from "./policy";

// === Types ===

export interface PrimeContext {
  env: { AI: any; VECTORIZE: any };
  db: any;
  patternExists(name: string): boolean;
}

export interface PrimeResult {
  pattern: string;
  id: number;
  relevance: number;
  raw_similarity?: number;
  superseded_by?: string;
  entry: Record<string, unknown>;
  uri: string;
  linked?: { pattern: string; id: number; entry: Record<string, unknown>; uri: string }[];
}

export interface MemoryPolicy {
  half_life_days: number | null;
  conflict_check: "annotate" | "off";
  exclusive_facets: string[];
}

// === Constants ===

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const MAX_EMBED_CHARS = 2000; // ~500 tokens, within model's 512-token limit
const SUPERSEDED_DEMOTION = 0.3; // explicit owner intent — always applied
const DECAY_FLOOR = 0.05; // old-but-relevant can still surface
export const CONFLICT_SIMILARITY = 0.8; // same-pattern KNN threshold for possible_overlap

// === Pattern class ===

/** A pattern's class: "knowledge" (default — recalled by meaning) or "dataset"
 *  (structured records aggregated by computation, exempt from the memory machinery). */
export function getPatternClass(db: any, pattern: string): "knowledge" | "dataset" {
  try {
    const rows = db.exec("SELECT pattern_class FROM _objects WHERE name = ?", pattern).toArray() as any[];
    return rows[0]?.pattern_class === "dataset" ? "dataset" : "knowledge";
  } catch {
    return "knowledge";
  }
}

/** All dataset-class pattern names. Used to keep records out of semantic recall. */
function datasetPatterns(db: any): Set<string> {
  try {
    const rows = db.exec("SELECT name FROM _objects WHERE pattern_class = 'dataset'").toArray() as any[];
    return new Set(rows.map((r: any) => r.name as string));
  } catch {
    return new Set();
  }
}

// === Memory policy ===

/** Read a pattern's memory policy from _objects, applying opinionated defaults. */
export function getMemoryPolicy(db: any, pattern: string): MemoryPolicy {
  const defaults: MemoryPolicy = { half_life_days: null, conflict_check: "annotate", exclusive_facets: [] };
  try {
    const rows = db.exec("SELECT memory_policy FROM _objects WHERE name = ?", pattern).toArray() as any[];
    if (rows.length === 0 || !rows[0].memory_policy) return defaults;
    const parsed = JSON.parse(rows[0].memory_policy);
    return {
      half_life_days: typeof parsed.half_life_days === "number" && parsed.half_life_days > 0 ? parsed.half_life_days : null,
      conflict_check: parsed.conflict_check === "off" ? "off" : "annotate",
      exclusive_facets: Array.isArray(parsed.exclusive_facets) ? parsed.exclusive_facets.filter((f: unknown) => typeof f === "string") : [],
    };
  } catch {
    return defaults;
  }
}

// === Decay ===

/** Recall-weight multiplier: halves per half-life elapsed, floored so old-but-relevant survives. */
export function decayMultiplier(ageDays: number, halfLifeDays: number | null): number {
  if (halfLifeDays == null || halfLifeDays <= 0) return 1;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.max(DECAY_FLOOR, Math.pow(0.5, ageDays / halfLifeDays));
}

// === Embedding ===

/** Build embeddable text from an entry's text/select facets. */
export function buildEmbedText(db: any, pattern: string, entry: Record<string, unknown>): string {
  // Get text and select facets for this pattern
  const facets = db.exec(
    "SELECT name FROM _fields WHERE object_name = ? AND type IN ('text', 'select') ORDER BY id",
    pattern
  ).toArray() as { name: string }[];

  const parts: string[] = [pattern];
  for (const f of facets) {
    const val = entry[f.name];
    if (val != null && typeof val === "string" && val.length > 0) {
      parts.push(val);
    }
  }

  return parts.join(". ").slice(0, MAX_EMBED_CHARS);
}

/** Generate embedding vector for text. Returns null if AI unavailable. */
async function embed(env: { AI: any }, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const result = await env.AI.run(EMBED_MODEL, { text: [text] });
    return result?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Vector ID format: pattern:id */
function vectorId(pattern: string, id: number): string {
  return `${pattern}:${id}`;
}

// === Write-path: embed + upsert ===

/** Embed an entry and upsert its vector. Fire-and-forget safe.
 *  A precomputed vector (e.g. from the write-time conflict check) skips the AI call. */
export async function embedEntry(ctx: PrimeContext, pattern: string, id: number, precomputed?: number[]): Promise<void> {
  if (!ctx.env.VECTORIZE) return;

  let values = precomputed ?? null;
  if (!values) {
    if (!ctx.env.AI) return;

    // Read the entry
    let entry: Record<string, unknown>;
    try {
      const rows = ctx.db.exec(`SELECT * FROM "${pattern}" WHERE id = ?`, id).toArray();
      if (rows.length === 0) return;
      entry = rows[0] as Record<string, unknown>;
    } catch { return; }

    const text = buildEmbedText(ctx.db, pattern, entry);
    values = await embed(ctx.env, text);
    if (!values) return;
  }

  try {
    await ctx.env.VECTORIZE.upsert([{
      id: vectorId(pattern, id),
      values,
      metadata: { pattern, entry_id: id },
    }]);
  } catch { /* best-effort */ }
}

// === Write-path: conflict surfacing ===

export interface NeighborMatch {
  pattern: string;
  id: number;
  uri: string;
  similarity: number;
}

/** Find same-pattern semantic neighbors of not-yet-written entry data.
 *  Returns matches ≥ CONFLICT_SIMILARITY plus the computed vector (reusable for
 *  the post-write upsert, avoiding a second AI call). Best-effort: any failure
 *  returns empty with no vector. */
export async function findNeighbors(
  ctx: PrimeContext,
  pattern: string,
  data: Record<string, unknown>,
): Promise<{ neighbors: NeighborMatch[]; vector: number[] | null }> {
  if (!ctx.env.AI || !ctx.env.VECTORIZE) return { neighbors: [], vector: null };

  const text = buildEmbedText(ctx.db, pattern, data);
  const vector = await embed(ctx.env, text);
  if (!vector) return { neighbors: [], vector: null };

  try {
    const matches = await ctx.env.VECTORIZE.query(vector, { topK: 5, returnMetadata: "all" });
    const neighbors: NeighborMatch[] = [];
    for (const m of matches?.matches ?? []) {
      if (m.score < CONFLICT_SIMILARITY) continue;
      if (m.metadata?.pattern !== pattern) continue;
      const id = m.metadata?.entry_id as number;
      if (id == null) continue;
      // Only surface live entries
      const rows = ctx.db.exec(
        `SELECT id FROM "${pattern}" WHERE id = ? AND archived_at IS NULL`, id
      ).toArray();
      if (rows.length === 0) continue;
      neighbors.push({
        pattern,
        id,
        uri: uri(`entry/${pattern}/${id}`),
        similarity: Math.round(m.score * 100) / 100,
      });
    }
    return { neighbors, vector };
  } catch {
    return { neighbors: [], vector };
  }
}

/** Remove a vector when an entry is archived. */
export async function removeEntry(ctx: PrimeContext, pattern: string, id: number): Promise<void> {
  if (!ctx.env.VECTORIZE) return;
  try {
    await ctx.env.VECTORIZE.deleteByIds([vectorId(pattern, id)]);
  } catch { /* best-effort */ }
}

// === Read-path: prime ===

/** Prime: partial cue activates a full constellation. */
export async function prime(
  ctx: PrimeContext,
  context: string,
  patterns?: string[],
  limit: number = 5,
): Promise<{ results: PrimeResult[]; count: number }> {
  if (!ctx.env.AI || !ctx.env.VECTORIZE) {
    return { results: [], count: 0 };
  }

  // Embed the cue
  const queryVector = await embed(ctx.env, context.slice(0, MAX_EMBED_CHARS));
  if (!queryVector) return { results: [], count: 0 };

  // Query Vectorize (topK capped at 20 when returning metadata). Best-effort:
  // a failing index degrades recall to empty, never breaks the prime response.
  const topK = Math.min(limit, 20);
  let matches: { matches?: { id: string; score: number; metadata?: Record<string, unknown> }[] };
  try {
    matches = await ctx.env.VECTORIZE.query(queryVector, {
      topK,
      returnMetadata: "all",
    });
  } catch {
    return { results: [], count: 0 };
  }

  if (!matches?.matches?.length) return { results: [], count: 0 };

  // Filter results. Dataset-class patterns are excluded either way — they hold
  // records aggregated by query, not memory recalled by meaning, and surfacing
  // their near-identical rows would only drown out knowledge. (They're also not
  // embedded on write, so this only matters for a pattern flipped after the fact.)
  const datasets = datasetPatterns(ctx.db);
  let filtered = matches.matches.filter((m: any) => !datasets.has(m.metadata?.pattern));
  if (patterns?.length) {
    // Explicit pattern filter — include exactly what was requested
    const allowed = new Set(patterns);
    filtered = filtered.filter((m: any) => allowed.has(m.metadata?.pattern));
  } else {
    // Default: exclude kernel patterns (system noise) but keep working memory
    const KERNEL_INCLUDE = new Set(["_short_term_fragments", "_long_term_fragments", "_documents"]);
    filtered = filtered.filter((m: any) => {
      const p = m.metadata?.pattern as string;
      return p && (!isKernelPattern(p) || KERNEL_INCLUDE.has(p));
    });
  }

  // Resolve each match to a full entry + one-hop links
  const results: PrimeResult[] = [];
  for (const match of filtered) {
    const pattern = match.metadata?.pattern as string;
    const entryId = match.metadata?.entry_id as number;
    if (!pattern || entryId == null) continue;
    if (!ctx.patternExists(pattern)) continue;

    let entry: Record<string, unknown>;
    try {
      const rows = ctx.db.exec(
        `SELECT * FROM "${pattern}" WHERE id = ? AND archived_at IS NULL`, entryId
      ).toArray();
      if (rows.length === 0) continue;
      entry = rows[0] as Record<string, unknown>;
    } catch { continue; }

    const result: PrimeResult = {
      pattern,
      id: entryId,
      relevance: Math.round(match.score * 100) / 100,
      raw_similarity: Math.round(match.score * 100) / 100,
      entry,
      uri: uri(`entry/${pattern}/${entryId}`),
    };

    // One-hop link following
    const linked = followLinks(ctx, pattern, entry);
    if (linked.length > 0) result.linked = linked;

    results.push(result);
  }

  // Weighting pass: supersession demotion + per-pattern decay, derived at read time
  const policyCache = new Map<string, MemoryPolicy>();
  for (const r of results) {
    let weight = 1;

    // Superseded entries are demoted, not hidden — the chain stays navigable
    try {
      const sup = ctx.db.exec(
        `SELECT source_pattern, source_id FROM "_links" WHERE label = 'supersedes' AND archived_at IS NULL AND target_pattern = ? AND target_id = ? LIMIT 1`,
        r.pattern, r.id
      ).toArray() as { source_pattern: string; source_id: number }[];
      if (sup.length > 0) {
        r.superseded_by = uri(`entry/${sup[0].source_pattern}/${sup[0].source_id}`);
        weight *= SUPERSEDED_DEMOTION;
      }
    } catch { /* _links may not exist yet */ }

    // Decay: last_touch = max(updated_at, latest prime hit) — recall is rehearsal
    if (!policyCache.has(r.pattern)) policyCache.set(r.pattern, getMemoryPolicy(ctx.db, r.pattern));
    const policy = policyCache.get(r.pattern)!;
    if (policy.half_life_days != null) {
      weight *= decayMultiplier(entryAgeDays(ctx.db, r.pattern, r.id, r.entry), policy.half_life_days);
    }

    if (weight < 1) {
      r.relevance = Math.round(r.relevance * weight * 100) / 100;
    }
  }
  results.sort((a, b) => b.relevance - a.relevance);

  return { results, count: results.length };
}

/** Days since the entry was last touched: updated_at or its latest prime hit, whichever is later. */
function entryAgeDays(db: any, pattern: string, id: number, entry: Record<string, unknown>): number {
  let lastTouch = parseDbDate(entry.updated_at as string | undefined);
  try {
    const rows = db.exec(
      `SELECT MAX(accessed_at) as a FROM "_entry_access_log" WHERE pattern = ? AND entry_id = ?`,
      pattern, id
    ).toArray() as { a: string | null }[];
    const access = parseDbDate(rows[0]?.a ?? undefined);
    if (access != null && (lastTouch == null || access > lastTouch)) lastTouch = access;
  } catch { /* log may not exist yet */ }
  if (lastTouch == null) return 0;
  return (Date.now() - lastTouch) / 86_400_000;
}

/** SQLite datetime('now') emits "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker — parse as UTC. */
export function parseDbDate(s: string | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Follow foreign key links one hop from an entry. */
export function followLinks(
  ctx: PrimeContext,
  pattern: string,
  entry: Record<string, unknown>,
): { pattern: string; id: number; entry: Record<string, unknown>; uri: string; label?: string }[] {
  const linked: { pattern: string; id: number; entry: Record<string, unknown>; uri: string; label?: string }[] = [];
  const seen = new Set<string>();

  // 1. Schema-level foreign key references (single-value facets)
  const refs = ctx.db.exec(
    "SELECT name, references_object FROM _fields WHERE object_name = ? AND references_object IS NOT NULL",
    pattern
  ).toArray() as { name: string; references_object: string }[];

  for (const ref of refs) {
    const targetId = entry[ref.name];
    if (targetId == null) continue;
    const targetPattern = ref.references_object;
    if (!ctx.patternExists(targetPattern)) continue;
    const key = `${targetPattern}:${targetId}`;
    if (seen.has(key)) continue;

    try {
      const rows = ctx.db.exec(
        `SELECT * FROM "${targetPattern}" WHERE id = ? AND archived_at IS NULL`,
        Number(targetId)
      ).toArray();
      if (rows.length > 0) {
        seen.add(key);
        linked.push({
          pattern: targetPattern,
          id: Number(targetId),
          entry: rows[0] as Record<string, unknown>,
          uri: uri(`entry/${targetPattern}/${targetId}`),
        });
      }
    } catch { /* target table may not exist */ }
  }

  // 2. _links table (many-to-many, bidirectional)
  const entryId = entry.id as number;
  if (entryId != null) {
    try {
      const linkRows = ctx.db.exec(
        `SELECT target_pattern, target_id, label FROM "_links" WHERE source_pattern = ? AND source_id = ? AND archived_at IS NULL
         UNION ALL
         SELECT source_pattern, source_id, label FROM "_links" WHERE target_pattern = ? AND target_id = ? AND archived_at IS NULL`,
        pattern, entryId, pattern, entryId
      ).toArray() as { target_pattern: string; target_id: number; label: string | null }[];

      for (const link of linkRows) {
        const key = `${link.target_pattern}:${link.target_id}`;
        if (seen.has(key)) continue;
        if (!ctx.patternExists(link.target_pattern)) continue;

        try {
          const rows = ctx.db.exec(
            `SELECT * FROM "${link.target_pattern}" WHERE id = ? AND archived_at IS NULL`,
            link.target_id
          ).toArray();
          if (rows.length > 0) {
            seen.add(key);
            linked.push({
              pattern: link.target_pattern,
              id: link.target_id,
              entry: rows[0] as Record<string, unknown>,
              uri: uri(`entry/${link.target_pattern}/${link.target_id}`),
              label: link.label || undefined,
            });
          }
        } catch { /* target table may not exist */ }
      }
    } catch { /* _links table may not exist yet */ }
  }

  return linked;
}
