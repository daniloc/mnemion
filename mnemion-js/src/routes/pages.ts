import type { RouteHandler } from "../router";
import { TOOLS } from "../tools";
// @ts-ignore — compiled Svelte SSR bundle
import { renderSchemaViewer } from "../../dist/server/entry-server.mjs";
// @ts-ignore — text import via wrangler rules
// @ts-ignore — text import via wrangler rules (.client.txt → string)
import clientScript from "../../dist/client/entry-client.client.txt";

export const schemaPage: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.getIndex();
  const index = JSON.parse(raw);

  const html = renderSchemaViewer(
    {
      patterns: index.patterns,
      charter: index.charter ?? {},
      guidance: index.guidance,
    },
    clientScript,
  );

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

export const queryIndex: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.getIndex();
  return new Response(raw, {
    headers: { "Content-Type": "application/json" },
  });
};

export const queryEntries: RouteHandler = async (ctx) => {
  const result = await ctx.hive.query(
    ctx.params.pattern, "", "", "-updated_at", 100, false
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
  const result = await ctx.hive.mutate(ctx.params.pattern, operation, JSON.stringify(data));
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

export const liveSocket: RouteHandler = async (ctx) => {
  if (ctx.request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  // WebSocket upgrades must go through fetch(), not RPC
  return ctx.hive.fetch(ctx.request);
};
