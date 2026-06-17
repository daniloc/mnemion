// Publication renderers: live pattern data → HTML / RSS / JSON / Markdown.
//
// A publication entry declares the projection; these functions derive the
// document at request time. Nothing rendered is ever stored — the page is a
// consequence of current truth ("data is destiny" applied to publishing).
//
// The template seam is deliberately small: {{facet}} substitution plus a few
// specials. Template text passes through raw (owners may write markup);
// substituted VALUES are escaped in html/rss contexts. No logic, no loops.
//
// @why Publications render live pattern projections at request time and store
// nothing, so the served page is always a consequence of current truth
// (data-is-destiny applied to publishing). The per-entry template seam
// substitutes HTML-escaped values into raw template text so an owner can shape
// output without the projection becoming a stored, drift-prone artifact;
// superseded entries are excluded by default because a publication projects
// current truth.

import { deriveLabel, type LabelFacet } from "../../entities/Hive/labels";
import { uri } from "../core/constants";
import { parseDbDate } from "../../entities/Hive/prime";

export interface PublicationRow {
  path: string;
  title: string | null;
  source_pattern: string;
  format: string;
  template: string | null;
  css: string | null;
}

export interface RenderContext {
  facets: LabelFacet[];
  host: string;
}

export interface Rendered {
  body: string;
  contentType: string;
}

// === Escaping ===

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// === Template seam ===

/** Substitute {{facet}} placeholders. Specials: _label, _uri, _id, _updated_at.
 *  Unknown placeholders become empty strings. `escape` is applied to VALUES only. */
export function renderTemplate(
  template: string,
  entry: Record<string, unknown>,
  ctx: RenderContext,
  pattern: string,
  escape?: (s: string) => string,
): string {
  const specials: Record<string, string> = {
    _label: deriveLabel(entry, ctx.facets),
    _uri: uri(`entry/${pattern}/${entry.id}`),
    _id: String(entry.id ?? ""),
    _updated_at: String(entry.updated_at ?? ""),
  };
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key: string) => {
    const raw = key in specials ? specials[key] : entry[key];
    if (raw == null) return "";
    const val = String(raw);
    return escape ? escape(val) : val;
  });
}

// === Shared helpers ===

/** Text/select facets with non-empty values, in declaration order. */
function contentFacets(entry: Record<string, unknown>, facets: LabelFacet[]): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const f of facets) {
    if (f.type !== "text" && f.type !== "select") continue;
    const v = entry[f.name];
    if (v == null || v === "") continue;
    out.push({ name: f.name, value: String(v) });
  }
  return out;
}

function rfc822(sqliteDate: string | undefined): string {
  const t = parseDbDate(sqliteDate);
  return new Date(t ?? Date.now()).toUTCString();
}

// === Dispatch ===

export function renderPublication(
  pub: PublicationRow,
  entries: Record<string, unknown>[],
  ctx: RenderContext,
): Rendered {
  const title = pub.title || pub.path;
  switch (pub.format) {
    case "rss": return renderRss(pub, title, entries, ctx);
    case "json": return renderJson(pub, title, entries);
    case "markdown": return renderMarkdown(pub, title, entries, ctx);
    case "html":
    default: return renderHtml(pub, title, entries, ctx);
  }
}

// === JSON ===

function renderJson(pub: PublicationRow, title: string, entries: Record<string, unknown>[]): Rendered {
  return {
    body: JSON.stringify({
      title,
      path: pub.path,
      source_pattern: pub.source_pattern,
      generated_at: new Date().toISOString(),
      count: entries.length,
      entries,
    }, null, 2),
    contentType: "application/json",
  };
}

// === Markdown (YAML frontmatter by default) ===

function renderMarkdown(pub: PublicationRow, title: string, entries: Record<string, unknown>[], ctx: RenderContext): Rendered {
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `path: ${JSON.stringify(pub.path)}`,
    `source_pattern: ${JSON.stringify(pub.source_pattern)}`,
    `generated_at: ${JSON.stringify(new Date().toISOString())}`,
    `count: ${entries.length}`,
    "---",
  ].join("\n");

  const sections = entries.map((entry) => {
    const label = deriveLabel(entry, ctx.facets);
    if (pub.template) {
      return `## ${label}\n\n${renderTemplate(pub.template, entry, ctx, pub.source_pattern)}`;
    }
    const lines: string[] = [`## ${label}`];
    for (const f of contentFacets(entry, ctx.facets)) {
      if (f.value === label) continue;
      if (f.value.includes("\n") || f.value.length > 200) {
        lines.push(`\n**${f.name}:**\n\n${f.value}`);
      } else {
        lines.push(`- **${f.name}**: ${f.value}`);
      }
    }
    lines.push(`\n<sub>${uri(`entry/${pub.source_pattern}/${entry.id}`)} · updated ${entry.updated_at ?? ""}</sub>`);
    return lines.join("\n");
  });

  return {
    body: `${fm}\n\n# ${title}\n\n${sections.join("\n\n")}\n`,
    contentType: "text/markdown; charset=utf-8",
  };
}

// === HTML ===

const DEFAULT_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6; max-width: 44rem; margin: 0 auto; padding: 2rem 1.25rem 4rem;
  background: #fff; color: #1a1a1a;
}
header { margin-bottom: 2rem; }
h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
.meta { color: #777; font-size: 0.85rem; }
article {
  padding: 1rem 1.25rem; margin: 1rem 0; border: 1px solid #e3e3e3;
  border-radius: 10px; background: #fafafa;
}
article h2 { font-size: 1.1rem; margin: 0 0 0.5rem; }
article p { margin: 0.4rem 0; white-space: pre-wrap; overflow-wrap: break-word; }
article .facet-name { color: #777; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
article time { color: #999; font-size: 0.8rem; }
footer { margin-top: 2.5rem; color: #999; font-size: 0.8rem; }
@media (prefers-color-scheme: dark) {
  body { background: #141414; color: #e6e6e6; }
  article { background: #1d1d1d; border-color: #2c2c2c; }
}
`.trim();

function renderHtml(pub: PublicationRow, title: string, entries: Record<string, unknown>[], ctx: RenderContext): Rendered {
  const articles = entries.map((entry) => {
    if (pub.template) {
      return `<article id="entry-${entry.id}">\n${renderTemplate(pub.template, entry, ctx, pub.source_pattern, escapeHtml)}\n</article>`;
    }
    const label = deriveLabel(entry, ctx.facets);
    const parts: string[] = [`<article id="entry-${entry.id}">`, `<h2>${escapeHtml(label)}</h2>`];
    for (const f of contentFacets(entry, ctx.facets)) {
      if (f.value === label) continue;
      parts.push(`<p><span class="facet-name">${escapeHtml(f.name)}</span><br>${escapeHtml(f.value)}</p>`);
    }
    parts.push(`<time datetime="${escapeHtml(String(entry.updated_at ?? ""))}">updated ${escapeHtml(String(entry.updated_at ?? ""))}</time>`);
    parts.push("</article>");
    return parts.join("\n");
  });

  const ownerCss = pub.css ? `\n<style>\n${pub.css}\n</style>` : "";

  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${DEFAULT_CSS}
</style>${ownerCss}
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${entries.length} ${entries.length === 1 ? "entry" : "entries"} · generated ${escapeHtml(new Date().toISOString())}</p>
</header>
<main>
${articles.join("\n")}
</main>
<footer>Published from <a href="https://${escapeHtml(ctx.host)}">${escapeHtml(ctx.host)}</a></footer>
</body>
</html>`;

  return { body, contentType: "text/html; charset=utf-8" };
}

// === RSS 2.0 ===

function renderRss(pub: PublicationRow, title: string, entries: Record<string, unknown>[], ctx: RenderContext): Rendered {
  const pubUrl = `https://${ctx.host}/p/${pub.path}`;

  const items = entries.map((entry) => {
    const label = deriveLabel(entry, ctx.facets);
    let description: string;
    if (pub.template) {
      description = renderTemplate(pub.template, entry, ctx, pub.source_pattern, escapeHtml);
    } else {
      const first = contentFacets(entry, ctx.facets).find((f) => f.value !== label);
      description = escapeHtml(first?.value ?? label);
    }
    return [
      "<item>",
      `<title>${escapeHtml(label)}</title>`,
      `<link>${escapeHtml(`${pubUrl}#entry-${entry.id}`)}</link>`,
      `<guid isPermaLink="false">${escapeHtml(uri(`entry/${pub.source_pattern}/${entry.id}`))}</guid>`,
      `<pubDate>${rfc822(entry.updated_at as string | undefined)}</pubDate>`,
      `<description>${description}</description>`,
      "</item>",
    ].join("\n");
  });

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escapeHtml(title)}</title>
<link>${escapeHtml(pubUrl)}</link>
<description>${escapeHtml(`${title} — published from ${ctx.host}`)}</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.join("\n")}
</channel>
</rss>`;

  return { body, contentType: "application/rss+xml; charset=utf-8" };
}
