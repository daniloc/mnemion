// Live UI rework: an AGENT (via MCP) edits the tasks view spec, and the worker
// pushes a _views change so the open board reworks IN PLACE (no reload).
// Proves the push; watch :4280 to see the transform.
//
//   npm run dev   # then:   node scripts/ui-rework.mjs [board|table|list|cards]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = process.env.ORIGIN || "http://localhost:4281";
const target = process.argv[2]; // optional explicit view_type; else toggle board<->table

const ws = new WebSocket(`${origin.replace("http", "ws")}/ws`);
const msgs = [];
ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse(e.data)); } catch { /* */ } });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

// current tasks view
const views = await (await fetch(`${origin}/api/query/_views?filter=${encodeURIComponent("pattern=tasks")}&limit=1`)).json();
const view = views.entries[0];
const next = target || (view.view_type === "board" ? "table" : "board");
console.log(`tasks view: ${view.view_type} → ${next}  (view id ${view.id})`);

// keep a sensible config for the chosen layout
const config = next === "board"
  ? JSON.stringify({ group_by: "status", title: "title", columns: ["todo", "in-progress", "done"] })
  : next === "table"
  ? JSON.stringify({ columns: ["title", "status", "notes"], title: "title", sort: "status" })
  : next === "list"
  ? JSON.stringify({ title: "title", secondary: "notes", meta: "status" })
  : JSON.stringify({ title: "title", subtitle: "status", fields: ["notes"] });

const r = await fetch(`${origin}/api/mutate/_access_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "create", data: { scope: "*", label: "ui-rework" } }) });
const token = (await r.json()).entry.token;
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "ui-rework", version: "1.0.0" });
await client.connect(transport);

const before = msgs.length;
const res = await client.callTool({ name: "mutate", arguments: { pattern: "_views", operation: "update", data: { id: view.id, view_type: next, config } } });
const text = (res.content || []).map((c) => c.text).join("");
console.log("MCP mutate _views:", res.isError ? "ERROR " + text.slice(0, 120) : "ok");

await new Promise((r) => setTimeout(r, 800));
await client.close(); ws.close();

const pushed = msgs.slice(before).find((m) => m.type === "changed" && (m.patterns || []).includes("_views"));
console.log("live push:", pushed ? JSON.stringify(pushed.patterns) : "(none)");
console.log(pushed
  ? `✓ _views change pushed → the SPA re-fetches specs and re-renders tasks as a ${next} IN PLACE (no reload). Watch :4280.`
  : "✗ no _views push");
process.exit(pushed ? 0 : 1);
