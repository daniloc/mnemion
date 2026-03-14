// Web URL resolution via resolve()
//
// Fetches web content through adapter dispatch, caches in _web_cache,
// embeds for prime recall. Pure functions with context injected.

import type { Env } from "./router";

// === Types ===

export interface WebContext {
  env: Env;
  db: any;
}

interface WebAdapter {
  name: string;
  match: (url: URL) => boolean;
  fetch: (url: URL, env: Env) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
  ttl: number; // seconds
}

// === Adapter dispatch table ===

const WEB_ADAPTERS: WebAdapter[] = [
  { name: "bluesky", match: isBlueskyPost, fetch: fetchBlueskyThread, ttl: 3600 },
  { name: "browser-rendering", match: () => true, fetch: fetchViaMarkdown, ttl: 86400 },
];

// === Public API ===

export async function resolveWeb(
  ctx: WebContext,
  rawUrl: string,
): Promise<{ content: string; url: string; source: string; cached: boolean; stale?: boolean; metadata?: Record<string, unknown> }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "Invalid URL" } };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "Only http:// and https:// URLs are supported" } };
  }

  // Check cache first
  const cached = findCachedEntry(ctx.db, rawUrl);
  if (cached && !isExpired(cached.expires_at)) {
    return {
      content: cached.content,
      url: rawUrl,
      source: cached.source_adapter,
      cached: true,
      metadata: cached.metadata ? JSON.parse(cached.metadata) : undefined,
    };
  }

  // Find matching adapter
  const adapter = WEB_ADAPTERS.find(a => a.match(parsed));
  if (!adapter) {
    return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "No adapter matched" } };
  }

  // Fetch via adapter
  try {
    const result = await adapter.fetch(parsed, ctx.env);
    const expiresAt = new Date(Date.now() + adapter.ttl * 1000).toISOString();

    // Write to cache (archive old entry if exists)
    writeCacheEntry(ctx.db, rawUrl, result.content, adapter.name, expiresAt, result.metadata);

    return {
      content: result.content,
      url: rawUrl,
      source: adapter.name,
      cached: false,
      metadata: result.metadata,
    };
  } catch (err: any) {
    // Stale-while-revalidate: return stale cache if re-fetch fails
    if (cached) {
      return {
        content: cached.content,
        url: rawUrl,
        source: cached.source_adapter,
        cached: true,
        stale: true,
        metadata: cached.metadata ? JSON.parse(cached.metadata) : undefined,
      };
    }
    return {
      content: "",
      url: rawUrl,
      source: adapter.name,
      cached: false,
      metadata: { error: true, message: `Fetch failed: ${err.message}` },
    };
  }
}

// === Bluesky adapter ===

function isBlueskyPost(url: URL): boolean {
  return url.hostname === "bsky.app" && /^\/profile\/[^/]+\/post\/[^/]+$/.test(url.pathname);
}

async function fetchBlueskyThread(url: URL, _env: Env): Promise<{ content: string; metadata?: Record<string, unknown> }> {
  // https://bsky.app/profile/{handle}/post/{rkey}
  // → GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://{handle}/app.bsky.feed.post/{rkey}&depth=10
  const parts = url.pathname.split("/");
  const handle = parts[2]; // /profile/{handle}/post/{rkey}
  const rkey = parts[4];

  const atUri = `at://${handle}/app.bsky.feed.post/${rkey}`;
  const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=10`;

  const response = await fetch(apiUrl, {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Bluesky API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as any;
  const content = flattenThread(data.thread);

  return {
    content,
    metadata: {
      handle,
      rkey,
      at_uri: atUri,
      reply_count: countReplies(data.thread),
    },
  };
}

/** Flatten a Bluesky thread to readable text: parents first, then replies. */
function flattenThread(thread: any): string {
  const lines: string[] = [];

  // Walk parents (oldest first)
  const parents: any[] = [];
  let current = thread.parent;
  while (current?.post) {
    parents.unshift(current);
    current = current.parent;
  }
  for (const p of parents) {
    lines.push(formatPost(p.post, "parent"));
  }

  // Root post
  if (thread.post) {
    lines.push(formatPost(thread.post, "root"));
  }

  // Replies (depth-first, limited)
  if (thread.replies?.length) {
    for (const reply of thread.replies) {
      flattenReplies(reply, lines, 1, 3); // max depth 3
    }
  }

  return lines.join("\n\n");
}

function formatPost(post: any, role: string): string {
  const author = post.author?.displayName || post.author?.handle || "Unknown";
  const handle = post.author?.handle || "";
  const text = post.record?.text || "";
  const createdAt = post.record?.createdAt || post.indexedAt || "";
  const timestamp = createdAt ? new Date(createdAt).toLocaleString() : "";

  const prefix = role === "parent" ? "[parent] " : role === "reply" ? "  > " : "";
  return `${prefix}**${author}** (@${handle}) — ${timestamp}\n${prefix}${text}`;
}

function flattenReplies(node: any, lines: string[], depth: number, maxDepth: number): void {
  if (!node?.post || depth > maxDepth) return;
  lines.push(formatPost(node.post, "reply"));
  if (node.replies?.length) {
    for (const reply of node.replies) {
      flattenReplies(reply, lines, depth + 1, maxDepth);
    }
  }
}

function countReplies(thread: any): number {
  let count = 0;
  if (thread.replies?.length) {
    for (const r of thread.replies) {
      count += 1 + countReplies(r);
    }
  }
  return count;
}

// === Browser Rendering adapter ===

async function fetchViaMarkdown(url: URL, env: Env): Promise<{ content: string; metadata?: Record<string, unknown> }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error("Browser Rendering requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets. Set via `wrangler secret put`.");
  }

  const renderUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;
  const response = await fetch(renderUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: url.href }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Browser Rendering API returned ${response.status}: ${body}`);
  }

  const data = await response.json() as any;
  // The API returns { success: true, result: { markdown: "..." } } or similar
  const content = data.result?.markdown || data.result || data.markdown || "";

  if (typeof content !== "string" || !content) {
    throw new Error("Browser Rendering returned empty content");
  }

  return {
    content,
    metadata: { title: data.result?.title },
  };
}

// === Cache helpers ===

interface CachedEntry {
  id: number;
  url: string;
  content: string;
  source_adapter: string;
  metadata: string | null;
  fetched_at: string;
  expires_at: string;
}

function findCachedEntry(db: any, url: string): CachedEntry | null {
  try {
    const rows = db.exec(
      `SELECT * FROM "_web_cache" WHERE url = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`,
      url
    ).toArray() as CachedEntry[];
    return rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}

function writeCacheEntry(db: any, url: string, content: string, adapter: string, expiresAt: string, metadata?: Record<string, unknown>): void {
  // Archive existing entry for this URL
  db.exec(
    `UPDATE "_web_cache" SET archived_at = datetime('now'), updated_at = datetime('now') WHERE url = ? AND archived_at IS NULL`,
    url
  );

  // Insert new entry
  db.exec(
    `INSERT INTO "_web_cache" (url, content, source_adapter, metadata, fetched_at, expires_at) VALUES (?, ?, ?, ?, datetime('now'), ?)`,
    url, content, adapter, metadata ? JSON.stringify(metadata) : null, expiresAt
  );
}
