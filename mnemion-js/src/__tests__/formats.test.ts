import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import {
  resolveFormat,
  defaultFormatForType,
  validateFormatsMap,
  FORMAT_IDS,
  FORMAT_PALETTE,
  isFormat,
} from "../../shared/core/format-palette";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(store: DurableObjectStub<HiveDO>, name: string, facets: { name: string; type: string }[]) {
  const r = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `t ${name}`, doctrine: `d ${name}`, facets,
  })));
  if (r.error) throw new Error(r.message);
  const a = JSON.parse(await store.applyChange(r.change_id));
  if (a.error) throw new Error(a.message);
}

const propose = (store: DurableObjectStub<HiveDO>, change: Record<string, unknown>) =>
  store.proposeChange("c", JSON.stringify(change)).then(JSON.parse);

// === The resolve chain (view ?? facet ?? type) ===

describe("resolveFormat", () => {
  it("prefers the view override, then the facet intrinsic, then the type default", () => {
    expect(resolveFormat("text", "link", "text")).toBe("text");   // view wins
    expect(resolveFormat(undefined, "link", "text")).toBe("link"); // facet next
    expect(resolveFormat(undefined, undefined, "datetime")).toBe("date"); // type default
  });

  it("ignores unknown ids and falls through to the next source", () => {
    expect(resolveFormat("bogus", "link", "text")).toBe("link");
    expect(resolveFormat("bogus", "nope", "boolean")).toBe("boolean");
  });

  it("defaultFormatForType maps type → format", () => {
    expect(defaultFormatForType("datetime")).toBe("date");
    expect(defaultFormatForType("boolean")).toBe("boolean");
    expect(defaultFormatForType("integer")).toBe("number");
    expect(defaultFormatForType("number")).toBe("number");
    expect(defaultFormatForType("text")).toBe("text");
    expect(defaultFormatForType(undefined)).toBe("text");
  });
});

// === Formats-map validation (the view override) ===

describe("validateFormatsMap", () => {
  const has = (n: string) => ["url", "tags"].includes(n);
  it("accepts real facets mapped to real formats", () => {
    expect(validateFormatsMap({ url: "link", tags: "tags" }, has)).toEqual([]);
  });
  it("rejects an unknown format id", () => {
    expect(validateFormatsMap({ url: "hyperlink" }, has).join()).toContain("must be one of");
  });
  it("rejects a missing facet", () => {
    expect(validateFormatsMap({ ghost: "link" }, has).join()).toContain('facet "ghost"');
  });
  it("rejects a non-object", () => {
    expect(validateFormatsMap(["url"], has).join()).toContain("must be a JSON object");
  });
});

// === Palette totality ===

describe("format palette totality", () => {
  it("has formats, each with help, and isFormat agrees with the keys", () => {
    expect(FORMAT_IDS.length).toBeGreaterThan(0);
    for (const id of FORMAT_IDS) {
      expect(FORMAT_PALETTE[id].help.length).toBeGreaterThan(0);
      expect(isFormat(id)).toBe(true);
    }
    expect(isFormat("definitely-not-a-format")).toBe(false);
  });
});

// === set_facet_format change type (intrinsic format authoring) ===

describe("set_facet_format", () => {
  it("sets, validates, and clears a facet's intrinsic format", async () => {
    const store = getStore();
    await createPattern(store, "links", [{ name: "href", type: "text" }, { name: "label", type: "text" }]);

    const ok = await propose(store, { type: "set_facet_format", pattern_name: "links", facet: "href", format: "link" });
    expect(ok.error).toBeFalsy();
    expect(JSON.parse(await store.applyChange(ok.change_id)).error).toBeFalsy();

    const idx = JSON.parse(await store.getIndex());
    const href = idx.patterns.find((p: any) => p.name === "links").facets.find((f: any) => f.name === "href");
    expect(href.format).toBe("link");

    expect((await propose(store, { type: "set_facet_format", pattern_name: "links", facet: "href", format: "hyperlink" })).message).toContain("format must be one of");
    expect((await propose(store, { type: "set_facet_format", pattern_name: "links", facet: "ghost", format: "link" })).message).toContain("does not exist");
    expect((await propose(store, { type: "set_facet_format", pattern_name: "_views", facet: "config", format: "link" })).message).toContain("user patterns");

    // null clears it (renders by type default thereafter)
    const clr = await propose(store, { type: "set_facet_format", pattern_name: "links", facet: "href", format: null });
    expect(clr.error).toBeFalsy();
    expect(JSON.parse(await store.applyChange(clr.change_id)).error).toBeFalsy();
    const idx2 = JSON.parse(await store.getIndex());
    const href2 = idx2.patterns.find((p: any) => p.name === "links").facets.find((f: any) => f.name === "href");
    expect(href2.format).toBeUndefined();
  });
});
