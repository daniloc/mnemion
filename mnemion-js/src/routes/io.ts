import type { RouteHandler } from "../router";

// === Egress: GET /o/:path — serve _outputs content ===

export const serveOutput: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.resolveOutput(ctx.params.path);
  const result = JSON.parse(raw);

  if (!result.found) {
    return new Response("Not found", { status: 404 });
  }

  if (result.visibility === "private" && ctx.env.MNEMION_SECRET) {
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !(await ctx.hive.validateAuthCode(token))) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const etag = `"${new Date(result.updated_at).getTime()}"`;
  if (ctx.request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304 });
  }

  return new Response(result.content, {
    headers: {
      "Content-Type": result.mime_type,
      "ETag": etag,
      "Cache-Control": result.visibility === "public" ? "public, max-age=60" : "private, no-cache",
    },
  });
};

// === Ingress: POST /i/:path — create entries via _inputs ===

export const receiveInput: RouteHandler = async (ctx) => {
  const visRaw = await ctx.hive.getInputVisibility(ctx.params.path);
  const vis = JSON.parse(visRaw);

  if (!vis.found) {
    return new Response("Not found", { status: 404 });
  }

  if (vis.visibility === "private" && ctx.env.MNEMION_SECRET) {
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !(await ctx.hive.validateAuthCode(token))) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const body = await ctx.request.text();
  const headersObj: Record<string, string> = {};
  ctx.request.headers.forEach((v, k) => { headersObj[k] = v; });
  const queryObj: Record<string, string> = {};
  ctx.url.searchParams.forEach((v, k) => { queryObj[k] = v; });

  const result = await ctx.hive.processInput(
    ctx.params.path, body, JSON.stringify(headersObj), JSON.stringify(queryObj)
  );
  const parsed = JSON.parse(result);

  return Response.json(parsed, { status: parsed.error ? 400 : 201 });
};

// === Upload: POST /upload/:token — capability URL ===

export const upload: RouteHandler = async (ctx) => {
  const content = await ctx.request.text();
  const result = await ctx.hive.consumeUpload(ctx.params.token, content);
  const parsed = JSON.parse(result);
  return Response.json(parsed, { status: parsed.error ? 400 : 200 });
};
