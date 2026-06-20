# Session

The per-session McpAgent Durable Object that speaks the MCP protocol and proxies tool calls to the hive over RPC.

## invariants
- tool-registry SSOT totality

## works when
- session.ts exists at this node
- session.ts imports agents/mcp
- tools.ts exists at this node
- session.ts imports ./tools
- boundary "tool-registry SSOT totality" at TOOLS via test "tools SSOT totality"

## why

SessionDO is one Durable Object per MCP session: it handles the MCP protocol (tools, resources, init instructions) and proxies to the single HiveDO over RPC, keeping protocol concerns out of the data substrate. Tool metadata lives once in `tools.ts` as the SSOT feeding both MCP registration and the `/api/tools` frontend, so the agent-facing surface can't drift between the two. That "can't drift" is enforced, not asserted: the `tools SSOT totality` test statically reconciles every `.tool(`/`.registerTool(` call in `session.ts` against the `TOOLS` rows in both directions — a tool registered inline without a row (as `render` once was, making it a live MCP tool invisible to `/api/tools`) or a stale row with no registration fails the build. The session stamps the authenticated actor onto writes from its OAuth props so attribution is enforced at the protocol edge.
