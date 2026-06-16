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
`;
