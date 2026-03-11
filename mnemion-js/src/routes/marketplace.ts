import type { RouteHandler } from "../router";
import { extractBasicPassword } from "../router";
import { handleMarketplaceGit, type MarketplacePlugin } from "../git";
import { PRODUCT_NAME, URI_SCHEME } from "../constants";

// === Dev-only: seed test marketplace data ===

export const seedMarketplace: RouteHandler = async (ctx) => {
  let result = await ctx.hive.proposeChange("Create _plugins pattern", JSON.stringify({
    type: "create_pattern",
    pattern_name: "_plugins",
    pattern_description: "Plugin packages for the marketplace",
    facets: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text", required: true },
      { name: "version", type: "text", required: true },
      { name: "visibility", type: "text", required: true },
      { name: "author", type: "text" },
      { name: "claude_md", type: "text" },
      { name: "settings_json", type: "text" },
      { name: "mcp_json", type: "text" },
    ],
  }));
  let parsed = JSON.parse(result);
  if (parsed.change_id) {
    await ctx.hive.applyChange(parsed.change_id);
  }

  result = await ctx.hive.proposeChange("Create _skills pattern", JSON.stringify({
    type: "create_pattern",
    pattern_name: "_skills",
    pattern_description: "Skills within plugins",
    facets: [
      { name: "plugin_id", type: "integer", required: true },
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "argument_hint", type: "text" },
      { name: "skill_md", type: "text", required: true },
      { name: "visibility", type: "text", required: true },
    ],
  }));
  parsed = JSON.parse(result);
  if (parsed.change_id) {
    await ctx.hive.applyChange(parsed.change_id);
  }

  result = await ctx.hive.mutate("_plugins", "create", JSON.stringify({
    name: `${URI_SCHEME}-test`,
    description: "Test plugin for marketplace validation",
    version: "0.1.0",
    visibility: "public",
  }));
  const plugin = JSON.parse(result);

  await ctx.hive.mutate("_skills", "create", JSON.stringify({
    plugin_id: plugin.entry.id,
    name: "hello-world",
    description: "A test skill that greets the user",
    argument_hint: "[name]",
    visibility: "public",
    skill_md: "# Hello World\n\nGreet the user by name. This is a test skill to validate marketplace delivery.\n",
  }));

  return Response.json({ ok: true, message: "Test marketplace data seeded" });
};

// === Marketplace token management ===

export const marketplaceToken: RouteHandler = async (ctx) => {
  if (ctx.request.method === "POST") {
    const body = await ctx.request.json().catch(() => ({})) as { name?: string; scope?: string[] };
    const result = await ctx.hive.mutate("_access_tokens", "create", JSON.stringify({
      label: body.name || "marketplace",
      scope: "marketplace",
      plugins: body.scope ?? undefined,
    }));
    const parsed = JSON.parse(result);
    if (parsed.error) return Response.json(parsed, { status: 500 });
    const token = parsed.entry.token;
    const constraints = parsed.entry.constraints ? JSON.parse(parsed.entry.constraints) : null;
    return Response.json({
      token,
      label: parsed.entry.label,
      scope: constraints?.plugins ?? null,
      install: `https://${URI_SCHEME}:${token}@${ctx.url.host}/marketplace.git`,
    });
  }

  // GET: list marketplace-scoped tokens
  const result = await ctx.hive.query("_access_tokens", JSON.stringify(["scope=marketplace"]), "id,label,token,constraints,created_at", "-created_at", 100, false);
  return Response.json(JSON.parse(result));
};

// === Marketplace git endpoints ===

export const marketplaceGit: RouteHandler = async (ctx) => {
  const isPublic = ctx.url.pathname.startsWith("/marketplace/public");

  let raw: string;
  if (isPublic) {
    raw = await ctx.hive.getMarketplaceDataPublic();
  } else if (!ctx.env.MNEMION_SECRET) {
    raw = await ctx.hive.getMarketplaceDataPublic();
  } else {
    const password = extractBasicPassword(ctx.request);
    if (!password) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
      });
    }
    raw = await ctx.hive.getMarketplaceDataForToken(password);
    const check = JSON.parse(raw);
    if (check.error) {
      return new Response("Invalid token", {
        status: 401,
        headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
      });
    }
  }

  const { plugins: dbPlugins } = JSON.parse(raw) as { plugins: any[] };

  const plugins: MarketplacePlugin[] = dbPlugins.map((p: any) => ({
    name: p.name,
    description: p.description,
    version: p.version || "0.1.0",
    claude_md: p.claude_md || undefined,
    mcp_json: p.mcp_json || undefined,
    settings_json: p.settings_json || undefined,
    skills: (p.skills || []).map((s: any) => ({
      name: s.name,
      description: s.description || undefined,
      argument_hint: s.argument_hint || undefined,
      skill_md: s.skill_md,
    })),
  }));

  let gitPath = isPublic
    ? ctx.url.pathname.replace(/^\/marketplace\/public(\.git)?/, "")
    : ctx.url.pathname.replace(/^\/marketplace(\.git)?/, "");

  return handleMarketplaceGit(ctx.request, gitPath, plugins);
};
