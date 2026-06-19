// One XML/HTML text escaper, shared by every string-built markup surface — the
// server SVG charts (chart-svg.ts), the server-rendered pages (hive.ts), and the
// publication renderers (shared/IO/publications.ts) — so the three can't drift
// (they previously had three near-identical copies, one of which escaped `'` and
// two of which didn't). Escapes the superset, safe in both text and double-quoted
// attribute contexts. Pure, no deps.
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
