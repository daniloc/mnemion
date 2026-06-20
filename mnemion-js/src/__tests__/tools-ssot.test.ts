// Tool-registry totality: the TOOLS SSOT and the MCP registration cannot drift.
//
// tools.ts is declared (in its own @why) as the single source of truth feeding
// BOTH McpServer tool registration (session.ts) AND the /api/tools frontend. But
// nothing structural enforced that — `render` was once registered inline in
// session.ts with no TOOLS row, so it was a live MCP tool invisible to /api/tools
// (exactly the protocol↔UI drift the SSOT exists to prevent). This is the oracle
// that closes it: the set of tools session.ts registers must equal the set TOOLS
// declares, in both directions. A new inline registerTool — or a stale TOOLS row —
// fails this test, so the drift is structurally impossible to reintroduce.
import { describe, it, expect } from "vitest";
import sessionSrc from "../../entities/Session/session.ts?raw";
import { TOOLS } from "../../entities/Session/tools";

// Every `.tool("x"` and `.registerTool("x"` in session.ts (the name may sit on the
// next line, so \s* spans the newline).
function registeredToolNames(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/\.(?:tool|registerTool)\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
}

describe("tools SSOT totality", () => {
  const registered = registeredToolNames(sessionSrc);
  const declared = new Set(TOOLS.map((t) => t.name));

  it("every tool registered in session.ts has a TOOLS row", () => {
    const orphans = [...registered].filter((n) => !declared.has(n));
    expect(orphans, `registered in session.ts but missing from TOOLS: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every TOOLS row is actually registered in session.ts", () => {
    const unused = [...declared].filter((n) => !registered.has(n));
    expect(unused, `declared in TOOLS but never registered: ${unused.join(", ")}`).toEqual([]);
  });
});
