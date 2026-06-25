# Session

The per-session McpAgent Durable Object that speaks the MCP protocol and proxies tool calls to the hive over RPC.

## invariants
- tools SSOT totality

## works when
- session.ts exists at this node
- session.ts imports agents/mcp
- tools.ts exists at this node
- session.ts imports ./tools
- boundary "tools SSOT totality" at TOOLS via test "tools SSOT totality"

## why

(SessionDO is one Durable Object per MCP session: it handles the MCP protocol — tools, resources, init instructions — and proxies to the single HiveDO over RPC, keeping protocol concerns out of the data substrate. It also stamps the authenticated actor onto writes from its OAuth props, so attribution is enforced at the protocol edge.)

**tools SSOT totality.** Tool metadata feeds two consumers — the MCP `.tool(`/`.registerTool(` registrations and the `/api/tools` frontend — and the rejected design was "two parallel hand-lists, keep them in sync." The real failure shipped when `render` was registered inline without a corresponding `TOOLS` row: a live MCP tool invisible to `/api/tools`, visible to one consumer and not the other, with no warning anywhere. A tool present in one place and absent from the other is what the boundary makes unrepresentable.
