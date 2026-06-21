// Local MCP smoke test — drives the REAL agent surface (/mcp tool protocol:
// OAuth token → SessionDO → McpServer → Zod schemas → consent gate → HiveDO)
// against the running `wrangler dev` worker. NOT the production hive.
//
//   npm run dev                                 # worker on :4281 (new code + seed)
//   TOK=$(curl -s -XPOST localhost:4281/api/mutate/_access_tokens \
//        -H 'content-type: application/json' \
//        -d '{"operation":"create","data":{"scope":"*"}}' | node -e '…token…')
//   MCP_TOKEN=$TOK node scripts/mcp-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL || "http://localhost:4281/mcp");
const origin = url.origin;

// A `*`-scoped _access_tokens row doubles as an MCP bearer (the OAuth external-
// token path). Mint one from the local hive if none was provided — so the smoke
// is a single command against a running `npm run dev`.
async function mintToken() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN.trim();
  const res = await fetch(`${origin}/api/mutate/_access_tokens`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create", data: { scope: "*", label: "mcp-smoke" } }),
  });
  const j = await res.json();
  const tok = j?.entry?.token;
  if (!tok) throw new Error(`could not mint token (is the dev worker up at ${origin}? is it DEV mode?)`);
  return tok;
}
const token = await mintToken();
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "mcp-smoke", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
const txt = (r) => (r.content || []).map((c) => c.text).join("\n");
function ok(label, cond, detail) {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  if (detail) console.log(`    ${String(detail).replace(/\n/g, " ").slice(0, 180)}`);
  if (!cond) failures++;
}

// tools/list
const { tools } = await client.listTools();
ok("tools/list returns the agent toolset", ["mutate", "propose_change", "apply_change", "query"].every((n) => tools.map((t) => t.name).includes(n)), tools.map((t) => t.name).join(", "));

// Idempotency: the dev worker may persist DO state across runs (.wrangler/state),
// so a `notes/mcp` view from a prior smoke would collide on the UNIQUE(pattern,
// name) index below. Archive any leftover before re-creating, so the smoke is
// re-runnable locally and in CI alike. (archive is de-escalation — never gated.)
const existing = await client.callTool({ name: "query", arguments: { pattern: "_views", filter: ["pattern=notes", "name=mcp"] } });
try {
  for (const e of (JSON.parse(txt(existing)).entries ?? []))
    await client.callTool({ name: "mutate", arguments: { pattern: "_views", operation: "archive", data: { id: e.id } } });
} catch { /* no prior row, or query shape changed — the create below is the real assertion */ }

// 1) Author a view through MCP — must NOT be consent-blocked, must pass Zod.
const v = await client.callTool({ name: "mutate", arguments: { pattern: "_views", operation: "create", data: { pattern: "notes", name: "mcp", view_type: "table", config: JSON.stringify({ columns: ["title", "body"] }) } } });
ok("mutate _views (author a view) succeeds through MCP, no confirmation_required", !v.isError && !/confirmation_required|error/i.test(txt(v)), txt(v));

// 2) Bad view spec — kernel validation must surface as a tool error.
const bad = await client.callTool({ name: "mutate", arguments: { pattern: "_views", operation: "create", data: { pattern: "notes", name: "mcpbad", view_type: "grid" } } });
ok("bad view_type rejected through MCP with a helpful message", /not a valid view/.test(txt(bad)), txt(bad));

// 3) set_facet_format via propose_change + apply_change — the path that was
//    Zod-rejected before (set_facet_format absent from the change.type enum).
const prop = await client.callTool({ name: "propose_change", arguments: { description: "make bookmarks url clickable", change: { type: "set_facet_format", pattern_name: "bookmarks", facet: "url", format: "link" } } });
let changeId = null;
try { changeId = JSON.parse(txt(prop)).change_id; } catch { /* */ }
ok("propose_change set_facet_format ACCEPTED through MCP (was Zod-rejected)", !prop.isError && changeId != null, txt(prop));
if (changeId) {
  const appl = await client.callTool({ name: "apply_change", arguments: { change_id: changeId } });
  ok("apply_change set_facet_format applied through MCP", !appl.isError && !/error/i.test(txt(appl)), txt(appl));
}

// 4) Bad format through MCP — Zod enum should now also bound `format`.
const badFmt = await client.callTool({ name: "propose_change", arguments: { description: "bad", change: { type: "set_facet_format", pattern_name: "bookmarks", facet: "url", format: "hyperlink" } } });
ok("invalid format rejected through MCP", badFmt.isError || /invalid|must be|enum/i.test(txt(badFmt)), txt(badFmt));

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall MCP checks passed");
process.exit(failures ? 1 : 0);
