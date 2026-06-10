import type { RouteHandler } from "../router";
import { zipSync, strToU8 } from "fflate";

const DOCUMENT_BYTES = 26_214_400; // 25 MB — mirrors data.LIMITS.DOCUMENT_BYTES

// === Shared entries: GET /o/entry/:pattern/:id ===

export const serveSharedEntry: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.getSharedEntry(ctx.params.pattern, Number(ctx.params.id));
  const result = JSON.parse(raw);

  if (!result.found) {
    return new Response("Not found", { status: 404 });
  }

  if (result.visibility !== "public") {
    // Positive allow-list: serve without auth ONLY when explicitly public.
    // Anything else (unlisted, or any unexpected value) requires a valid access
    // token. If no secret is configured (dev mode) we cannot authenticate one,
    // so refuse rather than silently serving non-public content.
    if (!ctx.env.MNEMION_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const scope = `read:entry:${ctx.params.pattern}:${ctx.params.id}`;
    if (!token || !(await ctx.hive.validateAccessToken(token, scope))) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const body = JSON.stringify(result.entry, null, 2);
  const etag = `"${new Date(result.entry.updated_at).getTime()}"`;
  if (ctx.request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304 });
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "ETag": etag,
      "Cache-Control": result.visibility === "public" ? "public, max-age=60" : "private, no-cache",
    },
  });
};

// === Egress: GET /o/:path — serve _outputs content ===

export const serveOutput: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.resolveOutput(ctx.params.path);
  const result = JSON.parse(raw);

  if (!result.found) {
    return new Response("Not found", { status: 404 });
  }

  if (result.visibility !== "public") {
    // Positive allow-list: serve without auth ONLY when explicitly public.
    // Unlisted (anyone-with-token) and any unexpected value require a valid
    // access token; with no secret configured we cannot authenticate, so refuse.
    if (!ctx.env.MNEMION_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !(await ctx.hive.validateAccessToken(token, `read:output:${ctx.params.path}`))) {
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

// === Publications: GET /p/:path — render live pattern data via _publications ===

export const servePublication: RouteHandler = async (ctx) => {
  const raw = await ctx.hive.resolvePublication(ctx.params.path);
  const result = JSON.parse(raw);

  if (!result.found) {
    return new Response("Not found", { status: 404 });
  }

  if (result.visibility !== "public") {
    // Positive allow-list: serve without auth ONLY when explicitly public.
    // Unlisted requires a valid access token; with no secret configured we
    // cannot authenticate one, so refuse rather than serving non-public content.
    if (!ctx.env.MNEMION_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !(await ctx.hive.validateAccessToken(token, `read:publication:${ctx.params.path}`))) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // ETag derives from max(publication.updated_at, latest served entry) — content
  // changes bust the cache even though nothing rendered is ever stored.
  const etag = `"${new Date(result.updated_at).getTime()}"`;
  if (ctx.request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304 });
  }

  return new Response(result.body, {
    headers: {
      "Content-Type": result.content_type,
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

  if (vis.visibility !== "public") {
    // Positive allow-list: accept unauthenticated writes ONLY when the endpoint
    // is explicitly public. Anything else requires a valid access token; with no
    // secret configured we cannot authenticate, so refuse the write.
    if (!ctx.env.MNEMION_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !(await ctx.hive.validateAccessToken(token, `write:input:${ctx.params.path}`))) {
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

// === Document upload: POST /f/:token — stream a file to R2 ===

export const uploadDocument: RouteHandler = async (ctx) => {
  if (!ctx.env.DOCUMENTS) {
    return Response.json(
      { error: true, message: "File storage is not enabled on this instance (no R2 bucket bound)." },
      { status: 503 }
    );
  }
  const body = await ctx.request.arrayBuffer();
  if (body.byteLength > DOCUMENT_BYTES) {
    return Response.json(
      { error: true, message: `File too large: ${Math.round(body.byteLength / 1024 / 1024)}MB exceeds the 25MB limit` },
      { status: 413 }
    );
  }
  const contentType = ctx.request.headers.get("Content-Type") || "application/octet-stream";

  // Fully random key — bytes are gated by the entry's visibility on serve, and a
  // non-enumerable key is defense in depth for unlisted documents.
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const key = `documents/${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  await ctx.env.DOCUMENTS.put(key, body, { httpMetadata: { contentType } });

  const result = await ctx.hive.consumeDocumentUpload(ctx.params.token, key, contentType, body.byteLength);
  const parsed = JSON.parse(result);
  if (parsed.error) {
    // Token invalid/used or document gone — don't leave an orphan blob behind.
    await ctx.env.DOCUMENTS.delete(key).catch(() => {});
    return Response.json(parsed, { status: 400 });
  }
  return Response.json(parsed, { status: 201 });
};

// === Document serve: GET /f/:id — stream a file from R2, gated by visibility ===

export const serveDocument: RouteHandler = async (ctx) => {
  if (!ctx.env.DOCUMENTS) {
    return new Response("Not found", { status: 404 });
  }
  const id = Number(ctx.params.id);
  const raw = await ctx.hive.resolveDocument(id);
  const doc = JSON.parse(raw);

  if (!doc.found) {
    return new Response("Not found", { status: 404 });
  }

  if (doc.visibility !== "public") {
    // Positive allow-list: serve without auth ONLY when explicitly public.
    if (!ctx.env.MNEMION_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    const authHeader = ctx.request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !(await ctx.hive.validateAccessToken(token, `read:document:${id}`))) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const etag = `"${new Date(doc.stored_at).getTime()}"`;
  if (ctx.request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304 });
  }

  const object = await ctx.env.DOCUMENTS.get(doc.r2_key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  // Sanitize the title for the Content-Disposition filename (no quotes/CR/LF).
  const filename = String(doc.title || `document-${id}`).replace(/["\r\n]/g, "").slice(0, 200);
  const disposition = ctx.url.searchParams.get("download") != null ? "attachment" : "inline";

  return new Response(object.body, {
    headers: {
      "Content-Type": doc.content_type || "application/octet-stream",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "ETag": etag,
      "Cache-Control": doc.visibility === "public" ? "public, max-age=60" : "private, no-cache",
    },
  });
};

// === Export: GET /export/:pattern — download pattern as zip ===

function entryToMarkdown(entry: Record<string, unknown>, facetNames: string[]): string {
  const frontmatter: Record<string, unknown> = { id: entry.id };
  let body = "";

  // Find the best "title" field
  let title = "";
  for (const key of ["title", "name", "key"]) {
    if (entry[key] && typeof entry[key] === "string") { title = entry[key] as string; break; }
  }

  // Find the best "body" field (longest text facet)
  let bodyFacet = "";
  let bodyLength = 0;
  for (const f of facetNames) {
    const val = entry[f];
    if (typeof val === "string" && val.length > bodyLength) {
      bodyFacet = f;
      bodyLength = val.length;
    }
  }

  for (const f of facetNames) {
    const val = entry[f];
    if (val == null) continue;
    if (f === bodyFacet) {
      body = String(val);
    } else {
      frontmatter[f] = val;
    }
  }

  // Add kernel timestamps
  if (entry.created_at) frontmatter.created_at = entry.created_at;
  if (entry.updated_at) frontmatter.updated_at = entry.updated_at;
  if (entry.archived_at) frontmatter.archived_at = entry.archived_at;

  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" && (v.includes(":") || v.includes("#")) ? JSON.stringify(v) : v}`)
    .join("\n");

  const header = title ? `# ${title}\n\n` : "";
  return `---\n${fmLines}\n---\n${header}${body}\n`;
}

export const exportPattern: RouteHandler = async (ctx) => {
  const patternName = ctx.params.pattern;
  const result = await ctx.hive.exportPattern(patternName) as any;

  if (result.error) {
    return Response.json({ error: true, message: result.error }, { status: 404 });
  }

  const meta = result.meta;
  const entries = result.entries as Record<string, unknown>[];
  const facetNames = meta.facets.map((f: any) => f.name as string);

  // Build zip contents
  const files: any = {};

  // _pattern.yml
  const metaYaml = Object.entries({
    name: meta.name,
    description: meta.description,
    doctrine: meta.doctrine,
    exported_at: meta.exported_at,
    entry_count: entries.length,
  }).map(([k, v]) => `${k}: ${typeof v === "string" && (v.includes(":") || v.includes("\n")) ? JSON.stringify(v) : v}`)
    .join("\n")
    + "\nfacets:\n"
    + meta.facets.map((f: any) => {
      let line = `  - name: ${f.name}\n    type: ${f.type}\n    required: ${f.required}`;
      if (f.default != null) line += `\n    default: ${JSON.stringify(f.default)}`;
      if (f.links) line += `\n    links: ${f.links}`;
      if (f.options) line += `\n    options: [${f.options.join(", ")}]`;
      return line;
    }).join("\n")
    + (meta.links ? "\nlinks:\n" + meta.links.map((l: any) =>
      `  - source: ${l.source_pattern}/${l.source_id} → target: ${l.target_pattern}/${l.target_id}${l.label ? ` (${l.label})` : ""}`
    ).join("\n") : "");

  files["_pattern.yml"] = strToU8(metaYaml);

  // Entry files
  for (const entry of entries) {
    const id = entry.id as number;
    // Use title/name for filename if available
    let slug = String(id);
    for (const key of ["title", "name", "key"]) {
      if (entry[key] && typeof entry[key] === "string") {
        slug = `${id}-${(entry[key] as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 60)}`;
        break;
      }
    }
    files[`${slug}.md`] = strToU8(entryToMarkdown(entry, facetNames));
  }

  const zipped = zipSync(files as any, { level: 6 });

  return new Response(zipped, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${patternName}-export.zip"`,
    },
  });
};
