# Session

The per-session McpAgent Durable Object that speaks the MCP protocol and proxies tool calls to the hive over RPC.

## invariants
- tools SSOT totality: Every MCP tool registration appears in the frontend tool metadata.
  over: all MCP registrations and TOOLS metadata rows
  via: tools SSOT totality
  because: The render tool was once registered without a matching API tools row.
  kinds: none
