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
  const sort = ctx.url.searchParams.get("sort") ?? "-updated_at";
  const limit = parseInt(ctx.url.searchParams.get("limit") ?? "100", 10) || 100;
  const filterJson = filters.length > 0 ? JSON.stringify(filters) : "";
  const result = await ctx.hive.query(
    ctx.params.pattern, filterJson, facets, sort, limit, false
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
