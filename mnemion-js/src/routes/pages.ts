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
