// Single source of truth for the MCP Apps fragment styles. Shared by the
// production resource shell (session.ts) and the local preview (render-preview),
// so the browser preview looks exactly like what ships. Pure string, no DOM —
// safe to import into the worker.
export const FRAGMENT_CSS = `
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;margin:0;padding:12px}
/* horizontal scroll for wide entry tables (many facets) */
#root{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}
/* long prose cells stay one line + ellipsis (values are pre-truncated too) */
td{max-width:44ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{font-weight:600;opacity:.65;font-size:11px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
th.r,td.r{text-align:right;font-variant-numeric:tabular-nums}
.title{font-weight:600;margin-bottom:8px;font-size:15px}
.msg{opacity:.6;font-size:13px;white-space:pre-wrap}
/* cards: one entry per card, facets as labeled fields — for reading prose */
.cards{display:flex;flex-direction:column;gap:10px}
.card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;padding:10px 12px}
.card-h{font-weight:600;font-size:14px;margin-bottom:6px}
.field{display:grid;grid-template-columns:minmax(64px,max-content) 1fr;gap:10px;font-size:13px;padding:2px 0;align-items:baseline}
.field .k{opacity:.55;text-transform:lowercase;letter-spacing:.02em}
.field .v{white-space:pre-wrap;overflow-wrap:anywhere}
.card-m{opacity:.5;font-size:11px;margin-top:7px}
`;
