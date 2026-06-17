import type { RouteHandler } from "../router";
// @ts-ignore — compiled Svelte SSR bundle
import { renderCanvasPage } from "../../../dist/server/canvas-server.mjs";
// @ts-ignore — text import via wrangler rules (.client.txt → string)
import canvasClientScript from "../../../dist/canvas/canvas-client.client.txt";

// === Canvas page ===

export const canvasPage: RouteHandler = async () => {
  const html = renderCanvasPage(canvasClientScript);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

// === Canvas API: list / get ===

export const listCanvases: RouteHandler = async (ctx) => {
  const id = ctx.url.searchParams.get("id");
  if (id) {
    const result = await ctx.hive.query(
      "_canvases", JSON.stringify([`id=${id}`]), "", "", 1, false
    );
    return new Response(result, {
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = await ctx.hive.query(
    "_canvases", "", "id,name,folder,updated_at", "-updated_at", 100, false
  );
  return new Response(result, {
    headers: { "Content-Type": "application/json" },
  });
};

// === Canvas API: create / update ===

export const saveCanvas: RouteHandler = async (ctx) => {
  const body = await ctx.request.json() as {
    operation: string;
    data: Record<string, unknown>;
  };
  const { operation, data } = body;
  if (!operation || !data) {
    return Response.json(
      { error: true, message: "Missing operation or data" },
      { status: 400 },
    );
  }
  const result = await ctx.hive.mutate("_canvases", operation, JSON.stringify(data), ctx.actor);
  return new Response(result, {
    headers: { "Content-Type": "application/json" },
  });
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
