// Publications: declarative outbound projections rendered from live data.
// Also: the durable consent round-trip (checkAndArmConsent) that gates them.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../hive";
import { escapeHtml, renderTemplate } from "../publications";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName("user:test");
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean; options?: string[] }[],
) {
  const result = await store.proposeChange(
    `Create ${name}`,
    JSON.stringify({
      type: "create_pattern",
      pattern_name: name,
      pattern_description: `Test pattern: ${name}`,
      doctrine: `Test doctrine for ${name}`,
      facets,
    })
  );
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.message);
  return JSON.parse(await store.applyChange(parsed.change_id));
}

async function createEntry(store: DurableObjectStub<HiveDO>, pattern: string, data: Record<string, unknown>) {
  const result = JSON.parse(await store.mutate(pattern, "create", JSON.stringify(data)));
  if (result.error) throw new Error(result.message);
  return result;
}

async function createPublication(store: DurableObjectStub<HiveDO>, data: Record<string, unknown>) {
  return JSON.parse(await store.mutate("_publications", "create", JSON.stringify(data)));
}

async function notesWithEntries(store: DurableObjectStub<HiveDO>) {
  await createPattern(store, "notes", [
    { name: "title", type: "text", required: true },
    { name: "body", type: "text" },
  ]);
  const a = await createEntry(store, "notes", { title: "First note", body: "Alpha content" });
  const b = await createEntry(store, "notes", { title: "Second note", body: "Beta content" });
  return { a, b };
}

// === Template seam (pure) ===

describe("template seam", () => {
  const ctx = { facets: [{ name: "title", type: "text" }, { name: "body", type: "text" }], host: "test.host" };
  const entry = { id: 7, title: "Hello", body: "<b>World</b>", updated_at: "2026-06-09 10:00:00" };

  it("substitutes facets and specials", () => {
    const out = renderTemplate("{{title}} / {{_label}} / {{_id}} / {{_uri}}", entry, ctx, "notes");
    expect(out).toBe("Hello / Hello / 7 / mnemion://entry/notes/7");
  });

  it("escapes substituted values but not template text", () => {
    const out = renderTemplate("<em>{{body}}</em>", entry, ctx, "notes", escapeHtml);
    expect(out).toBe("<em>&lt;b&gt;World&lt;/b&gt;</em>");
  });

  it("renders unknown placeholders as empty", () => {
    expect(renderTemplate("[{{nope}}]", entry, ctx, "notes")).toBe("[]");
  });
});

// === Kernel hook validation ===

describe("_publications create hook", () => {
  it("requires path, source_pattern, and format", async () => {
    const store = getStore();
    await notesWithEntries(store);
    expect((await createPublication(store, { source_pattern: "notes", format: "html" })).error).toBe(true);
    expect((await createPublication(store, { path: "x", format: "html" })).error).toBe(true);
    expect((await createPublication(store, { path: "x", source_pattern: "notes" })).error).toBe(true);
    expect((await createPublication(store, { path: "x", source_pattern: "notes", format: "pdf" })).error).toBe(true);
  });

  it("refuses kernel and nonexistent source patterns", async () => {
    const store = getStore();
    const kernel = await createPublication(store, { path: "leak", source_pattern: "_access_tokens", format: "json" });
    expect(kernel.error).toBe(true);
    expect(kernel.message).toMatch(/user patterns only/);
    const missing = await createPublication(store, { path: "x", source_pattern: "ghosts", format: "json" });
    expect(missing.error).toBe(true);
  });

  it("validates filters JSON and enforces active-path uniqueness", async () => {
    const store = getStore();
    await notesWithEntries(store);
    const bad = await createPublication(store, { path: "x", source_pattern: "notes", format: "json", filters: "status=done" });
    expect(bad.error).toBe(true);

    const first = await createPublication(store, { path: "dupe", source_pattern: "notes", format: "json" });
    expect(first.error).toBeUndefined();
    const second = await createPublication(store, { path: "dupe", source_pattern: "notes", format: "json" });
    expect(second.error).toBe(true);
  });

  it("strips leading slashes from path", async () => {
    const store = getStore();
    await notesWithEntries(store);
    const pub = await createPublication(store, { path: "/nested/page", source_pattern: "notes", format: "json" });
    expect(pub.entry.path).toBe("nested/page");
  });
});

// === Rendering via resolvePublication ===

describe("resolvePublication", () => {
  it("renders JSON with live entries", async () => {
    const store = getStore();
    await notesWithEntries(store);
    await createPublication(store, { path: "feed", title: "My Notes", source_pattern: "notes", format: "json" });

    const result = JSON.parse(await store.resolvePublication("feed"));
    expect(result.found).toBe(true);
    expect(result.content_type).toBe("application/json");
    const doc = JSON.parse(result.body);
    expect(doc.title).toBe("My Notes");
    expect(doc.count).toBe(2);
    expect(doc.entries.map((e: any) => e.title)).toContain("First note");

    // Live: a new entry appears without touching the publication
    await createEntry(store, "notes", { title: "Third note" });
    const again = JSON.parse(JSON.parse(await store.resolvePublication("feed")).body);
    expect(again.count).toBe(3);
  });

  it("renders markdown with YAML frontmatter", async () => {
    const store = getStore();
    await notesWithEntries(store);
    await createPublication(store, { path: "notes-md", title: "Notes", source_pattern: "notes", format: "markdown" });

    const result = JSON.parse(await store.resolvePublication("notes-md"));
    expect(result.content_type).toMatch(/text\/markdown/);
    expect(result.body.startsWith("---\n")).toBe(true);
    const fm = result.body.split("---")[1];
    expect(fm).toMatch(/title: "Notes"/);
    expect(fm).toMatch(/source_pattern: "notes"/);
    expect(fm).toMatch(/count: 2/);
    expect(result.body).toContain("## First note");
  });

  it("renders HTML with default styles, css override, and escaping", async () => {
    const store = getStore();
    await createPattern(store, "spicy", [{ name: "title", type: "text", required: true }]);
    await createEntry(store, "spicy", { title: "<script>alert(1)</script>" });
    await createPublication(store, {
      path: "page", source_pattern: "spicy", format: "html",
      css: ".entry { border-color: hotpink; }",
    });

    const result = JSON.parse(await store.resolvePublication("page"));
    expect(result.content_type).toMatch(/text\/html/);
    expect(result.body).toContain("<!DOCTYPE html>");
    expect(result.body).toContain("prefers-color-scheme: dark"); // default styles present
    expect(result.body).toContain(".entry { border-color: hotpink; }"); // owner override appended
    expect(result.body).not.toContain("<script>alert(1)</script>"); // escaped
    expect(result.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders RSS with items and RFC-822 dates", async () => {
    const store = getStore();
    await notesWithEntries(store);
    await createPublication(store, { path: "rss", title: "Notes Feed", source_pattern: "notes", format: "rss" });

    const result = JSON.parse(await store.resolvePublication("rss"));
    expect(result.content_type).toMatch(/application\/rss\+xml/);
    expect(result.body).toContain("<rss version=\"2.0\">");
    expect(result.body).toContain("<title>Notes Feed</title>");
    expect(result.body).toContain("<title>First note</title>");
    expect(result.body).toContain("guid isPermaLink=\"false\">mnemion://entry/notes/");
    expect(result.body).toMatch(/<pubDate>\w{3}, \d{2} \w{3} \d{4} [\d:]+ GMT<\/pubDate>/);
  });

  it("applies per-entry templates", async () => {
    const store = getStore();
    await notesWithEntries(store);
    await createPublication(store, {
      path: "templated", source_pattern: "notes", format: "html",
      template: "<h3>{{title}}</h3><p>{{body}} ({{_uri}})</p>",
    });
    const result = JSON.parse(await store.resolvePublication("templated"));
    expect(result.body).toContain("<h3>First note</h3>");
    expect(result.body).toContain("(mnemion://entry/notes/");
  });

  it("honors filters, sort, and limit", async () => {
    const store = getStore();
    await createPattern(store, "items", [
      { name: "title", type: "text", required: true },
      { name: "rank", type: "integer" },
    ]);
    await createEntry(store, "items", { title: "low", rank: 1 });
    await createEntry(store, "items", { title: "mid", rank: 5 });
    await createEntry(store, "items", { title: "high", rank: 9 });
    await createPublication(store, {
      path: "top", source_pattern: "items", format: "json",
      filters: JSON.stringify(["rank>2"]), sort: "-rank", limit: 1,
    });
    const doc = JSON.parse(JSON.parse(await store.resolvePublication("top")).body);
    expect(doc.count).toBe(1);
    expect(doc.entries[0].title).toBe("high");
  });

  it("excludes superseded entries by default, includes on opt-in", async () => {
    const store = getStore();
    const { a, b } = await notesWithEntries(store);
    await store.mutate("link", "create", JSON.stringify({
      source: `notes/${b.entry.id}`, target: `notes/${a.entry.id}`, label: "supersedes",
    }));

    await createPublication(store, { path: "current", source_pattern: "notes", format: "json" });
    const current = JSON.parse(JSON.parse(await store.resolvePublication("current")).body);
    expect(current.entries.map((e: any) => e.id)).not.toContain(a.entry.id);
    expect(current.entries.map((e: any) => e.id)).toContain(b.entry.id);

    await createPublication(store, { path: "all", source_pattern: "notes", format: "json", include_superseded: true });
    const all = JSON.parse(JSON.parse(await store.resolvePublication("all")).body);
    expect(all.entries.map((e: any) => e.id)).toContain(a.entry.id);
  });

  it("does not serve private publications; exposes visibility for unlisted", async () => {
    const store = getStore();
    await notesWithEntries(store);
    await createPublication(store, { path: "staged", source_pattern: "notes", format: "json", visibility: "private" });
    expect(JSON.parse(await store.resolvePublication("staged")).found).toBe(false);

    await createPublication(store, { path: "secret", source_pattern: "notes", format: "json", visibility: "unlisted" });
    const result = JSON.parse(await store.resolvePublication("secret"));
    expect(result.found).toBe(true);
    expect(result.visibility).toBe("unlisted");
  });

  it("survives session churn: consent arms durably, confirms on re-issue, consumes on use", async () => {
    const store = getStore();
    const key = "consent:_publications:create:{\"path\":\"x\"}";

    // First call arms and refuses — the confirmation_required leg
    expect(await store.checkAndArmConsent(key)).toBe(false);
    // Re-issue (any session — state lives in the DO, not SessionDO memory) confirms
    expect(await store.checkAndArmConsent(key)).toBe(true);
    // Consumed on use: a third call starts a fresh round-trip
    expect(await store.checkAndArmConsent(key)).toBe(false);

    // Distinct keys don't cross-confirm
    expect(await store.checkAndArmConsent("consent:other")).toBe(false);

    // Expired arms don't confirm
    await runInDurableObject(store, async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE _pending_consent SET expires_at = datetime('now', '-1 minute') WHERE key = ?`, key
      );
    });
    expect(await store.checkAndArmConsent(key)).toBe(false);
  });

  it("returns found:false for unknown paths and tracks updated_at for caching", async () => {
    const store = getStore();
    expect(JSON.parse(await store.resolvePublication("nope")).found).toBe(false);

    const { b } = await notesWithEntries(store);
    await createPublication(store, { path: "etag", source_pattern: "notes", format: "json" });
    const first = JSON.parse(await store.resolvePublication("etag"));
    // ETag source must be at least as fresh as the newest entry served
    expect(first.updated_at >= (b.entry.updated_at as string)).toBe(true);
  });
});
