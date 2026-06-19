import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { validateBlocks, BLOCK_TYPES, isBlockType } from "../../shared/core/block-palette";
import { consentRoundTripRequired } from "../../entities/Hive/policy";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}
async function createPattern(store: DurableObjectStub<HiveDO>, name: string, facets: { name: string; type: string }[]) {
  const r = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `t ${name}`, doctrine: `d ${name}`, facets,
  })));
  if (r.error) throw new Error(r.message);
  if (JSON.parse(await store.applyChange(r.change_id)).error) throw new Error("apply failed");
}

// === The block palette validator (pure) ===

describe("validateBlocks", () => {
  const ctx = {
    patternExists: (p: string) => ["tweets", "tasks"].includes(p),
    hasFacet: (p: string, f: string) => p === "tweets" && ["engagement", "year", "faves", "platform"].includes(f),
  };

  it("accepts a valid dashboard of mixed blocks", () => {
    expect(validateBlocks(JSON.stringify([
      { type: "heading", text: "This week", width: "full" },
      { type: "metric", pattern: "tweets", metric: "engagement", agg: "sum", width: "third" },
      { type: "chart", pattern: "tweets", group_by: "year", metric: "engagement", agg: "sum", width: "full" },
    ]), ctx)).toEqual([]);
  });
  it("treats empty/absent blocks as a valid (empty) page", () => {
    expect(validateBlocks("", ctx)).toEqual([]);
    expect(validateBlocks(null, ctx)).toEqual([]);
  });
  it("rejects an unknown block type", () => {
    expect(validateBlocks(JSON.stringify([{ type: "widget" }]), ctx).join()).toContain("not a block type");
  });
  it("rejects a block referencing a missing pattern", () => {
    expect(validateBlocks(JSON.stringify([{ type: "metric", pattern: "ghosts" }]), ctx).join()).toContain('pattern "ghosts"');
  });
  it("rejects a facet not on the referenced pattern", () => {
    expect(validateBlocks(JSON.stringify([{ type: "chart", pattern: "tweets", group_by: "nope" }]), ctx).join()).toContain('facet "nope"');
  });
  it("enforces required keys, valid width, valid agg", () => {
    expect(validateBlocks(JSON.stringify([{ type: "chart" }]), ctx).join()).toContain("pattern is required");
    expect(validateBlocks(JSON.stringify([{ type: "heading", text: "x", width: "huge" }]), ctx).join()).toContain("width must be");
    expect(validateBlocks(JSON.stringify([{ type: "metric", pattern: "tweets", agg: "median" }]), ctx).join()).toContain("one of");
  });
  it("accepts a multi-series / stacked chart block, rejects a bad stack flag", () => {
    expect(validateBlocks(JSON.stringify([
      { type: "chart", pattern: "tweets", mark: "area", x: "year", y: "engagement", series: "platform", stack: true, width: "full" },
    ]), ctx)).toEqual([]);
    expect(validateBlocks(JSON.stringify([{ type: "chart", pattern: "tweets", x: "year", series: "ghost" }]), ctx).join()).toContain('facet "ghost"');
    expect(validateBlocks(JSON.stringify([{ type: "chart", pattern: "tweets", x: "year", stack: "yes" }]), ctx).join()).toContain("true or false");
  });
  it("rejects a chart block with a non-chart mark or series-without-x", () => {
    expect(validateBlocks(JSON.stringify([{ type: "chart", pattern: "tweets", mark: "doughnut", x: "year" }]), ctx).join()).toContain("not a chart mark");
    expect(validateBlocks(JSON.stringify([{ type: "chart", pattern: "tweets", mark: "bar", series: "platform", y: "engagement" }]), ctx).join()).toContain("needs an x facet");
  });
  it("caps the number of blocks (DoS guard)", () => {
    const many = Array.from({ length: 40 }, () => ({ type: "heading", text: "h" }));
    expect(validateBlocks(JSON.stringify(many), ctx).join()).toContain("at most 32 blocks");
    expect(validateBlocks(JSON.stringify(many.slice(0, 32)), ctx)).toEqual([]);
  });
  it("rejects non-array / non-JSON blocks", () => {
    expect(validateBlocks(JSON.stringify({ type: "heading" }), ctx).join()).toContain("must be a JSON array");
    expect(validateBlocks("{bad", ctx).join()).toContain("valid JSON");
  });
  it("BLOCK_TYPES / isBlockType agree", () => {
    expect(BLOCK_TYPES.length).toBeGreaterThan(0);
    for (const t of BLOCK_TYPES) expect(isBlockType(t)).toBe(true);
    expect(isBlockType("nope")).toBe(false);
  });
});

// === Kernel enforcement through mutate (fail-closed) ===

describe("_pages kernel validation", () => {
  it("accepts a valid page and rejects bad block references through mutate", async () => {
    const store = getStore();
    await createPattern(store, "data", [{ name: "amount", type: "integer" }, { name: "cat", type: "text" }]);

    const ok = JSON.parse(await store.mutate("_pages", "create", JSON.stringify({
      name: "D", path: "d", blocks: JSON.stringify([
        { type: "heading", text: "Overview" },
        { type: "metric", pattern: "data", metric: "amount", agg: "sum" },
        { type: "chart", pattern: "data", group_by: "cat", metric: "amount", agg: "sum" },
      ]),
    })));
    expect(ok.error).toBeFalsy();

    expect(JSON.parse(await store.mutate("_pages", "create", JSON.stringify({ name: "B", path: "b", blocks: JSON.stringify([{ type: "chart", pattern: "data", group_by: "ghost" }]) }))).message).toContain('facet "ghost"');
    expect(JSON.parse(await store.mutate("_pages", "create", JSON.stringify({ name: "B2", path: "b2", blocks: JSON.stringify([{ type: "metric", pattern: "ghosts" }]) }))).message).toContain("does not exist");
  });

  it("refuses a page block that sources a kernel pattern (exfil guard)", async () => {
    const store = getStore();
    // an unauthenticated public page must never be able to render _access_tokens etc.
    const r = JSON.parse(await store.mutate("_pages", "create", JSON.stringify({
      name: "Leak", path: "leak", visibility: "public",
      blocks: JSON.stringify([{ type: "chart", pattern: "_access_tokens", mark: "bar", x: "token" }]),
    })));
    expect(r.error).toBeTruthy();
    expect(r.message).toContain("kernel pattern");
  });

  it("rejects a page path that isn't a URL-safe slug (would yield a broken link)", async () => {
    const store = getStore();
    expect(JSON.parse(await store.mutate("_pages", "create", JSON.stringify({ name: "Bad", path: "my page" }))).message).toContain("URL-safe slug");
    expect(JSON.parse(await store.mutate("_pages", "create", JSON.stringify({ name: "Bad2", path: "q?x=1" }))).message).toContain("URL-safe slug");
  });

  it("hands back a link the agent can give the human (private → app deep-link, public → web URL + OG)", async () => {
    const store = getStore();
    // private (default): page_url is the signed-in app hash route, plus a note; no og_image
    const priv = JSON.parse(await store.mutate("_pages", "create", JSON.stringify({ name: "P", path: "p" })));
    expect(priv.error).toBeFalsy();
    expect(priv.page_url).toMatch(/\/#page:p$/);
    expect(priv.page_note).toContain("Private");
    expect(priv.og_image).toBeUndefined();

    // public: page_url is the web route, og_image is the unfurl card, no private note
    const pub = JSON.parse(await store.mutate("_pages", "create", JSON.stringify({ name: "Q", path: "q", visibility: "public" })));
    expect(pub.error).toBeFalsy();
    expect(pub.page_url).toMatch(/\/page\/q$/);
    expect(pub.og_image).toMatch(/\/page\/q\/og\.png$/);
    expect(pub.page_note).toBeUndefined();
  });
});

// Publishing a page (visibility public) is consent-gated; private edits aren't.
describe("_pages publish consent (on_expose)", () => {
  it("gates going public, not ordinary edits", () => {
    expect(consentRoundTripRequired("_pages", "update", { visibility: "public" })).toBe(true);
    expect(consentRoundTripRequired("_pages", "update", { visibility: "private" })).toBe(false);
    expect(consentRoundTripRequired("_pages", "update", { blocks: "[]" })).toBe(false);
  });
});
