import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import type { HiveDO } from "../hive";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName("user:test");
  return env.MNEMION_HIVE.get(id);
}

// Helper: create a pattern via propose + apply
async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean; links?: { pattern: string; facet?: string } }[],
  description?: string
) {
  const result = await store.proposeChange(
    `Create ${name}`,
    JSON.stringify({
      type: "create_pattern",
      pattern_name: name,
      pattern_description: description || `Test pattern: ${name}`,
      doctrine: `Test doctrine for ${name}`,
      facets,
    })
  );
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.message);
  const applied = await store.applyChange(parsed.change_id);
  return JSON.parse(applied);
}

// Helper: create an entry
async function createEntry(store: DurableObjectStub<HiveDO>, pattern: string, data: Record<string, unknown>) {
  const result = await store.mutate(pattern, "create", JSON.stringify(data));
  return JSON.parse(result);
}

// Helper: approve a host for federation (the consent gate lives at the MCP
// tool layer; HiveDO RPC writes the allow-list row directly).
async function allowFederation(store: DurableObjectStub<HiveDO>, host: string) {
  const result = await store.mutate("_federation_hosts", "create", JSON.stringify({ host }));
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.message);
  return parsed;
}

// === Index & Schema ===

describe("Index", () => {
  it("returns a valid index on fresh store", async () => {
    const store = getStore();
    const result = JSON.parse(await store.getIndex());
    expect(result.version).toBeTypeOf("number");
    expect(result.guidance).toBeTypeOf("string");
    expect(result.patterns).toBeInstanceOf(Array);
    expect(result.charter).toBeTypeOf("object");
    expect(result.system_docs).toBe("mnemion://_system/");
  });

  it("includes kernel patterns in the index", async () => {
    const store = getStore();
    const result = JSON.parse(await store.getIndex());
    const names = result.patterns.map((p: any) => p.name);
    expect(names).toContain("_access_tokens");
    expect(names).toContain("_system_docs");
    expect(names).toContain("_shared");
  });
});

// === Schema Evolution ===

describe("Schema Evolution", () => {
  it("creates a pattern with propose + apply", async () => {
    const store = getStore();
    const result = await createPattern(store, "tasks", [
      { name: "title", type: "text", required: true },
      { name: "status", type: "text" },
      { name: "priority", type: "integer" },
    ]);
    expect(result.applied).toBe(true);

    const index = JSON.parse(await store.getIndex());
    const task = index.patterns.find((p: any) => p.name === "tasks");
    expect(task).toBeDefined();
    expect(task.facets).toHaveLength(3);
  });

  it("rejects duplicate pattern names", async () => {
    const store = getStore();
    await createPattern(store, "items", [{ name: "label", type: "text" }]);
    const result = await store.proposeChange(
      "Duplicate",
      JSON.stringify({ type: "create_pattern", pattern_name: "items", doctrine: "test", facets: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("adds facets to existing pattern", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text", required: true }]);

    const propose = await store.proposeChange(
      "Add tag",
      JSON.stringify({ type: "add_facet", pattern_name: "notes", facets: [{ name: "tag", type: "text" }] })
    );
    const parsed = JSON.parse(propose);
    expect(parsed.change_id).toBeDefined();
    await store.applyChange(parsed.change_id);

    const schema = JSON.parse(await store.getSchema("notes"));
    const facetNames = schema.facets.map((f: any) => f.name);
    expect(facetNames).toContain("tag");
  });

  it("rejects kernel column names as facets", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad facet",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "bad-pat",
        doctrine: "test",
        facets: [{ name: "id", type: "integer" }],
      })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("includes charter in index", async () => {
    const store = getStore();
    await store.mutate("_charter", "create", JSON.stringify({ key: "owner", value: "test-user" }));
    await store.mutate("_charter", "create", JSON.stringify({ key: "purpose", value: "testing" }));

    const index = JSON.parse(await store.getIndex());
    expect(index.charter).toEqual({ owner: "test-user", purpose: "testing" });
  });

  it("supports foreign key links", async () => {
    const store = getStore();
    await createPattern(store, "projects", [{ name: "name", type: "text", required: true }]);
    await createPattern(store, "milestones", [
      { name: "title", type: "text", required: true },
      { name: "project_id", type: "integer", required: true, links: { pattern: "projects" } },
    ]);

    const schema = JSON.parse(await store.getSchema("milestones"));
    const projectFacet = schema.facets.find((f: any) => f.name === "project_id");
    expect(projectFacet.links).toBe("projects");
  });

  it("rejects links to non-existent patterns", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad link",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "orphans",
        doctrine: "test",
        facets: [{ name: "parent_id", type: "integer", links: { pattern: "nonexistent" } }],
      })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("records schema history", async () => {
    const store = getStore();
    await createPattern(store, "logs", [{ name: "message", type: "text" }]);

    const history = JSON.parse(await store.getHistory(10));
    expect(history.history.length).toBeGreaterThan(0);
    expect(history.history[0].change_type).toBe("create_pattern");
  });
});

// === Name Validation ===

describe("Name Validation", () => {
  it("rejects uppercase pattern names", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad name",
      JSON.stringify({ type: "create_pattern", pattern_name: "BadName", facets: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("rejects names starting with numbers", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad name",
      JSON.stringify({ type: "create_pattern", pattern_name: "123abc", facets: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("rejects names with spaces", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad name",
      JSON.stringify({ type: "create_pattern", pattern_name: "my pattern", facets: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("accepts valid kebab-case names", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Good name",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "my-cool-pattern",
        doctrine: "test",
        facets: [{ name: "some_facet", type: "text" }],
      })
    );
    expect(JSON.parse(result).change_id).toBeDefined();
  });

  it("rejects names exceeding 64 characters", async () => {
    const store = getStore();
    const longName = "a".repeat(65);
    const result = await store.proposeChange(
      "Long name",
      JSON.stringify({ type: "create_pattern", pattern_name: longName, facets: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("rejects uppercase facet names", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad facet",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "valid-pat",
        doctrine: "test",
        facets: [{ name: "BadFacet", type: "text" }],
      })
    );
    expect(JSON.parse(result).error).toBe(true);
  });
});

// === Facet Limits ===

describe("Facet Limits", () => {
  it("rejects patterns with more than 64 facets", async () => {
    const store = getStore();
    const facets = Array.from({ length: 65 }, (_, i) => ({
      name: `facet_${i}`,
      type: "text",
    }));
    const result = await store.proposeChange(
      "Too many facets",
      JSON.stringify({ type: "create_pattern", pattern_name: "wide-table", doctrine: "test", facets })
    );
    expect(JSON.parse(result).error).toBe(true);
    expect(JSON.parse(result).message).toContain("64");
  });
});

// === CRUD Operations ===

describe("Mutate - Create", () => {
  it("creates an entry and returns it with kernel columns", async () => {
    const store = getStore();
    await createPattern(store, "people", [
      { name: "name", type: "text", required: true },
      { name: "age", type: "integer" },
    ]);

    const result = await createEntry(store, "people", { name: "Alice", age: 30 });
    expect(result.entry.id).toBeTypeOf("number");
    expect(result.entry.name).toBe("Alice");
    expect(result.entry.age).toBe(30);
    expect(result.entry.created_at).toBeDefined();
    expect(result.entry.updated_at).toBeDefined();
    expect(result.entry.archived_at).toBeNull();
    expect(result.entry.version).toBe(0);
  });

  it("rejects creates on non-existent patterns", async () => {
    const store = getStore();
    const result = JSON.parse(await store.mutate("nonexistent", "create", JSON.stringify({ x: 1 })));
    expect(result.error).toBe(true);
  });
});

describe("Mutate - Update", () => {
  it("updates an entry and increments version", async () => {
    const store = getStore();
    await createPattern(store, "widgets", [{ name: "color", type: "text" }]);
    const created = await createEntry(store, "widgets", { color: "red" });

    const result = JSON.parse(
      await store.mutate("widgets", "update", JSON.stringify({ id: created.entry.id, color: "blue" }))
    );
    expect(result.entry.color).toBe("blue");
    expect(result.entry.version).toBe(1);
  });

  it("supports optimistic locking via version", async () => {
    const store = getStore();
    await createPattern(store, "docs", [{ name: "content", type: "text" }]);
    const created = await createEntry(store, "docs", { content: "v1" });

    // Update with correct version
    const ok = JSON.parse(
      await store.mutate("docs", "update", JSON.stringify({ id: created.entry.id, content: "v2", version: 0 }))
    );
    expect(ok.entry.content).toBe("v2");
    expect(ok.entry.version).toBe(1);

    // Update with stale version
    const conflict = JSON.parse(
      await store.mutate("docs", "update", JSON.stringify({ id: created.entry.id, content: "v3", version: 0 }))
    );
    expect(conflict.error).toBe(true);
    expect(conflict.message).toContain("Version conflict");
  });

  it("allows update without version (last-write-wins)", async () => {
    const store = getStore();
    await createPattern(store, "memos", [{ name: "text", type: "text" }]);
    const created = await createEntry(store, "memos", { text: "original" });

    const result = JSON.parse(
      await store.mutate("memos", "update", JSON.stringify({ id: created.entry.id, text: "changed" }))
    );
    expect(result.entry.text).toBe("changed");
  });

  it("requires id for update", async () => {
    const store = getStore();
    await createPattern(store, "things", [{ name: "val", type: "text" }]);
    const result = JSON.parse(await store.mutate("things", "update", JSON.stringify({ val: "x" })));
    expect(result.error).toBe(true);
  });
});

describe("Mutate - Archive", () => {
  it("soft-deletes an entry", async () => {
    const store = getStore();
    await createPattern(store, "items", [{ name: "title", type: "text" }]);
    const created = await createEntry(store, "items", { title: "delete me" });

    await store.mutate("items", "archive", JSON.stringify({ id: created.entry.id }));

    // Should not appear in queries
    const query = JSON.parse(await store.query("items", "", "", "", 100, false));
    expect(query.entries).toHaveLength(0);
  });
});

// === User Version Field (e.g. semver on _plugins) ===

describe("User Version Field", () => {
  it("allows creating entries with a user-defined version field", async () => {
    const store = getStore();
    await createPattern(store, "packages", [
      { name: "name", type: "text", required: true },
      { name: "pkg_version", type: "text", required: true },
    ]);

    const result = await createEntry(store, "packages", { name: "my-pkg", pkg_version: "1.0.0" });
    expect(result.error).toBeUndefined();
    expect(result.entry.pkg_version).toBe("1.0.0");
    // Should also have a kernel version column
    expect(result.entry.version).toBe(0);
  });

  it("handles tables where user version field shadows kernel version", async () => {
    const store = getStore();
    await createPattern(store, "versioned-pkgs", [
      { name: "name", type: "text", required: true },
      { name: "version", type: "text", required: true },
    ]);

    const result = await createEntry(store, "versioned-pkgs", { name: "pkg", version: "1.0.0" });
    expect(result.error).toBeUndefined();
    expect(result.entry.version).toBe("1.0.0");
  });

  it("allows updating a user-defined version field", async () => {
    const store = getStore();
    await createPattern(store, "libs", [
      { name: "name", type: "text", required: true },
      { name: "version", type: "text", required: true },
    ]);
    const created = await createEntry(store, "libs", { name: "my-lib", version: "1.0.0" });
    expect(created.error).toBeUndefined();

    const result = JSON.parse(
      await store.mutate("libs", "update", JSON.stringify({ id: created.entry.id, version: "2.0.0" }))
    );
    expect(result.entry.version).toBe("2.0.0");
  });

  it("does not auto-increment user version fields", async () => {
    const store = getStore();
    await createPattern(store, "modules", [
      { name: "name", type: "text", required: true },
      { name: "version", type: "text", required: true },
    ]);
    const created = await createEntry(store, "modules", { name: "mod", version: "0.1.0" });
    expect(created.error).toBeUndefined();

    const result = JSON.parse(
      await store.mutate("modules", "update", JSON.stringify({ id: created.entry.id, name: "mod-renamed" }))
    );
    // version should stay as the original string, not become an integer
    expect(result.entry.version).toBe("0.1.0");
  });
});

// === Batch Mutate ===

describe("Batch Mutate", () => {
  it("executes multiple operations atomically", async () => {
    const store = getStore();
    await createPattern(store, "counters", [
      { name: "name", type: "text", required: true },
      { name: "value", type: "integer" },
    ]);

    const result = JSON.parse(
      await store.batchMutate(
        JSON.stringify([
          { pattern: "counters", operation: "create", data: { name: "a", value: 1 } },
          { pattern: "counters", operation: "create", data: { name: "b", value: 2 } },
          { pattern: "counters", operation: "create", data: { name: "c", value: 3 } },
        ])
      )
    );
    expect(result.batch).toBe(true);
    expect(result.count).toBe(3);
  });

  it("rolls back all operations on failure", async () => {
    const store = getStore();
    await createPattern(store, "atoms", [{ name: "val", type: "text", required: true }]);

    try {
      await store.batchMutate(
        JSON.stringify([
          { pattern: "atoms", operation: "create", data: { val: "good" } },
          { pattern: "nonexistent", operation: "create", data: { val: "bad" } },
        ])
      );
    } catch {
      // Expected to throw
    }

    // First entry should not exist due to rollback
    const query = JSON.parse(await store.query("atoms", "", "", "", 100, false));
    expect(query.entries).toHaveLength(0);
  });

  it("rejects batches over 100 operations", async () => {
    const store = getStore();
    await createPattern(store, "bulk", [{ name: "x", type: "text" }]);

    const ops = Array.from({ length: 101 }, (_, i) => ({
      pattern: "bulk",
      operation: "create",
      data: { x: `item-${i}` },
    }));

    const result = JSON.parse(await store.batchMutate(JSON.stringify(ops)));
    expect(result.error).toBe(true);
    expect(result.message).toContain("100");
  });
});

// === Entry Size Limit ===

describe("Entry Size Limit", () => {
  it("rejects entries exceeding 1MB", async () => {
    const store = getStore();
    await createPattern(store, "blobs", [{ name: "content", type: "text" }]);

    const bigContent = "x".repeat(600_000); // ~1.2MB in UTF-16 estimate
    const result = JSON.parse(
      await store.mutate("blobs", "create", JSON.stringify({ content: bigContent }))
    );
    expect(result.error).toBe(true);
    expect(result.message).toContain("1MB");
  });
});

// === Query ===

describe("Query", () => {
  it("returns entries with filtering", async () => {
    const store = getStore();
    await createPattern(store, "products", [
      { name: "name", type: "text", required: true },
      { name: "price", type: "number" },
      { name: "category", type: "text" },
    ]);
    await createEntry(store, "products", { name: "Widget", price: 10, category: "tools" });
    await createEntry(store, "products", { name: "Gadget", price: 50, category: "electronics" });
    await createEntry(store, "products", { name: "Wrench", price: 15, category: "tools" });

    const result = JSON.parse(
      await store.query("products", JSON.stringify(["category=tools"]), "", "", 100, false)
    );
    expect(result.entries).toHaveLength(2);
  });

  it("supports facet projection", async () => {
    const store = getStore();
    await createPattern(store, "contacts", [
      { name: "name", type: "text", required: true },
      { name: "email", type: "text" },
    ]);
    await createEntry(store, "contacts", { name: "Bob", email: "bob@test.com" });

    const result = JSON.parse(await store.query("contacts", "", "name", "", 100, false));
    expect(result.entries[0].name).toBe("Bob");
    expect(result.entries[0].email).toBeUndefined();
    // id is always included
    expect(result.entries[0].id).toBeDefined();
  });

  it("supports sorting", async () => {
    const store = getStore();
    await createPattern(store, "scores", [
      { name: "player", type: "text" },
      { name: "points", type: "integer" },
    ]);
    await createEntry(store, "scores", { player: "Alice", points: 100 });
    await createEntry(store, "scores", { player: "Bob", points: 50 });
    await createEntry(store, "scores", { player: "Carol", points: 200 });

    const result = JSON.parse(await store.query("scores", "", "", "-points", 100, false));
    expect(result.entries[0].player).toBe("Carol");
    expect(result.entries[2].player).toBe("Bob");
  });

  it("supports count_only mode", async () => {
    const store = getStore();
    await createPattern(store, "rows", [{ name: "val", type: "integer" }]);
    await createEntry(store, "rows", { val: 1 });
    await createEntry(store, "rows", { val: 2 });

    const result = JSON.parse(await store.query("rows", "", "", "", 100, true));
    expect(result.count).toBe(2);
    expect(result.entries).toBeUndefined();
  });

  it("clamps limit to 1000", async () => {
    const store = getStore();
    await createPattern(store, "capped", [{ name: "x", type: "text" }]);

    // Just verify it doesn't error with a high limit
    const result = JSON.parse(await store.query("capped", "", "", "", 9999, false));
    expect(result.entries).toBeInstanceOf(Array);
  });

  it("excludes archived entries", async () => {
    const store = getStore();
    await createPattern(store, "mixed", [{ name: "label", type: "text" }]);
    const r1 = await createEntry(store, "mixed", { label: "keep" });
    const r2 = await createEntry(store, "mixed", { label: "remove" });
    await store.mutate("mixed", "archive", JSON.stringify({ id: r2.entry.id }));

    const result = JSON.parse(await store.query("mixed", "", "", "", 100, false));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].label).toBe("keep");
  });

  it("supports contains filter (~)", async () => {
    const store = getStore();
    await createPattern(store, "articles", [{ name: "title", type: "text" }]);
    await createEntry(store, "articles", { title: "Introduction to TypeScript" });
    await createEntry(store, "articles", { title: "Python for beginners" });

    const result = JSON.parse(
      await store.query("articles", JSON.stringify(["title~TypeScript"]), "", "", 100, false)
    );
    expect(result.entries).toHaveLength(1);
  });
});

// === Search ===

describe("Search", () => {
  it("finds entries across patterns", async () => {
    const store = getStore();
    await createPattern(store, "books", [{ name: "title", type: "text" }]);
    await createPattern(store, "movies", [{ name: "title", type: "text" }]);
    await createEntry(store, "books", { title: "The Great Gatsby" });
    await createEntry(store, "movies", { title: "The Great Escape" });

    const result = JSON.parse(await store.search("Great", "", 20));
    expect(result.results.length).toBe(2);
  });

  it("limits search to specified patterns", async () => {
    const store = getStore();
    await createPattern(store, "alpha", [{ name: "text", type: "text" }]);
    await createPattern(store, "beta", [{ name: "text", type: "text" }]);
    await createEntry(store, "alpha", { text: "needle" });
    await createEntry(store, "beta", { text: "needle" });

    const result = JSON.parse(await store.search("needle", JSON.stringify(["alpha"]), 20));
    expect(result.results.length).toBe(1);
    expect(result.results[0].pattern).toBe("alpha");
  });
});

// === URI Resolution ===

describe("Resolve", () => {
  it("resolves mnemion://index", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://index"));
    expect(result.patterns).toBeInstanceOf(Array);
  });

  it("resolves mnemion://history", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://history"));
    expect(result.history).toBeInstanceOf(Array);
  });

  it("resolves mnemion://schema/{pattern}", async () => {
    const store = getStore();
    await createPattern(store, "resolvable", [{ name: "x", type: "text" }]);
    const result = JSON.parse(await store.resolve("mnemion://schema/resolvable"));
    expect(result.pattern).toBe("resolvable");
    expect(result.facets).toBeInstanceOf(Array);
  });

  it("resolves mnemion://entry/{pattern}/{id}", async () => {
    const store = getStore();
    await createPattern(store, "lookups", [{ name: "val", type: "text" }]);
    const created = await createEntry(store, "lookups", { val: "found" });
    const result = JSON.parse(await store.resolve(`mnemion://entry/lookups/${created.entry.id}`));
    expect(result.entry.val).toBe("found");
  });

  it("resolves mnemion://_system/", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://_system/"));
    expect(result.docs).toBeInstanceOf(Array);
    expect(result.docs.length).toBeGreaterThan(0);
  });

  it("resolves mnemion://_system/{slug}", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://_system/tools"));
    expect(result.slug).toBe("tools");
    expect(result.content).toContain("mutate");
  });

  it("resolves mnemion://mutation", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://mutation"));
    expect(result.mutations).toBeInstanceOf(Array);
  });

  it("rejects invalid URIs", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("https://example.com"));
    expect(result.error).toBe(true);
  });

  it("rejects unknown paths", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://nonexistent/path"));
    expect(result.error).toBe(true);
  });

  // === Federated resolve ===

  it("resolves foreign URI over HTTP", async () => {
    const store = getStore();
    await allowFederation(store, "other.hive.dev");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://other.hive.dev")
      .intercept({ path: "/o/records/axioms/7" })
      .reply(200, JSON.stringify({ id: 7, axiom: "Federation is just HTTP." }), {
        headers: { "Content-Type": "application/json" },
      });

    const result = JSON.parse(await store.resolve("mnemion://other.hive.dev/records/axioms/7"));
    expect(result.federated).toBe(true);
    expect(result.host).toBe("other.hive.dev");
    expect(result.path).toBe("records/axioms/7");
    expect(result.content.axiom).toBe("Federation is just HTTP.");

    fetchMock.deactivate();
  });

  it("passes token as Bearer header for private access", async () => {
    const store = getStore();
    await allowFederation(store, "private.hive.dev");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://private.hive.dev")
      .intercept({
        path: "/o/records/secrets/1",
        headers: { Authorization: "Bearer abc123" },
      })
      .reply(200, "classified", { headers: { "Content-Type": "text/plain" } });

    const result = JSON.parse(await store.resolve("mnemion://private.hive.dev/records/secrets/1?token=abc123"));
    expect(result.federated).toBe(true);
    expect(result.content).toBe("classified");

    fetchMock.deactivate();
  });

  it("refuses to federate with a host not on the allow-list (no fetch, no token leak)", async () => {
    const store = getStore();
    // Net is disabled and no interceptor is registered: if resolve tried to
    // fetch, it would throw. A clean allow-list refusal must not touch the net.
    fetchMock.activate();
    fetchMock.disableNetConnect();

    const result = JSON.parse(await store.resolve("mnemion://unapproved.hive.dev/records/secrets/1?token=supersecret"));
    expect(result.error).toBe(true);
    expect(result.message).toContain("allow-list");
    expect(result.message).not.toContain("supersecret");

    fetchMock.deactivate();
  });

  it("refuses to federate with internal/link-local hosts even if somehow allow-listed", async () => {
    const store = getStore();
    // The kernel hook rejects adding a non-public host to the allow-list…
    const added = JSON.parse(await store.mutate("_federation_hosts", "create", JSON.stringify({ host: "169.254.169.254" })));
    expect(added.error).toBe(true);

    // …and resolve refuses it regardless.
    const result = JSON.parse(await store.resolve("mnemion://169.254.169.254/o/whatever"));
    expect(result.error).toBe(true);
  });

  it("normalizes federation hosts and matches case-insensitively", async () => {
    const store = getStore();
    await allowFederation(store, "MixedCase.Hive.Dev");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://mixedcase.hive.dev")
      .intercept({ path: "/o/records/axioms/1" })
      .reply(200, JSON.stringify({ id: 1 }), { headers: { "Content-Type": "application/json" } });

    const result = JSON.parse(await store.resolve("mnemion://mixedcase.hive.dev/records/axioms/1"));
    expect(result.federated).toBe(true);

    fetchMock.deactivate();
  });

  it("returns error for 404 from foreign hive", async () => {
    const store = getStore();
    await allowFederation(store, "other.hive.dev");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://other.hive.dev")
      .intercept({ path: "/o/missing/path" })
      .reply(404, "Not found");

    const result = JSON.parse(await store.resolve("mnemion://other.hive.dev/missing/path"));
    expect(result.error).toBe(true);
    expect(result.message).toContain("Not found");

    fetchMock.deactivate();
  });

  it("returns error for 401 from foreign hive", async () => {
    const store = getStore();
    await allowFederation(store, "locked.hive.dev");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://locked.hive.dev")
      .intercept({ path: "/o/private/data" })
      .reply(401, "Unauthorized");

    const result = JSON.parse(await store.resolve("mnemion://locked.hive.dev/private/data"));
    expect(result.error).toBe(true);
    expect(result.message).toContain("requires authorization");

    fetchMock.deactivate();
  });

  it("requires a path after the foreign host", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://other.hive.dev"));
    expect(result.error).toBe(true);
    expect(result.message).toContain("requires a path");
  });

  it("does not treat local URIs as foreign", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://index"));
    expect(result.error).toBeUndefined();
    expect(result.patterns).toBeInstanceOf(Array);
  });

  it("does not treat dotted pattern names as foreign", async () => {
    const store = getStore();
    await createPattern(store, "dotted", [{ name: "v", type: "text" }]);
    const result = JSON.parse(await store.resolve("mnemion://schema/dotted"));
    expect(result.error).toBeUndefined();
    expect(result.pattern).toBe("dotted");
  });
});

// === Web resolution: Bluesky ===

describe("Bluesky resolution", () => {
  // A thread whose root post quotes another post and embeds an image.
  function threadFixture() {
    return {
      thread: {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: {
          uri: "at://did:plc:alice/app.bsky.feed.post/abc123",
          author: { handle: "alice.bsky.social", displayName: "Alice" },
          record: { text: "Hello world", createdAt: "2026-01-01T00:00:00.000Z" },
          embed: {
            $type: "app.bsky.embed.recordWithMedia#view",
            media: {
              $type: "app.bsky.embed.images#view",
              images: [{
                thumb: "https://cdn.bsky.app/img/thumb.jpg",
                fullsize: "https://cdn.bsky.app/img/full.jpg",
                alt: "a tabby cat",
              }],
            },
            record: {
              $type: "app.bsky.embed.record#view",
              record: {
                $type: "app.bsky.embed.record#viewRecord",
                uri: "at://did:plc:bob/app.bsky.feed.post/xyz789",
                author: { handle: "bob.bsky.social", displayName: "Bob" },
                value: { text: "The quoted thought" },
              },
            },
          },
        },
        replies: [],
      },
    };
  }

  function mockThread() {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://public.api.bsky.app")
      .intercept({ path: /\/xrpc\/app\.bsky\.feed\.getPostThread/ })
      .reply(200, JSON.stringify(threadFixture()), {
        headers: { "Content-Type": "application/json" },
      });
  }

  it("resolves a bsky.app post URL with image and quoted-post embeds", async () => {
    const store = getStore();
    mockThread();

    const result = JSON.parse(await store.resolve("https://bsky.app/profile/alice.bsky.social/post/abc123"));
    expect(result.source).toBe("bluesky");
    expect(result.content).toContain("**Alice** (@alice.bsky.social)");
    expect(result.content).toContain("Hello world");
    // Image embed path surfaced with alt text
    expect(result.content).toContain("[image: https://cdn.bsky.app/img/full.jpg — a tabby cat]");
    // Quoted post surfaced as a blockquote
    expect(result.content).toContain("[quoting **Bob** (@bob.bsky.social)]");
    expect(result.content).toContain("> The quoted thought");
    expect(result.metadata.at_uri).toBe("at://alice.bsky.social/app.bsky.feed.post/abc123");

    fetchMock.deactivate();
  });

  it("resolves a raw at:// post URI with a DID authority", async () => {
    const store = getStore();
    mockThread();

    const result = JSON.parse(await store.resolve("at://did:plc:alice/app.bsky.feed.post/abc123"));
    expect(result.source).toBe("bluesky");
    expect(result.content).toContain("Hello world");
    expect(result.metadata.authority).toBe("did:plc:alice");
    expect(result.metadata.at_uri).toBe("at://did:plc:alice/app.bsky.feed.post/abc123");

    fetchMock.deactivate();
  });

  it("rejects at:// URIs that are not Bluesky posts", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("at://did:plc:alice/app.bsky.actor.profile/self"));
    expect(result.error).toBe(true);
    expect(result.message).toContain("No adapter matched");
  });

  it("limits reply depth via ?depth=N and passes it through to the API", async () => {
    const store = getStore();
    // Nested reply chain: level 1 → level 2 → level 3
    const deep = {
      thread: {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: {
          author: { handle: "alice.bsky.social", displayName: "Alice" },
          record: { text: "root post", createdAt: "2026-01-01T00:00:00.000Z" },
        },
        replies: [{
          post: { author: { handle: "r1.bsky.social" }, record: { text: "reply level 1" } },
          replies: [{
            post: { author: { handle: "r2.bsky.social" }, record: { text: "reply level 2" } },
            replies: [{
              post: { author: { handle: "r3.bsky.social" }, record: { text: "reply level 3" } },
            }],
          }],
        }],
      },
    };
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://public.api.bsky.app")
      .intercept({ path: /getPostThread.*depth=2(&|$)/ })
      .reply(200, JSON.stringify(deep), { headers: { "Content-Type": "application/json" } });

    const result = JSON.parse(await store.resolve("at://did:plc:alice/app.bsky.feed.post/abc123?depth=2"));
    expect(result.source).toBe("bluesky");
    expect(result.metadata.depth).toBe(2);
    expect(result.content).toContain("reply level 1");
    expect(result.content).toContain("reply level 2");
    // Beyond the requested depth — omitted
    expect(result.content).not.toContain("reply level 3");

    fetchMock.deactivate();
  });

  it("clamps an over-large ?depth to the maximum", async () => {
    const store = getStore();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://public.api.bsky.app")
      .intercept({ path: /getPostThread.*depth=100(&|$)/ })
      .reply(200, JSON.stringify({ thread: { post: { author: { handle: "a.bsky.social" }, record: { text: "hi" } } } }), {
        headers: { "Content-Type": "application/json" },
      });

    const result = JSON.parse(await store.resolve("https://bsky.app/profile/a.bsky.social/post/abc123?depth=999"));
    expect(result.metadata.depth).toBe(100);

    fetchMock.deactivate();
  });
});

// === Entry Sharing ===

describe("Sharing", () => {
  it("shares an entry via set_sharing propose/apply", async () => {
    const store = getStore();
    await createPattern(store, "shareable", [{ name: "title", type: "text" }]);
    const created = await createEntry(store, "shareable", { title: "Hello world" });

    const proposed = JSON.parse(await store.proposeChange(
      "Share entry",
      JSON.stringify({ type: "set_sharing", pattern_name: "shareable", entry_id: created.entry.id, visibility: "public" })
    ));
    expect(proposed.change_id).toBeTruthy();

    const applied = JSON.parse(await store.applyChange(proposed.change_id));
    expect(applied.applied).toBe(true);

    // Entry should now be retrievable via getSharedEntry
    const shared = JSON.parse(await store.getSharedEntry("shareable", created.entry.id));
    expect(shared.found).toBe(true);
    expect(shared.visibility).toBe("public");
    expect(shared.entry.title).toBe("Hello world");
  });

  it("unshares an entry by setting visibility to private", async () => {
    const store = getStore();
    await createPattern(store, "unshare-test", [{ name: "v", type: "text" }]);
    const created = await createEntry(store, "unshare-test", { v: "secret" });

    // Share it
    const p1 = JSON.parse(await store.proposeChange("Share", JSON.stringify({ type: "set_sharing", pattern_name: "unshare-test", entry_id: created.entry.id, visibility: "public" })));
    await store.applyChange(p1.change_id);

    // Unshare it
    const p2 = JSON.parse(await store.proposeChange("Unshare", JSON.stringify({ type: "set_sharing", pattern_name: "unshare-test", entry_id: created.entry.id, visibility: "private" })));
    await store.applyChange(p2.change_id);

    const shared = JSON.parse(await store.getSharedEntry("unshare-test", created.entry.id));
    expect(shared.found).toBe(false);
  });

  it("returns not found for unshared entries", async () => {
    const store = getStore();
    await createPattern(store, "private-pat", [{ name: "v", type: "text" }]);
    const created = await createEntry(store, "private-pat", { v: "hidden" });

    const shared = JSON.parse(await store.getSharedEntry("private-pat", created.entry.id));
    expect(shared.found).toBe(false);
  });

  it("supports unlisted visibility", async () => {
    const store = getStore();
    await createPattern(store, "unlisted-pat", [{ name: "v", type: "text" }]);
    const created = await createEntry(store, "unlisted-pat", { v: "link only" });

    const p = JSON.parse(await store.proposeChange("Unlisted share", JSON.stringify({ type: "set_sharing", pattern_name: "unlisted-pat", entry_id: created.entry.id, visibility: "unlisted" })));
    await store.applyChange(p.change_id);

    const shared = JSON.parse(await store.getSharedEntry("unlisted-pat", created.entry.id));
    expect(shared.found).toBe(true);
    expect(shared.visibility).toBe("unlisted");
  });

  it("rejects invalid visibility", async () => {
    const store = getStore();
    await createPattern(store, "bad-vis", [{ name: "v", type: "text" }]);
    const created = await createEntry(store, "bad-vis", { v: "x" });

    const result = JSON.parse(await store.proposeChange("Bad vis", JSON.stringify({ type: "set_sharing", pattern_name: "bad-vis", entry_id: created.entry.id, visibility: "secret" })));
    expect(result.error).toBe(true);
    expect(result.message).toContain("Invalid visibility");
  });

  it("rejects sharing nonexistent entry", async () => {
    const store = getStore();
    await createPattern(store, "no-entry", [{ name: "v", type: "text" }]);

    const result = JSON.parse(await store.proposeChange("Share ghost", JSON.stringify({ type: "set_sharing", pattern_name: "no-entry", entry_id: 999 })));
    expect(result.error).toBe(true);
    expect(result.message).toContain("not found");
  });

  it("changes visibility from public to unlisted", async () => {
    const store = getStore();
    await createPattern(store, "revis", [{ name: "v", type: "text" }]);
    const created = await createEntry(store, "revis", { v: "data" });

    // Share as public
    const p1 = JSON.parse(await store.proposeChange("Public", JSON.stringify({ type: "set_sharing", pattern_name: "revis", entry_id: created.entry.id, visibility: "public" })));
    await store.applyChange(p1.change_id);

    // Change to unlisted
    const p2 = JSON.parse(await store.proposeChange("Unlisted", JSON.stringify({ type: "set_sharing", pattern_name: "revis", entry_id: created.entry.id, visibility: "unlisted" })));
    await store.applyChange(p2.change_id);

    const shared = JSON.parse(await store.getSharedEntry("revis", created.entry.id));
    expect(shared.visibility).toBe("unlisted");
  });

  it("does not allow SQL injection via the pattern name to exfiltrate unshared data", async () => {
    const store = getStore();
    // Create a private pattern with a secret and never share it.
    await createPattern(store, "injsecret", [{ name: "v", type: "text" }]);
    const created = await createEntry(store, "injsecret", { v: "top-secret-value" });

    // Classic identifier-escape payload: close the quoted table name and turn
    // the sharing JOIN into a LEFT JOIN so rows return without a _shared row.
    const payload = `injsecret" e LEFT JOIN "_shared`;
    const result = JSON.parse(await store.getSharedEntry(payload, created.entry.id));
    expect(result.found).toBe(false);
  });

  it("rejects access-token exfiltration via crafted pattern name", async () => {
    const store = getStore();
    // _access_tokens is a kernel table; it must never be reachable here, even
    // with an injection payload, regardless of how the JOIN is rewritten.
    const payload = `_access_tokens" e LEFT JOIN "_shared`;
    const result = JSON.parse(await store.getSharedEntry(payload, 1));
    expect(result.found).toBe(false);
  });
});

// === System Docs ===

describe("System Docs", () => {
  it("seeds system docs on fresh store", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://_system/"));
    const slugs = result.docs.map((d: any) => d.slug);
    expect(slugs).toContain("tools");
    expect(slugs).toContain("schema-evolution");
    expect(slugs).toContain("skills");
    expect(slugs).toContain("conventions");
    expect(slugs).toContain("index-guide");
  });

  it("returns default content when content is null", async () => {
    const store = getStore();
    const doc = JSON.parse(await store.resolve("mnemion://_system/tools"));
    expect(doc.is_default).toBe(true);

    const updated = JSON.parse(
      await store.mutate("_system_docs", "update", JSON.stringify({ id: 1, content: null }))
    );
    if (updated.error) return;

    const restored = JSON.parse(await store.resolve("mnemion://_system/tools"));
    expect(restored.content).toContain("mutate");
    expect(restored.is_default).toBe(true);
  });

  it("protects default_content from writes", async () => {
    const store = getStore();
    const result = JSON.parse(
      await store.mutate("_system_docs", "update", JSON.stringify({ id: 1, default_content: "hacked" }))
    );
    expect(result.error).toBe(true);
    expect(result.message).toContain("immutable");
  });

  it("resolves /default variant for original seed", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("mnemion://_system/tools/default"));
    expect(result.content).toContain("mutate");
    expect(result.is_default).toBe(true);
  });
});

// === Access Tokens ===

describe("Access Tokens", () => {
  // Helper: mint an upload token via _access_tokens
  async function mintUploadToken(store: DurableObjectStub<HiveDO>, target: { target_pattern: string; target_id: number; target_facet: string; mode?: string }) {
    const result = JSON.parse(
      await store.mutate("_access_tokens", "create", JSON.stringify({
        scope: "upload",
        constraints: JSON.stringify(target),
      }))
    );
    return result;
  }

  it("mints a token with auto-generated fields", async () => {
    const store = getStore();
    await createPattern(store, "uploads-target", [{ name: "content", type: "text" }]);
    const entry = await createEntry(store, "uploads-target", { content: "original" });

    const result = await mintUploadToken(store, {
      target_pattern: "uploads-target",
      target_id: entry.entry.id,
      target_facet: "content",
    });
    expect(result.entry.token).toBeDefined();
    expect(result.entry.token.length).toBe(32);
    expect(result.entry.expires_at).toBeDefined();
    expect(result.entry.single_use).toBe(1);
    expect(result.entry.consumed_at).toBeNull();
  });

  it("rejects upload tokens targeting non-existent patterns", async () => {
    const store = getStore();
    const result = await mintUploadToken(store, {
      target_pattern: "ghost",
      target_id: 1,
      target_facet: "content",
    });
    expect(result.error).toBe(true);
  });

  it("rejects upload tokens targeting non-text facets", async () => {
    const store = getStore();
    await createPattern(store, "nums", [{ name: "count", type: "integer" }]);
    await createEntry(store, "nums", { count: 0 });

    const result = await mintUploadToken(store, {
      target_pattern: "nums",
      target_id: 1,
      target_facet: "count",
    });
    expect(result.error).toBe(true);
    expect(result.message).toContain("text type");
  });

  it("consumes upload and writes content (replace mode)", async () => {
    const store = getStore();
    await createPattern(store, "upload-replace", [{ name: "body", type: "text" }]);
    const entry = await createEntry(store, "upload-replace", { body: "old" });

    const token = await mintUploadToken(store, {
      target_pattern: "upload-replace",
      target_id: entry.entry.id,
      target_facet: "body",
    });

    const result = JSON.parse(await store.consumeUpload(token.entry.token, "new content"));
    expect(result.uploaded).toBe(true);
    expect(result.entry.body).toBe("new content");
  });

  it("consumes upload and appends content (append mode)", async () => {
    const store = getStore();
    await createPattern(store, "upload-append", [{ name: "log", type: "text" }]);
    const entry = await createEntry(store, "upload-append", { log: "line1\n" });

    const token = await mintUploadToken(store, {
      target_pattern: "upload-append",
      target_id: entry.entry.id,
      target_facet: "log",
      mode: "append",
    });

    const result = JSON.parse(await store.consumeUpload(token.entry.token, "line2\n"));
    expect(result.uploaded).toBe(true);
    expect(result.entry.log).toBe("line1\nline2\n");
  });

  it("rejects already-consumed tokens", async () => {
    const store = getStore();
    await createPattern(store, "upload-once", [{ name: "data", type: "text" }]);
    const entry = await createEntry(store, "upload-once", { data: "" });

    const token = await mintUploadToken(store, {
      target_pattern: "upload-once",
      target_id: entry.entry.id,
      target_facet: "data",
    });

    await store.consumeUpload(token.entry.token, "first");
    const second = JSON.parse(await store.consumeUpload(token.entry.token, "second"));
    expect(second.error).toBe(true);
    expect(second.message).toContain("already been used");
  });

  it("rejects content exceeding 1MB", async () => {
    const store = getStore();
    await createPattern(store, "upload-big", [{ name: "data", type: "text" }]);
    const entry = await createEntry(store, "upload-big", { data: "" });

    const token = await mintUploadToken(store, {
      target_pattern: "upload-big",
      target_id: entry.entry.id,
      target_facet: "data",
    });

    const big = "x".repeat(1_100_000);
    const result = JSON.parse(await store.consumeUpload(token.entry.token, big));
    expect(result.error).toBe(true);
    expect(result.message).toContain("1MB");
  });

  it("rejects invalid tokens", async () => {
    const store = getStore();
    const result = JSON.parse(await store.consumeUpload("nonexistent", "data"));
    expect(result.error).toBe(true);
  });

  it("validates scoped tokens with hierarchical matching", async () => {
    const store = getStore();
    // Create a wildcard token
    const wide = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ label: "wide", scope: "read" })));
    expect(await store.validateAccessToken(wide.entry.token, "read:entry:axioms:7")).toBe(true);

    // Create a narrow token
    const narrow = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ label: "narrow", scope: "read:entry:axioms" })));
    expect(await store.validateAccessToken(narrow.entry.token, "read:entry:axioms:7")).toBe(true);
    expect(await store.validateAccessToken(narrow.entry.token, "read:output:page")).toBe(false);

    // Wildcard scope
    const star = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ label: "star" })));
    expect(await store.validateAccessToken(star.entry.token, "anything")).toBe(true);
  });
});

// === Kernel-target write boundary (exfiltration hardening) ===
//
// Ingress and upload reach the data layer outside the MCP tool layer, so they
// must enforce the user-pattern boundary themselves: kernel/_-prefixed patterns
// are never valid ingress or upload targets. This blocks publishing private
// entries via _shared and poisoning _web_cache / _system_docs.

describe("kernel-target write boundary", () => {
  it("refuses upload tokens targeting kernel patterns at mint time", async () => {
    const store = getStore();
    for (const target of ["_web_cache", "_system_docs", "_shared"]) {
      const result = JSON.parse(
        await store.mutate("_access_tokens", "create", JSON.stringify({
          scope: "upload",
          constraints: JSON.stringify({ target_pattern: target, target_id: 1, target_facet: "content" }),
        }))
      );
      expect(result.error).toBe(true);
      expect(result.message).toMatch(/kernel pattern/);
    }
  });

  it("refuses upload at consume time even if a token names a kernel pattern", async () => {
    // Defense in depth: simulate a pre-fix token by writing the row directly,
    // then confirm consumeUpload still refuses (it uses raw UPDATE, not executeMutate).
    const store = getStore();
    let token = "";
    await runInDurableObject(store, async (_i, state) => {
      token = "deadbeefdeadbeefdeadbeefdeadbeef";
      state.storage.sql.exec(
        `INSERT INTO "_access_tokens" (token, scope, constraints, single_use) VALUES (?, 'upload', ?, 1)`,
        token, JSON.stringify({ target_pattern: "_web_cache", target_id: 1, target_facet: "content", mode: "replace" })
      );
    });
    const result = JSON.parse(await store.consumeUpload(token, "poisoned"));
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/invalid target pattern/);
  });

  it("refuses ingress endpoints targeting kernel patterns", async () => {
    const store = getStore();
    for (const target of ["_shared", "_publications", "_system_docs"]) {
      const result = JSON.parse(
        await store.mutate("_inputs", "create", JSON.stringify({ path: `hook-${target}`, target_pattern: target }))
      );
      expect(result.error).toBe(true);
      expect(result.message).toMatch(/kernel pattern/);
    }
  });

  it("still allows ingress and upload to user patterns", async () => {
    const store = getStore();
    await createPattern(store, "events", [{ name: "body", type: "text" }]);
    const ingress = JSON.parse(await store.mutate("_inputs", "create", JSON.stringify({ path: "ok-hook", target_pattern: "events", body_facet: "body" })));
    expect(ingress.error).toBeUndefined();

    const entry = await createEntry(store, "events", { body: "x" });
    const token = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({
      scope: "upload",
      constraints: JSON.stringify({ target_pattern: "events", target_id: entry.entry.id, target_facet: "body" }),
    })));
    expect(token.error).toBeUndefined();
  });
});

// === Linked-facet identifier validation ===

describe("linked facet validation", () => {
  it("rejects a foreign-key facet name that is not a valid identifier", async () => {
    const store = getStore();
    await createPattern(store, "goals2", [{ name: "title", type: "text", required: true }]);
    const result = JSON.parse(await store.proposeChange(
      "malformed link facet",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "tasks2",
        pattern_description: "x",
        doctrine: "x",
        facets: [
          { name: "title", type: "text", required: true },
          { name: "goal", type: "integer", links: { pattern: "goals2", facet: 'id") --' } },
        ],
      })
    ));
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/Linked facet/);
  });

  it("accepts a valid linked facet", async () => {
    const store = getStore();
    await createPattern(store, "goals3", [{ name: "title", type: "text", required: true }]);
    const result = JSON.parse(await store.proposeChange(
      "valid link",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "tasks3",
        pattern_description: "x",
        doctrine: "x",
        facets: [
          { name: "title", type: "text", required: true },
          { name: "goal", type: "integer", links: { pattern: "goals3", facet: "id" } },
        ],
      })
    ));
    expect(result.error).toBeUndefined();
  });
});

// === Web cache retention (pinning) ===

describe("web cache pinning", () => {
  const URL = "https://bsky.app/profile/alice.bsky.social/post/abc123";

  function mockThread() {
    const fixture = {
      thread: {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: {
          uri: "at://did:plc:alice/app.bsky.feed.post/abc123",
          author: { handle: "alice.bsky.social", displayName: "Alice" },
          record: { text: "Pinned thread content", createdAt: "2026-01-01T00:00:00.000Z" },
        },
        replies: [],
      },
    };
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://public.api.bsky.app")
      .intercept({ path: /\/xrpc\/app\.bsky\.feed\.getPostThread/ })
      .reply(200, JSON.stringify(fixture), { headers: { "Content-Type": "application/json" } });
  }

  async function cacheRow(store: DurableObjectStub<HiveDO>) {
    return await runInDurableObject(store, async (_i, state) =>
      state.storage.sql.exec(`SELECT pinned, expires_at FROM "_web_cache" WHERE url = ? AND archived_at IS NULL`, URL).toArray()[0] as any
    );
  }
  async function expire(store: DurableObjectStub<HiveDO>) {
    await runInDurableObject(store, async (_i, state) => {
      state.storage.sql.exec(`UPDATE "_web_cache" SET expires_at = datetime('now','-1 day') WHERE url = ? AND archived_at IS NULL`, URL);
    });
  }

  it("pins a resolved snapshot and serves it frozen past its TTL without re-fetching", async () => {
    const store = getStore();
    mockThread();

    // resolve with retain → fresh fetch, pinned
    const first = JSON.parse(await store.resolve(URL, true));
    expect(first.content).toContain("Pinned thread content");
    expect(first.pinned).toBe(true);
    expect((await cacheRow(store)).pinned).toBe(1);

    // Backdate past TTL; the one-shot mock is now spent, so any re-fetch would
    // fail. A pinned hit serves from cache WITHOUT attempting a fetch — proven
    // by pinned:true and the absence of the stale-fallback flag.
    await expire(store);
    const second = JSON.parse(await store.resolve(URL));
    expect(second.cached).toBe(true);
    expect(second.pinned).toBe(true);
    expect(second.stale).toBeUndefined();
    expect(second.content).toContain("Pinned thread content");

    fetchMock.deactivate();
  });

  it("releases the pin with retain:false", async () => {
    const store = getStore();
    mockThread();
    await store.resolve(URL, true);
    expect((await cacheRow(store)).pinned).toBe(1);

    const released = JSON.parse(await store.resolve(URL, false));
    expect(released.pinned).toBe(false);
    expect((await cacheRow(store)).pinned).toBe(0);

    fetchMock.deactivate();
  });

  it("keeps _web_cache write-protected against agent mutate", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_web_cache", "update", JSON.stringify({ id: 1, pinned: 1 })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/managed by the system/);
  });
});

// === Mutation Audit Log ===

describe("Mutation Audit Log", () => {
  it("logs create operations", async () => {
    const store = getStore();
    await createPattern(store, "audited", [{ name: "val", type: "text" }]);
    await createEntry(store, "audited", { val: "tracked" });

    const log = JSON.parse(await store.resolve("mnemion://mutation/audited"));
    expect(log.mutations.length).toBeGreaterThan(0);
    const insert = log.mutations.find((m: any) => m.operation === "INSERT");
    expect(insert).toBeDefined();
  });
});

// === Shared hive: members, multi-passkey, token attribution ===
//
// A hive can be shared by several people, each a distinct member who
// authenticates as themselves but reads/writes the same store. The consent
// round-trip lives at the MCP tool layer; these tests drive HiveDO RPC directly.

describe("Shared hive — members", () => {
  it("seeds an active owner member on a fresh store", async () => {
    const store = getStore();
    const owner = JSON.parse(await store.query("_members", JSON.stringify(["label=owner"]), "", "", 10, false, "", ""));
    expect(owner.entries.length).toBe(1);
    expect(owner.entries[0].status).toBe("active");
    expect(owner.entries[0].role).toBe("owner");
    expect(await store.isMemberActive("owner")).toBe(true);
  });

  it("creates an invited member with label + display_name", async () => {
    const store = getStore();
    const res = JSON.parse(await store.mutate("_members", "create", JSON.stringify({
      label: "partner", display_name: "Sam",
    })));
    expect(res.error).toBeUndefined();
    expect(res.entry.label).toBe("partner");
    expect(res.entry.role).toBe("member");
    expect(res.entry.status).toBe("active");
    expect(await store.isMemberActive("partner")).toBe(true);
  });

  it("reserves the owner label and the owner role", async () => {
    const store = getStore();
    const dup = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "owner" })));
    expect(dup.error).toBe(true);
    const role = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "x", role: "owner" })));
    expect(role.error).toBe(true);
  });

  it("makes a member's label immutable but display_name editable", async () => {
    const store = getStore();
    const m = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "kai", display_name: "Kai" })));
    const relabel = JSON.parse(await store.mutate("_members", "update", JSON.stringify({ id: m.entry.id, version: m.entry.version, label: "kai2" })));
    expect(relabel.error).toBe(true);
    const rename = JSON.parse(await store.mutate("_members", "update", JSON.stringify({ id: m.entry.id, version: m.entry.version, display_name: "Kai R." })));
    expect(rename.error).toBeUndefined();
  });

  it("treats a suspended member as inactive", async () => {
    const store = getStore();
    const m = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "temp", display_name: "Temp" })));
    expect(await store.isMemberActive("temp")).toBe(true);
    await store.mutate("_members", "update", JSON.stringify({ id: m.entry.id, version: m.entry.version, status: "suspended" }));
    expect(await store.isMemberActive("temp")).toBe(false);
  });
});

describe("Shared hive — token attribution", () => {
  it("resolves a wildcard token's actor to the owner sentinel", async () => {
    const store = getStore();
    const star = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ label: "api" })));
    expect(await store.resolveTokenActor(star.entry.token, "*")).toBe("owner");
  });

  it("resolves an access token's actor to its member", async () => {
    const store = getStore();
    await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" }));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ label: "sam-cli", member: "partner" })));
    expect(await store.resolveTokenActor(tok.entry.token, "*")).toBe("partner");
  });

  it("refuses a token whose member has been suspended", async () => {
    const store = getStore();
    const m = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" })));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ member: "partner" })));
    expect(await store.resolveTokenActor(tok.entry.token, "*")).toBe("partner");
    await store.mutate("_members", "update", JSON.stringify({ id: m.entry.id, version: m.entry.version, status: "suspended" }));
    expect(await store.resolveTokenActor(tok.entry.token, "*")).toBeNull();
  });
});

describe("Shared hive — register tokens (invite)", () => {
  it("forces single-use and pins the member into constraints", async () => {
    const store = getStore();
    await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" }));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "partner" })));
    expect(tok.error).toBeUndefined();
    expect(tok.entry.single_use).toBe(1);
    expect(JSON.parse(tok.entry.constraints).member).toBe("partner");
  });

  it("requires a member for register scope", async () => {
    const store = getStore();
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register" })));
    expect(tok.error).toBe(true);
  });

  it("is inert until approved, then resolves to the member's setup identity (never as an API token)", async () => {
    const store = getStore();
    await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" }));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "partner" })));

    // Before approval: the approval page can see it, but /setup refuses it.
    const info = await store.getRegisterToken(tok.entry.token);
    expect(info!.approved).toBe(false);
    expect(info!.userDisplayName).toBe("Sam");
    expect(await store.resolveRegisterToken(tok.entry.token)).toBeNull();

    // After a member approves: /setup resolves it.
    const approved = await store.approveRegisterToken(tok.entry.token);
    expect(approved!.member).toBe("partner");
    const resolved = await store.resolveRegisterToken(tok.entry.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.member).toBe("partner");
    expect(resolved!.userName).toBe("partner");

    // A register token must not grant API access, approved or not.
    expect(await store.resolveTokenActor(tok.entry.token, "*")).toBeNull();
  });

  it("never approves an invite for the owner or a non-roster member", async () => {
    const store = getStore();
    // Craft a register token pointing at owner via raw write (bypassing the hook).
    let ownerTok = "", ghostTok = "";
    await runInDurableObject(store, async (_i, state) => {
      ownerTok = "abad1deaabad1deaabad1deaabad1dea";
      ghostTok = "decafbaddecafbaddecafbaddecafbad";
      state.storage.sql.exec(`INSERT INTO "_access_tokens" (token, scope, constraints, single_use) VALUES (?, 'register', ?, 1)`, ownerTok, JSON.stringify({ member: "owner" }));
      state.storage.sql.exec(`INSERT INTO "_access_tokens" (token, scope, constraints, single_use) VALUES (?, 'register', ?, 1)`, ghostTok, JSON.stringify({ member: "ghost" }));
    });
    expect(await store.approveRegisterToken(ownerTok)).toBeNull();
    expect(await store.approveRegisterToken(ghostTok)).toBeNull();
  });

  it("freezes a register token's member/scope/constraints after creation", async () => {
    const store = getStore();
    await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" }));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "partner" })));
    // Repointing the token to another member after creation must be refused.
    const repoint = JSON.parse(await store.mutate("_access_tokens", "update", JSON.stringify({ id: tok.entry.id, version: tok.entry.version, member: "owner" })));
    expect(repoint.error).toBe(true);
    const reconstrain = JSON.parse(await store.mutate("_access_tokens", "update", JSON.stringify({ id: tok.entry.id, version: tok.entry.version, constraints: JSON.stringify({ member: "owner" }) })));
    expect(reconstrain.error).toBe(true);
  });

  it("treats approved_at as system-managed (not settable via mutate)", async () => {
    const store = getStore();
    await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" }));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "partner" })));
    // An agent trying to self-approve by writing approved_at must be refused.
    const attempt = JSON.parse(await store.mutate("_access_tokens", "update", JSON.stringify({ id: tok.entry.id, version: tok.entry.version, approved_at: "2099-01-01" })));
    expect(attempt.error).toBe(true);
    // And the token is still inert.
    expect(await store.resolveRegisterToken(tok.entry.token)).toBeNull();
  });

  // Privilege-escalation guards: an invite link must never be able to register
  // a passkey that authenticates as the owner, nor target a non-roster member.
  it("refuses to mint a register token targeting the owner", async () => {
    const store = getStore();
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "owner" })));
    expect(tok.error).toBe(true);
  });

  it("refuses to mint a register token for a member not in the roster", async () => {
    const store = getStore();
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "ghost" })));
    expect(tok.error).toBe(true);
  });

  it("refuses to mint a register token for a suspended member", async () => {
    const store = getStore();
    const m = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "partner", display_name: "Sam" })));
    await store.mutate("_members", "update", JSON.stringify({ id: m.entry.id, version: m.entry.version, status: "suspended" }));
    const tok = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "register", member: "partner" })));
    expect(tok.error).toBe(true);
  });

  // Defense in depth: even a tampered register token (constraints set to owner
  // by a raw write that bypassed the mint-time hook) must not resolve at setup.
  it("refuses at setup time to provision the owner even if a token's constraints say so", async () => {
    const store = getStore();
    let token = "";
    await runInDurableObject(store, async (_i, state) => {
      token = "feedfacefeedfacefeedfacefeedface";
      state.storage.sql.exec(
        `INSERT INTO "_access_tokens" (token, scope, constraints, single_use) VALUES (?, 'register', ?, 1)`,
        token, JSON.stringify({ member: "owner" })
      );
    });
    expect(await store.resolveRegisterToken(token)).toBeNull();
  });

  it("refuses at setup time when constraints name a member not in the roster", async () => {
    const store = getStore();
    let token = "";
    await runInDurableObject(store, async (_i, state) => {
      token = "0ddba110ddba110ddba110ddba110dd0";
      state.storage.sql.exec(
        `INSERT INTO "_access_tokens" (token, scope, constraints, single_use) VALUES (?, 'register', ?, 1)`,
        token, JSON.stringify({ member: "ghost" })
      );
    });
    expect(await store.resolveRegisterToken(token)).toBeNull();
  });
});

describe("Shared hive — multi-passkey storage", () => {
  it("stores one passkey per member and replaces only that member's credential", async () => {
    const store = getStore();
    await store.storePasskey("cred-owner", "key-owner", 0, "[]", null);
    await store.storePasskey("cred-partner", "key-partner", 0, "[]", "partner");
    let rows = await store.getPasskeys();
    expect(rows.length).toBe(2);

    // Re-registering owner replaces only the owner row.
    await store.storePasskey("cred-owner-2", "key-owner-2", 0, "[]", null);
    rows = await store.getPasskeys();
    expect(rows.length).toBe(2);
    const owner = rows.find((r: any) => r.member == null);
    expect(owner!.credential_id).toBe("cred-owner-2");
    const partner = rows.find((r: any) => r.member === "partner");
    expect(partner!.credential_id).toBe("cred-partner");
  });

  it("updates the counter for a specific credential", async () => {
    const store = getStore();
    await store.storePasskey("cred-a", "key-a", 0, "[]", null);
    await store.storePasskey("cred-b", "key-b", 0, "[]", "partner");
    await store.updatePasskeyCounter("cred-b", 7);
    const rows = await store.getPasskeys();
    expect(rows.find((r: any) => r.credential_id === "cred-a")!.counter).toBe(0);
    expect(rows.find((r: any) => r.credential_id === "cred-b")!.counter).toBe(7);
  });
});
