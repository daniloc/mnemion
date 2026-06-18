// Agent sets a facet's intrinsic render format via MCP (propose + apply
// set_facet_format), and the open view redraws IN PLACE (_schema push).
//   node scripts/set-format.mjs <pattern> <facet> <format|->     ( - clears )
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = process.env.ORIGIN || "http://localhost:4281";
const [, , pattern, facet, fmtArg] = process.argv;
if (!pattern || !facet) { console.error("usage: set-format.mjs <pattern> <facet> <format|->"); process.exit(2); }
const format = fmtArg === "-" ? null : fmtArg;

const ws = new WebSocket(`${origin.replace("http", "ws")}/ws`);
const msgs = [];
ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse(e.data)); } catch { /* */ } });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

const token = (await (await fetch(`${origin}/api/mutate/_access_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "create", data: { scope: "*", label: "set-format" } }) })).json()).entry.token;
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "set-format", version: "1.0.0" });
await client.connect(transport);
const txt = (r) => (r.content || []).map((c) => c.text).join("");

const before = msgs.length;
const prop = await client.callTool({ name: "propose_change", arguments: { description: `render ${pattern}.${facet} as ${format ?? "default"}`, change: { type: "set_facet_format", pattern_name: pattern, facet, format } } });
const changeId = (() => { try { return JSON.parse(txt(prop)).change_id; } catch { return null; } })();
if (!changeId) { console.error("propose failed:", txt(prop).slice(0, 200)); process.exit(1); }
const appl = await client.callTool({ name: "apply_change", arguments: { change_id: changeId } });
console.log(`set ${pattern}.${facet} format → ${format ?? "(cleared)"}:`, appl.isError ? "ERROR" : "ok");

await new Promise((r) => setTimeout(r, 800));
await client.close(); ws.close();
const pushed = msgs.slice(before).find((m) => m.type === "changed" && (m.patterns || []).includes("_schema"));
console.log("live push:", pushed ? JSON.stringify(pushed.patterns) : "(none)");
console.log(pushed ? `✓ _schema push → the SPA refreshes facets and re-renders ${pattern} IN PLACE. Watch :4280.` : "✗ no push");
process.exit(pushed ? 0 : 1);
