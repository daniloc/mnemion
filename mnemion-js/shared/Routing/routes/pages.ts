import type { RouteHandler } from "../router";
import { TOOLS } from "../../../entities/Session/tools";

export const queryIndex: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.getIndex();
  return new Response(raw, {
    headers: { "Content-Type": "application/json" },
  });
};

export const queryEntries: RouteHandler = async (ctx) => {
  // Optional knobs from query string. Repeat ?filter=... for multiple AND'd filters.
  const filters = ctx.url.searchParams.getAll("filter");
  const facets = ctx.url.searchParams.get("facets") ?? "";
  const limit = parseInt(ctx.url.searchParams.get("limit") ?? "100", 10) || 100;
  const filterJson = filters.length > 0 ? JSON.stringify(filters) : "";
  // Aggregation passthrough: group_by + aggregate switch the engine into analysis
  // mode (the chart view uses this). The row-sort default (-updated_at) isn't a
  // valid aggregate output column, so default to no sort when aggregating.
  const groupBy = ctx.url.searchParams.get("group_by") ?? "";
  const aggregate = ctx.url.searchParams.get("aggregate") ?? "";
  const aggregating = !!(groupBy || aggregate);
  const sort = ctx.url.searchParams.get("sort") ?? (aggregating ? "" : "-updated_at");
  const result = await ctx.hive.query(
    ctx.params.pattern, filterJson, facets, sort, limit, false, groupBy, aggregate
  );
  return new Response(result, {
    headers: { "Content-Type": "application/json" },
  });
};

export const mutateEntry: RouteHandler = async (ctx) => {
  const body = await ctx.request.json() as { operation: string; data: Record<string, unknown> };
  const { operation, data } = body;
  if (!operation || !data) {
    return new Response(JSON.stringify({ error: true, message: "Missing operation or data" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = await ctx.hive.mutate(ctx.params.pattern, operation, JSON.stringify(data), ctx.actor);
  return new Response(result, {
    headers: { "Content-Type": "application/json" },
  });
};

/** POST {operations: [{pattern, operation?, data}, ...]} → one atomic batch (link/unlink shortcuts included). */
export const batchMutate: RouteHandler = async (ctx) => {
  const body = await ctx.request.json().catch(() => null) as { operations?: unknown } | null;
  if (!body || !Array.isArray(body.operations) || body.operations.length === 0) {
    return Response.json({ error: true, message: "operations (a non-empty array) is required" }, { status: 400 });
  }
  // Item shape is judged in hive.batchMutate, the chokepoint MCP shares.
  const result = await ctx.hive.batchMutate(JSON.stringify(body.operations), ctx.actor);
  return new Response(result, { headers: { "Content-Type": "application/json" } });
};

export const evolveSchema: RouteHandler = async (ctx) => {
  const body = await ctx.request.json() as { description: string; change: Record<string, unknown> };
  if (!body.description || !body.change) {
    return Response.json({ error: true, message: "Missing description or change" }, { status: 400 });
  }
  const proposed = JSON.parse(await ctx.hive.proposeChange(body.description, JSON.stringify(body.change)));
  if (proposed.error) return Response.json(proposed);
  const applied = JSON.parse(await ctx.hive.applyChange(proposed.change_id));
  return Response.json(applied);
};

export const queryTools: RouteHandler = async () => {
  return Response.json(TOOLS);
};

export const queryHistory: RouteHandler = async (ctx) => {
  const id = parseInt(ctx.params.id, 10);
  const result = await ctx.hive.getEntryHistory(ctx.params.pattern, id);
  return new Response(result, { headers: { "Content-Type": "application/json" } });
};

// === Recall for native and web clients: the same prime and search the MCP tools call ===

/** POST {context, patterns?, limit?} → the prime response (charter, relevant entries, one-hop links). */
export const primeContext: RouteHandler = async (ctx) => {
  const body = await ctx.request.json().catch(() => null) as { context?: unknown; patterns?: unknown; limit?: unknown } | null;
  if (!body || typeof body.context !== "string" || !body.context.trim()) {
    return Response.json({ error: true, message: "context is required" }, { status: 400 });
  }
  const patterns = Array.isArray(body.patterns) ? body.patterns.filter((p): p is string => typeof p === "string") : [];
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20);
  const result = await ctx.hive.prime(body.context, patterns.length ? JSON.stringify(patterns) : "", limit);
  return new Response(result, { headers: { "Content-Type": "application/json" } });
};

/** GET ?q=term&patterns=a,b&limit=N → cross-pattern full-text search. */
export const searchEntries: RouteHandler = async (ctx) => {
  const term = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!term) {
    return Response.json({ error: true, message: "q is required" }, { status: 400 });
  }
  const patterns = (ctx.url.searchParams.get("patterns") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const limit = Math.min(Math.max(parseInt(ctx.url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);
  const result = await ctx.hive.search(term, patterns.length ? JSON.stringify(patterns) : "", limit);
  return new Response(result, { headers: { "Content-Type": "application/json" } });
};

/** The derived review (entities/Hive/review.ts): the same JSON as mnemion://review. */
export const queryReview: RouteHandler = async (ctx) => {
  const result = await ctx.hive.getReview();
  return new Response(result, { headers: { "Content-Type": "application/json" } });
};

export const queryLabel: RouteHandler = async (ctx) => {
  const id = parseInt(ctx.params.id, 10);
  const result = await ctx.hive.getEntryLabel(ctx.params.pattern, id);
  return new Response(result, { headers: { "Content-Type": "application/json" } });
};

// === Resolve API: proxy hive.resolve() for link fetching ===

export const resolveUri: RouteHandler = async (ctx) => {
  const body = await ctx.request.json() as { uri: string };
  if (!body.uri) {
    return Response.json({ error: true, message: "uri is required" }, { status: 400 });
  }
  const result = await ctx.hive.resolve(body.uri);
  return new Response(result, {
    headers: { "Content-Type": "application/json" },
  });
};

export const liveSocket: RouteHandler = async (ctx) => {
  if (ctx.request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  // Same-origin check. The session cookie is SameSite=Lax, which does NOT
  // protect WebSocket upgrades — a cross-origin page could otherwise open
  // wss://this-host/ws with the owner's cookie attached and read live change
  // events about the owner's private hive. Require the Origin to match this host.
  const origin = ctx.request.headers.get("Origin");
  if (origin) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { /* malformed → reject */ }
    if (originHost !== ctx.url.host) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  // WebSocket upgrades must go through fetch(), not RPC
  return ctx.hive.fetch(ctx.request);
};
