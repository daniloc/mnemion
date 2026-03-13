// Auto-associative priming layer
//
// Partial cue → full constellation. Embeds entries on write via Workers AI,
// queries Vectorize for semantic nearest neighbors, follows links one hop.
//
// Pure functions with env/db injected. HiveDO wires the lifecycle.

import { uri } from "./constants";

// === Types ===

export interface PrimeContext {
  env: { AI: any; VECTORIZE: any };
  db: any;
  patternExists(name: string): boolean;
}

export interface PrimeResult {
  pattern: string;
  id: number;
  score: number;
  entry: Record<string, unknown>;
  uri: string;
  linked?: { pattern: string; id: number; entry: Record<string, unknown>; uri: string }[];
}

// === Constants ===

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const MAX_EMBED_CHARS = 2000; // ~500 tokens, within model's 512-token limit

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

/** Embed an entry and upsert its vector. Fire-and-forget safe. */
export async function embedEntry(ctx: PrimeContext, pattern: string, id: number): Promise<void> {
  if (!ctx.env.AI || !ctx.env.VECTORIZE) return;

  // Read the entry
  let entry: Record<string, unknown>;
  try {
    const rows = ctx.db.exec(`SELECT * FROM "${pattern}" WHERE id = ?`, id).toArray();
    if (rows.length === 0) return;
    entry = rows[0] as Record<string, unknown>;
  } catch { return; }

  const text = buildEmbedText(ctx.db, pattern, entry);
  const values = await embed(ctx.env, text);
  if (!values) return;

  try {
    await ctx.env.VECTORIZE.upsert([{
      id: vectorId(pattern, id),
      values,
      metadata: { pattern, entry_id: id },
    }]);
  } catch { /* best-effort */ }
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

  // Query Vectorize (topK capped at 20 when returning metadata)
  const topK = Math.min(limit, 20);
  const matches = await ctx.env.VECTORIZE.query(queryVector, {
    topK,
    returnMetadata: "all",
  });

  if (!matches?.matches?.length) return { results: [], count: 0 };

  // Filter results
  let filtered = matches.matches;
  if (patterns?.length) {
    // Explicit pattern filter — include exactly what was requested
    const allowed = new Set(patterns);
    filtered = filtered.filter((m: any) => allowed.has(m.metadata?.pattern));
  } else {
    // Default: exclude kernel patterns (system noise, not working memory)
    filtered = filtered.filter((m: any) => {
      const p = m.metadata?.pattern as string;
      return p && !p.startsWith("_");
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
      score: match.score,
      entry,
      uri: uri(`entry/${pattern}/${entryId}`),
    };

    // One-hop link following
    const linked = followLinks(ctx, pattern, entry);
    if (linked.length > 0) result.linked = linked;

    results.push(result);
  }

  return { results, count: results.length };
}

/** Follow foreign key links one hop from an entry. */
export function followLinks(
  ctx: PrimeContext,
  pattern: string,
  entry: Record<string, unknown>,
): { pattern: string; id: number; entry: Record<string, unknown>; uri: string }[] {
  // Find facets with foreign key references
  const refs = ctx.db.exec(
    "SELECT name, references_object FROM _fields WHERE object_name = ? AND references_object IS NOT NULL",
    pattern
  ).toArray() as { name: string; references_object: string }[];

  const linked: { pattern: string; id: number; entry: Record<string, unknown>; uri: string }[] = [];

  for (const ref of refs) {
    const targetId = entry[ref.name];
    if (targetId == null) continue;
    const targetPattern = ref.references_object;
    if (!ctx.patternExists(targetPattern)) continue;

    try {
      const rows = ctx.db.exec(
        `SELECT * FROM "${targetPattern}" WHERE id = ? AND archived_at IS NULL`,
        Number(targetId)
      ).toArray();
      if (rows.length > 0) {
        linked.push({
          pattern: targetPattern,
          id: Number(targetId),
          entry: rows[0] as Record<string, unknown>,
          uri: uri(`entry/${targetPattern}/${targetId}`),
        });
      }
    } catch { /* target table may not exist */ }
  }

  return linked;
}
