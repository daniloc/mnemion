// Web URL resolution via resolve()
//
// Fetches web content through adapter dispatch, caches in _web_cache,
// embeds for prime recall. Pure functions with context injected.

import type { Env } from "./router";
import { isBlockedFederationHost } from "./kernel";

// === Types ===

export interface WebContext {
  env: Env;
  db: any;
}

interface WebAdapter {
  name: string;
  // Matchers operate on the raw URI string, not a parsed URL — at:// URIs with
  // DID authorities (at://did:plc:.../...) are rejected by the WHATWG URL parser.
  match: (rawUrl: string) => boolean;
  fetch: (rawUrl: string, env: Env) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
  ttl: number; // seconds
}

// === Adapter dispatch table ===

const WEB_ADAPTERS: WebAdapter[] = [
  { name: "bluesky", match: isBlueskyPost, fetch: fetchBlueskyThread, ttl: 3600 },
  { name: "browser-rendering", match: isHttpUrl, fetch: fetchViaMarkdown, ttl: 86400 },
];

// === Public API ===

export async function resolveWeb(
  ctx: WebContext,
  rawUrl: string,
): Promise<{ content: string; url: string; source: string; cached: boolean; stale?: boolean; metadata?: Record<string, unknown> }> {
  // Scheme validation. at:// (Bluesky AT Protocol) is handled as a raw string —
  // the WHATWG URL parser rejects DID authorities (at://did:plc:.../...).
  if (!rawUrl.startsWith("at://")) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "Invalid URL" } };
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "Only http://, https://, and at:// URIs are supported" } };
    }

    // SSRF guard: refuse to fetch loopback / private / link-local / internal
    // targets (incl. cloud metadata). The federation path enforces this for
    // mnemion:// URIs; the web-resolution path must too, or it becomes an
    // unguarded fetch primitive whose responses get cached and embedded into
    // prime recall.
    if (isBlockedFederationHost(parsed.host)) {
      return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "Refusing to fetch non-public host" } };
    }
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
  const adapter = WEB_ADAPTERS.find(a => a.match(rawUrl));
  if (!adapter) {
    return { content: "", url: rawUrl, source: "none", cached: false, metadata: { error: true, message: "No adapter matched" } };
  }

  // Fetch via adapter
  try {
    const result = await adapter.fetch(rawUrl, ctx.env);
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

const BSKY_POST_AT_URI = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/;
const BSKY_APP_POST_PATH = /^\/profile\/([^/]+)\/post\/([^/]+)$/;

// Reply-tree depth (levels of nested replies to fetch + render). Agents tune
// this via a ?depth=N query param to pull whole conversations and subtrees.
const DEFAULT_DEPTH = 6;
const MAX_DEPTH = 100; // AT Protocol allows up to 1000; cap for response size

/**
 * Resolve a Bluesky post reference from either a bsky.app web URL or a raw
 * at:// post URI, plus an optional ?depth=N for reply-tree depth. Both forms
 * reduce to an AT Protocol at-uri, which getPostThread accepts directly.
 * Returns null for non-post references.
 */
function blueskyPost(rawUrl: string): { atUri: string; authority: string; rkey: string; depth: number } | null {
  const [base, queryString] = splitQuery(rawUrl);
  const depth = parseDepth(queryString);

  // at://{did-or-handle}/app.bsky.feed.post/{rkey}  (URL parser rejects DID authorities)
  const direct = base.match(BSKY_POST_AT_URI);
  if (direct) {
    return { atUri: base, authority: direct[1], rkey: direct[2], depth };
  }

  // https://bsky.app/profile/{handle-or-did}/post/{rkey}
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "bsky.app") return null;
  const m = url.pathname.match(BSKY_APP_POST_PATH);
  if (!m) return null;
  const authority = decodeURIComponent(m[1]);
  return { atUri: `at://${authority}/app.bsky.feed.post/${m[2]}`, authority, rkey: m[2], depth };
}

/** Split a URI into [base, queryString] without a URL parse (DID authorities break it). */
function splitQuery(rawUrl: string): [string, string | undefined] {
  const i = rawUrl.indexOf("?");
  return i === -1 ? [rawUrl, undefined] : [rawUrl.slice(0, i), rawUrl.slice(i + 1)];
}

/** Parse ?depth=N, clamped to [0, MAX_DEPTH]; falls back to DEFAULT_DEPTH. */
function parseDepth(queryString: string | undefined): number {
  if (!queryString) return DEFAULT_DEPTH;
  const raw = new URLSearchParams(queryString).get("depth");
  if (raw === null) return DEFAULT_DEPTH;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEPTH;
  return Math.min(Math.floor(n), MAX_DEPTH);
}

function isBlueskyPost(rawUrl: string): boolean {
  return blueskyPost(rawUrl) !== null;
}

async function fetchBlueskyThread(rawUrl: string, _env: Env): Promise<{ content: string; metadata?: Record<string, unknown> }> {
  const ref = blueskyPost(rawUrl);
  if (!ref) throw new Error("Not a Bluesky post reference");
  const { atUri, authority, rkey, depth } = ref;

  const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=${depth}`;

  const response = await fetch(apiUrl, {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Bluesky API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as any;
  const content = flattenThread(data.thread, depth);

  return {
    content,
    metadata: {
      authority,
      rkey,
      at_uri: atUri,
      depth,
      reply_count: countReplies(data.thread),
    },
  };
}

/** Flatten a Bluesky thread to readable text: parents first, then replies (to maxDepth levels). */
function flattenThread(thread: any, maxDepth: number): string {
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

  // Replies (depth-first, to the requested depth)
  if (thread.replies?.length) {
    for (const reply of thread.replies) {
      flattenReplies(reply, lines, 1, maxDepth);
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
  const lines = [`${prefix}**${author}** (@${handle}) — ${timestamp}`, `${prefix}${text}`];
  lines.push(...formatEmbed(post.embed, prefix));
  return lines.join("\n");
}

/**
 * Render a hydrated embed view (app.bsky.embed.*#view) as text lines.
 * Surfaces image CDN paths, quoted posts, external links, and video so they
 * survive flattening and become recall-able via prime.
 */
function formatEmbed(embed: any, prefix: string): string[] {
  if (!embed?.$type) return [];
  switch (embed.$type) {
    case "app.bsky.embed.images#view":
      return (embed.images || []).map((img: any) =>
        `${prefix}[image: ${img.fullsize || img.thumb || ""}${img.alt ? ` — ${img.alt}` : ""}]`
      );
    case "app.bsky.embed.video#view":
      return [`${prefix}[video: ${embed.playlist || embed.thumbnail || embed.cid || ""}${embed.alt ? ` — ${embed.alt}` : ""}]`];
    case "app.bsky.embed.external#view": {
      const ext = embed.external || {};
      return [`${prefix}[link: ${ext.uri || ""}${ext.title ? ` — ${ext.title}` : ""}]`];
    }
    case "app.bsky.embed.record#view":
      return formatQuotedRecord(embed.record, prefix);
    case "app.bsky.embed.recordWithMedia#view":
      return [
        ...formatEmbed(embed.media, prefix),
        ...formatQuotedRecord(embed.record?.record, prefix),
      ];
    default:
      return [];
  }
}

/**
 * Render a quoted record (app.bsky.embed.record#viewRecord) as a blockquote,
 * including any media nested inside the quoted post. Degraded states
 * (not-found / blocked / detached) are noted rather than dropped.
 */
function formatQuotedRecord(rec: any, prefix: string): string[] {
  if (!rec?.$type) return [];
  switch (rec.$type) {
    case "app.bsky.embed.record#viewNotFound":
      return [`${prefix}[quoted post not found]`];
    case "app.bsky.embed.record#viewBlocked":
      return [`${prefix}[quoted post blocked]`];
    case "app.bsky.embed.record#viewDetached":
      return [`${prefix}[quoted post removed by author]`];
    case "app.bsky.embed.record#viewRecord": {
      const author = rec.author?.displayName || rec.author?.handle || "Unknown";
      const handle = rec.author?.handle || "";
      const text = rec.value?.text || "";
      const lines = [`${prefix}[quoting **${author}** (@${handle})]`];
      for (const line of text.split("\n")) lines.push(`${prefix}> ${line}`);
      // Media nested inside the quoted post (images, links, video)
      for (const e of rec.embeds || []) lines.push(...formatEmbed(e, `${prefix}> `));
      return lines;
    }
    default:
      // Feeds, lists, starter packs, labelers quoted by reference
      return [`${prefix}[quoted ${String(rec.$type).replace(/^app\.bsky\.[\w.]+#/, "")}]`];
  }
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

function isHttpUrl(rawUrl: string): boolean {
  return rawUrl.startsWith("https://") || rawUrl.startsWith("http://");
}

async function fetchViaMarkdown(rawUrl: string, env: Env): Promise<{ content: string; metadata?: Record<string, unknown> }> {
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
    body: JSON.stringify({ url: rawUrl }),
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
