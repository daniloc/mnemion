# Session

The per-session McpAgent Durable Object that speaks the MCP protocol and proxies tool calls to the hive over RPC.

## works when
- session.ts exists at this node
- session.ts imports agents/mcp
- tools.ts exists at this node
- session.ts imports ./tools

## why

SessionDO is one Durable Object per MCP session: it handles the MCP protocol (tools, resources, init instructions) and proxies to the single HiveDO over RPC, keeping protocol concerns out of the data substrate. Tool metadata lives once in `tools.ts` as the SSOT feeding both MCP registration and the `/api/tools` frontend, so the agent-facing surface can't drift between the two; the session stamps the authenticated actor onto writes from its OAuth props so attribution is enforced at the protocol edge.
