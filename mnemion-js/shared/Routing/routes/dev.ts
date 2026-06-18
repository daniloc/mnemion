import type { RouteHandler } from "../router";

// Export the whole hive (user patterns + entries + view specs) as JSON, so a
// local dev hive can be seeded with real data. Gated by a `*` access token in
// the Authorization header (mint one with mutate _access_tokens {scope:"*"}),
// NOT by a session — so a script can pull headlessly. See scripts/pull-hive.mjs.
export const exportHive: RouteHandler = async (ctx) => {
  const auth = ctx.request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return new Response("Unauthorized — send a Bearer `*` access token", { status: 401 });
  const actor = await ctx.hive.resolveTokenActor(token, "*");
  if (!actor) return new Response("Forbidden — token invalid or out of scope", { status: 403 });
  const json = await ctx.hive.exportHive();
  return new Response(json, { headers: { "content-type": "application/json" } });
};

// Load an exported hive into a LOCAL dev hive. Auth.DEV — only reachable when no
// secret is configured (i.e. `wrangler dev`), never in production.
export const importHive: RouteHandler = async (ctx) => {
  const body = await ctx.request.text();
  const result = await ctx.hive.importHive(body);
  return new Response(result, { headers: { "content-type": "application/json" } });
};

// Seed vectors: embed all existing entries into Vectorize.
// Gated behind Auth.SECRET — requires master secret.
export const seedVectors: RouteHandler = async (ctx) => {
  const result = await ctx.hive.seedVectors();
  return Response.json(JSON.parse(result));
};

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
