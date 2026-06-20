import type { RouteHandler } from "../router";
import { extractBasicPassword } from "../router";
import { handleMarketplaceGit, type MarketplacePlugin } from "../../IO/git";
import { PRODUCT_NAME, URI_SCHEME } from "../../core/constants";

// === Dev-only: seed test marketplace data ===

export const seedMarketplace: RouteHandler = async (ctx) => {
  let result = await ctx.hive.proposeChange("Create _plugins pattern", JSON.stringify({
    type: "create_pattern",
    pattern_name: "_plugins",
    pattern_description: "Plugin packages for the marketplace",
    doctrine: "Each plugin is a self-contained package. Name must be globally unique. Set visibility to control marketplace listing.",
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
    doctrine: "Skills belong to a plugin via plugin_id. Each skill needs a skill_md with complete instructions. Match plugin visibility.",
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

  // GET: list marketplace-scoped tokens. Do not return the token secrets in a
  // list — they're only revealed once, at creation. Expose a short suffix so the
  // owner can identify a token without the full value leaking into logs/history.
  // query() returns { pattern, entries, count } — redact over .entries.
  const result = await ctx.hive.query("_access_tokens", JSON.stringify(["scope=marketplace"]), "id,label,token,constraints,created_at", "-created_at", 100, false);
  const parsed = JSON.parse(result);
  if (parsed && Array.isArray(parsed.entries)) {
    parsed.entries = parsed.entries.map(({ token, ...rest }: Record<string, any>) => ({
      ...rest,
      token_suffix: typeof token === "string" ? token.slice(-4) : null,
    }));
  }
  return Response.json(parsed);
};

// === Marketplace git endpoints ===
//
// The marketplace is emergent: a route that reads _plugins and _skills via
// the same query() RPC any agent uses, then projects them through the git adapter.
// HiveDO has no marketplace-specific methods.

export const marketplaceGit: RouteHandler = async (ctx) => {
  const isPublic = ctx.url.pathname.startsWith("/marketplace/public");
  const publicOnly = isPublic || !ctx.env.MNEMION_SECRET;

  let pluginNames: string[] | null = null;

  if (!publicOnly) {
    const password = extractBasicPassword(ctx.request);
    if (!password) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
      });
    }

    // Validate scope AND read the token's plugin constraints in one hashed lookup
    // (tokens are stored as digests, so a raw token= query would match nothing and
    // silently serve EVERY plugin — the scope-confinement bug this replaces).
    const tok = JSON.parse(await ctx.hive.resolveTokenConstraints(password, "marketplace"));
    if (!tok.valid) {
      return new Response("Invalid token", {
        status: 401,
        headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
      });
    }
    if (tok.constraints) {
      pluginNames = tok.constraints.plugins ?? null;
    }
  }

  const plugins = await fetchMarketplacePlugins(ctx, pluginNames, publicOnly);

  const gitPath = isPublic
    ? ctx.url.pathname.replace(/^\/marketplace\/public(\.git)?/, "")
    : ctx.url.pathname.replace(/^\/marketplace(\.git)?/, "");

  return handleMarketplaceGit(ctx.request, gitPath, plugins);
};

// Compose plugin + skill data from queries — no marketplace-specific RPC needed.

async function fetchMarketplacePlugins(
  ctx: { hive: import("../router").RouteContext["hive"] },
  pluginNames: string[] | null,
  publicOnly: boolean,
): Promise<MarketplacePlugin[]> {
  const patterns = await ctx.hive.listPatterns();
  if (!patterns.includes("_plugins") || !patterns.includes("_skills")) return [];

  // Query plugins
  const pluginFilters: string[] = [];
  if (publicOnly) pluginFilters.push("visibility=public");
  const pluginResult = JSON.parse(await ctx.hive.query(
    "_plugins", pluginFilters.length ? JSON.stringify(pluginFilters) : "",
    "", "-id", 1000, false
  ));
  let dbPlugins: any[] = pluginResult.entries ?? [];

  // query() doesn't support IN — filter by name post-hoc
  if (pluginNames) {
    const nameSet = new Set(pluginNames);
    dbPlugins = dbPlugins.filter((p: any) => nameSet.has(p.name));
  }
  if (dbPlugins.length === 0) return [];

  // Query all skills in one call, group by plugin_id
  const skillResult = JSON.parse(await ctx.hive.query(
    "_skills", "", "", "plugin_id", 1000, false
  ));
  const skillsByPlugin = new Map<number, any[]>();
  for (const s of (skillResult.entries ?? [])) {
    if (!skillsByPlugin.has(s.plugin_id)) skillsByPlugin.set(s.plugin_id, []);
    skillsByPlugin.get(s.plugin_id)!.push(s);
  }

  // Assemble, applying all-or-nothing public visibility
  const result: MarketplacePlugin[] = [];
  for (const p of dbPlugins) {
    const skills = skillsByPlugin.get(p.id) ?? [];

    if (publicOnly) {
      const publicSkills = skills.filter((s: any) => s.visibility === "public");
      if (publicSkills.length !== skills.length) continue; // any non-public skill → skip plugin
    }

    result.push({
      name: p.name,
      description: p.description,
      version: p.version || "0.1.0",
      claude_md: p.claude_md || undefined,
      mcp_json: p.mcp_json || undefined,
      settings_json: p.settings_json || undefined,
      skills: skills.map((s: any) => ({
        name: s.name,
        description: s.description || undefined,
        argument_hint: s.argument_hint || undefined,
        skill_md: s.skill_md,
      })),
    });
  }

  return result;
}
