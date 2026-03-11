import type { RouteHandler } from "../router";
// @ts-ignore — compiled Svelte SSR bundle
import { renderSchemaViewer } from "../../dist/server/entry-server.mjs";
// @ts-ignore — text import via wrangler rules
// @ts-ignore — text import via wrangler rules (.client.txt → string)
import clientScript from "../../dist/client/entry-client.client.txt";

export const schemaPage: RouteHandler = async (ctx) => {
  const raw = await ctx.store.getIndex();
  const index = JSON.parse(raw);

  const html = renderSchemaViewer(
    {
      patterns: index.patterns,
      conventions: index.conventions,
      guidance: index.guidance,
    },
    clientScript,
  );

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

export const queryIndex: RouteHandler = async (ctx) => {
  const raw = await ctx.store.getIndex();
  return new Response(raw, {
    headers: { "Content-Type": "application/json" },
  });
};

export const queryEntries: RouteHandler = async (ctx) => {
  const result = await ctx.store.query(
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
  const result = await ctx.store.mutate(ctx.params.pattern, operation, JSON.stringify(data));
  return new Response(result, {
    headers: { "Content-Type": "application/json" },
  });
};

export const liveSocket: RouteHandler = async (ctx) => {
  if (ctx.request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  // WebSocket upgrades must go through fetch(), not RPC
  return ctx.store.fetch(ctx.request);
};
