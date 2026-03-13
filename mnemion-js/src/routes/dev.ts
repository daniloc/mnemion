import type { RouteHandler } from "../router";

// Dev-only seed: creates a test pattern with a shared entry for federation testing.
// Gated behind Auth.DEV — only reachable when no MNEMION_SECRET is configured.

export const seedTestData: RouteHandler = async (ctx) => {
  // 1. Create a pattern
  let result = await ctx.hive.proposeChange("Create axioms pattern", JSON.stringify({
    type: "create_pattern",
    pattern_name: "axioms",
    pattern_description: "Core principles for testing federation",
    doctrine: "Record fundamental architectural truths. Each axiom should be self-contained and verifiable.",
    facets: [
      { name: "text", type: "text", required: true },
      { name: "category", type: "text" },
    ],
  }));
  let parsed = JSON.parse(result);
  if (parsed.change_id) {
    await ctx.hive.applyChange(parsed.change_id);
  }

  // 2. Create entries
  result = await ctx.hive.mutate("axioms", "create", JSON.stringify({
    text: "Federation works when sovereign hives connect voluntarily.",
    category: "architecture",
  }));
  const entry1 = JSON.parse(result);

  result = await ctx.hive.mutate("axioms", "create", JSON.stringify({
    text: "No protocol needed — HTTP is the protocol.",
    category: "design",
  }));
  const entry2 = JSON.parse(result);

  // 3. Share entry 1 as public
  result = await ctx.hive.proposeChange("Share axiom 1", JSON.stringify({
    type: "set_sharing",
    pattern_name: "axioms",
    entry_id: entry1.entry.id,
    visibility: "public",
  }));
  parsed = JSON.parse(result);
  if (parsed.change_id) {
    await ctx.hive.applyChange(parsed.change_id);
  }

  return Response.json({
    ok: true,
    message: "Test data seeded",
    shared_entry: {
      pattern: "axioms",
      id: entry1.entry.id,
      url: `/o/entry/axioms/${entry1.entry.id}`,
    },
    private_entry: {
      pattern: "axioms",
      id: entry2.entry.id,
    },
  });
};
