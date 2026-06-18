// Agent rearranges a pattern's view via MCP (mutate _views update): change the
// config (and optionally view_type). The open view re-renders in place (_views
// push) — suppress a facet by omitting it, reorder by listing sections in order.
//   node scripts/set-view.mjs <pattern> '<configJSON>' [view_type]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = process.env.ORIGIN || "http://localhost:4281";
const [, , pattern, configJSON, viewTypeArg] = process.argv;
if (!pattern || !configJSON) { console.error("usage: set-view.mjs <pattern> '<configJSON>' [view_type]"); process.exit(2); }
JSON.parse(configJSON); // validate JSON before sending

const ws = new WebSocket(`${origin.replace("http", "ws")}/ws`);
const msgs = [];
ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse(e.data)); } catch { /* */ } });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

const views = await (await fetch(`${origin}/api/query/_views?filter=${encodeURIComponent("pattern=" + pattern)}&limit=1`)).json();
const view = views.entries[0];
if (!view) { console.error(`no view for ${pattern}`); process.exit(1); }
const viewType = viewTypeArg || view.view_type;

const token = (await (await fetch(`${origin}/api/mutate/_access_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "create", data: { scope: "*", label: "set-view" } }) })).json()).entry.token;
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "set-view", version: "1.0.0" });
await client.connect(transport);

const before = msgs.length;
const res = await client.callTool({ name: "mutate", arguments: { pattern: "_views", operation: "update", data: { id: view.id, view_type: viewType, config: configJSON } } });
const text = (res.content || []).map((c) => c.text).join("");
console.log(`mutate _views #${view.id} (${pattern} → ${viewType}):`, res.isError ? "ERROR " + text.slice(0, 200) : "ok");

await new Promise((r) => setTimeout(r, 700));
await client.close(); ws.close();
const pushed = msgs.slice(before).find((m) => m.type === "changed" && (m.patterns || []).includes("_views"));
console.log(pushed ? `✓ _views push → ${pattern} re-renders in place. Watch :4280.` : "✗ no _views push");
process.exit(pushed ? 0 : 1);
