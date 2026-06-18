// Live-update probe: connect to /ws exactly as the SPA does, have an AGENT (via
// MCP) move a task across board columns, and confirm the worker pushes a
// GRANULAR delta {pattern, op, id, entry} — the single-card patch that lets the
// board redraw in place (one memo'd card re-renders) instead of reloading.
//
//   npm run dev   # then:   node scripts/ws-watch.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = process.env.ORIGIN || "http://localhost:4281";

async function mint() {
  const r = await fetch(`${origin}/api/mutate/_access_tokens`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create", data: { scope: "*", label: "ws-watch" } }),
  });
  return (await r.json()).entry.token;
}

// 1) Open the live socket like the browser does.
const ws = new WebSocket(`${origin.replace("http", "ws")}/ws`);
const messages = [];
ws.addEventListener("message", (e) => { try { messages.push(JSON.parse(e.data)); } catch { /* */ } });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
console.log("✓ /ws connected (Hibernatable WebSocket, same endpoint the SPA uses)");

// 2) Pick a 'todo' task to move (so the card visibly changes columns).
const q = await (await fetch(`${origin}/api/query/tasks?filter=${encodeURIComponent("status=todo")}&limit=1`)).json();
const task = q.entries[0];
console.log(`  target: tasks #${task.id} "${task.title}"  status: ${task.status} → done`);

// 3) Agent edit via MCP — move it to the 'done' column.
const token = await mint();
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "ws-watch", version: "1.0.0" });
await client.connect(transport);
const before = messages.length;
await client.callTool({ name: "mutate", arguments: { pattern: "tasks", operation: "update", data: { id: task.id, status: "done" } } });

// 4) Wait for the push and inspect it.
await new Promise((r) => setTimeout(r, 800));
await client.close();
ws.close();

const pushed = messages.slice(before);
console.log(`\nreceived ${pushed.length} live message(s):`);
for (const m of pushed) console.log("  " + JSON.stringify(m));

const changed = pushed.find((m) => m.type === "changed");
const d = changed?.delta;
const granular = d && d.pattern === "tasks" && d.op === "update" && d.id === task.id && d.entry && d.entry.status === "done";
console.log("\n" + (granular
  ? `✓ GRANULAR delta for tasks#${task.id} (op=update, entry.status=done) → the board patches one card in place; no reload.`
  : "✗ no granular delta — the board would have to refetch/reload."));
console.log(granular ? "  (watch the board at :4280 — the card jumps to 'done' and its r{n} badge ticks up, nothing else redraws)" : "");
process.exit(granular ? 0 : 1);
