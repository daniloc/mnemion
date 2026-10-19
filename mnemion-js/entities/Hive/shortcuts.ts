// Mutate shortcuts — kernel-level aliases for common operations.
//
// @why One table every surface expands through: mutate(), batchMutate, and the
// MCP consent gate (mutate-gate.ts). A pure leaf (no imports), so the gate can
// judge EXPANDED items — a shortcut naming a consent-gated pattern is gated like
// that pattern — without depending on kernel.ts and everything it composes.

export interface Shortcut { pattern: string; operation: string }

export const SHORTCUTS: Record<string, Shortcut> = {
  fragment: { pattern: "_short_term_fragments", operation: "create" },
  link:     { pattern: "_links", operation: "create" },
  unlink:   { pattern: "_links", operation: "unlink" },
};

/** Expand a shortcut name to pattern + operation, or return null if not a shortcut. */
export function expandShortcut(name: string): Shortcut | null {
  return Object.prototype.hasOwnProperty.call(SHORTCUTS, name) ? SHORTCUTS[name] : null;
}
