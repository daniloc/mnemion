// Single source of truth for "what does this entry look like as a string."
//
// Used by both the backend (so /api/index can include a stable label) and the
// frontend Svelte components (Canvas, SchemaViewer, LinkMap). If the algorithm
// ever needs to evolve, change it here once.
//
// @why One deriveLabel so the backend (/api/index) and the frontend Svelte
// components render an entry's label identically. The label is computed
// everywhere it's needed, never persisted, per data-is-destiny (store truth
// once, derive its consequences) — one algorithm, one place to evolve it.

export interface LabelFacet {
  name: string;
  type: string;
}

const LABEL_KEYS = ["name", "title", "label", "key", "context"] as const;

/**
 * Derive a human-readable label for an entry. Returns the unbounded string;
 * callers truncate to fit their UI.
 *
 * Priority:
 *   1. First non-empty value among LABEL_KEYS (name, title, label, key, context).
 *   2. First text-type facet's value.
 *   3. Falls back to "#{id}" if neither is available.
 */
export function deriveLabel(entry: Record<string, unknown>, facets: LabelFacet[]): string {
  for (const key of LABEL_KEYS) {
    const v = entry[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const firstText = facets.find((f) => f.type === "text");
  if (firstText) {
    const v = entry[firstText.name];
    if (v != null && v !== "") return String(v);
  }
  return `#${entry.id ?? "?"}`;
}

/**
 * Truncate a string to `max` chars, appending an ellipsis if truncated.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}
