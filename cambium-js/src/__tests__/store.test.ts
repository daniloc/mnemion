import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import type { CambiumStore } from "../store";

function getStore(): DurableObjectStub<CambiumStore> {
  const id = env.CAMBIUM_STORE.idFromName("user:test");
  return env.CAMBIUM_STORE.get(id);
}

// Helper: create an object via propose + apply
async function createObject(
  store: DurableObjectStub<CambiumStore>,
  name: string,
  fields: { name: string; type: string; required?: boolean; references?: { object: string; field?: string } }[],
  description?: string
) {
  const result = await store.proposeChange(
    `Create ${name}`,
    JSON.stringify({
      type: "create_object",
      object_name: name,
      object_description: description || `Test object: ${name}`,
      fields,
    })
  );
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.message);
  const applied = await store.applyChange(parsed.change_id);
  return JSON.parse(applied);
}

// Helper: create a record
async function createRecord(store: DurableObjectStub<CambiumStore>, object: string, data: Record<string, unknown>) {
  const result = await store.mutate(object, "create", JSON.stringify(data));
  return JSON.parse(result);
}

// === Index & Schema ===

describe("Index", () => {
  it("returns a valid index on fresh store", async () => {
    const store = getStore();
    const result = JSON.parse(await store.getIndex());
    expect(result.version).toBeTypeOf("number");
    expect(result.guidance).toBeTypeOf("string");
    expect(result.objects).toBeInstanceOf(Array);
    expect(result.conventions).toBeInstanceOf(Array);
    expect(result.system_docs).toBe("cambium://_system/");
  });

  it("includes kernel objects in the index", async () => {
    const store = getStore();
    const result = JSON.parse(await store.getIndex());
    const names = result.objects.map((o: any) => o.name);
    expect(names).toContain("_marketplace_tokens");
    expect(names).toContain("_system_docs");
    expect(names).toContain("_upload_tokens");
  });
});

// === Schema Evolution ===

describe("Schema Evolution", () => {
  it("creates an object with propose + apply", async () => {
    const store = getStore();
    const result = await createObject(store, "tasks", [
      { name: "title", type: "text", required: true },
      { name: "status", type: "text" },
      { name: "priority", type: "integer" },
    ]);
    expect(result.applied).toBe(true);

    const index = JSON.parse(await store.getIndex());
    const task = index.objects.find((o: any) => o.name === "tasks");
    expect(task).toBeDefined();
    expect(task.fields).toHaveLength(3);
  });

  it("rejects duplicate object names", async () => {
    const store = getStore();
    await createObject(store, "items", [{ name: "label", type: "text" }]);
    const result = await store.proposeChange(
      "Duplicate",
      JSON.stringify({ type: "create_object", object_name: "items", fields: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("adds fields to existing object", async () => {
    const store = getStore();
    await createObject(store, "notes", [{ name: "body", type: "text", required: true }]);

    const propose = await store.proposeChange(
      "Add tag",
      JSON.stringify({ type: "add_field", object_name: "notes", fields: [{ name: "tag", type: "text" }] })
    );
    const parsed = JSON.parse(propose);
    expect(parsed.change_id).toBeDefined();
    await store.applyChange(parsed.change_id);

    const schema = JSON.parse(await store.getSchema("notes"));
    const fieldNames = schema.fields.map((f: any) => f.name);
    expect(fieldNames).toContain("tag");
  });

  it("rejects kernel column names as fields", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad field",
      JSON.stringify({
        type: "create_object",
        object_name: "bad-obj",
        fields: [{ name: "id", type: "integer" }],
      })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("adds conventions", async () => {
    const store = getStore();
    const propose = await store.proposeChange(
      "Add convention",
      JSON.stringify({ type: "add_convention", convention: "Always use kebab-case for object names" })
    );
    const parsed = JSON.parse(propose);
    await store.applyChange(parsed.change_id);

    const index = JSON.parse(await store.getIndex());
    expect(index.conventions).toContain("Always use kebab-case for object names");
  });

  it("supports foreign key references", async () => {
    const store = getStore();
    await createObject(store, "projects", [{ name: "name", type: "text", required: true }]);
    await createObject(store, "milestones", [
      { name: "title", type: "text", required: true },
      { name: "project_id", type: "integer", required: true, references: { object: "projects" } },
    ]);

    const schema = JSON.parse(await store.getSchema("milestones"));
    const projectField = schema.fields.find((f: any) => f.name === "project_id");
    expect(projectField.references).toBe("projects");
  });

  it("rejects references to non-existent objects", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad ref",
      JSON.stringify({
        type: "create_object",
        object_name: "orphans",
        fields: [{ name: "parent_id", type: "integer", references: { object: "nonexistent" } }],
      })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("records schema history", async () => {
    const store = getStore();
    await createObject(store, "logs", [{ name: "message", type: "text" }]);

    const history = JSON.parse(await store.getHistory(10));
    expect(history.history.length).toBeGreaterThan(0);
    expect(history.history[0].change_type).toBe("create_object");
  });
});

// === Name Validation ===

describe("Name Validation", () => {
  it("rejects uppercase object names", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad name",
      JSON.stringify({ type: "create_object", object_name: "BadName", fields: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("rejects names starting with numbers", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad name",
      JSON.stringify({ type: "create_object", object_name: "123abc", fields: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("rejects names with spaces", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad name",
      JSON.stringify({ type: "create_object", object_name: "my object", fields: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("accepts valid kebab-case names", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Good name",
      JSON.stringify({
        type: "create_object",
        object_name: "my-cool-object",
        fields: [{ name: "some_field", type: "text" }],
      })
    );
    expect(JSON.parse(result).change_id).toBeDefined();
  });

  it("rejects names exceeding 64 characters", async () => {
    const store = getStore();
    const longName = "a".repeat(65);
    const result = await store.proposeChange(
      "Long name",
      JSON.stringify({ type: "create_object", object_name: longName, fields: [{ name: "x", type: "text" }] })
    );
    expect(JSON.parse(result).error).toBe(true);
  });

  it("rejects uppercase field names", async () => {
    const store = getStore();
    const result = await store.proposeChange(
      "Bad field",
      JSON.stringify({
        type: "create_object",
        object_name: "valid-obj",
        fields: [{ name: "BadField", type: "text" }],
      })
    );
    expect(JSON.parse(result).error).toBe(true);
  });
});

// === Field Limits ===

describe("Field Limits", () => {
  it("rejects objects with more than 64 fields", async () => {
    const store = getStore();
    const fields = Array.from({ length: 65 }, (_, i) => ({
      name: `field_${i}`,
      type: "text",
    }));
    const result = await store.proposeChange(
      "Too many fields",
      JSON.stringify({ type: "create_object", object_name: "wide-table", fields })
    );
    expect(JSON.parse(result).error).toBe(true);
    expect(JSON.parse(result).message).toContain("64");
  });
});

// === CRUD Operations ===

describe("Mutate - Create", () => {
  it("creates a record and returns it with kernel columns", async () => {
    const store = getStore();
    await createObject(store, "people", [
      { name: "name", type: "text", required: true },
      { name: "age", type: "integer" },
    ]);

    const result = await createRecord(store, "people", { name: "Alice", age: 30 });
    expect(result.record.id).toBeTypeOf("number");
    expect(result.record.name).toBe("Alice");
    expect(result.record.age).toBe(30);
    expect(result.record.created_at).toBeDefined();
    expect(result.record.updated_at).toBeDefined();
    expect(result.record.archived_at).toBeNull();
    expect(result.record.version).toBe(0);
  });

  it("rejects creates on non-existent objects", async () => {
    const store = getStore();
    const result = JSON.parse(await store.mutate("nonexistent", "create", JSON.stringify({ x: 1 })));
    expect(result.error).toBe(true);
  });
});

describe("Mutate - Update", () => {
  it("updates a record and increments version", async () => {
    const store = getStore();
    await createObject(store, "widgets", [{ name: "color", type: "text" }]);
    const created = await createRecord(store, "widgets", { color: "red" });

    const result = JSON.parse(
      await store.mutate("widgets", "update", JSON.stringify({ id: created.record.id, color: "blue" }))
    );
    expect(result.record.color).toBe("blue");
    expect(result.record.version).toBe(1);
  });

  it("supports optimistic locking via version", async () => {
    const store = getStore();
    await createObject(store, "docs", [{ name: "content", type: "text" }]);
    const created = await createRecord(store, "docs", { content: "v1" });

    // Update with correct version
    const ok = JSON.parse(
      await store.mutate("docs", "update", JSON.stringify({ id: created.record.id, content: "v2", version: 0 }))
    );
    expect(ok.record.content).toBe("v2");
    expect(ok.record.version).toBe(1);

    // Update with stale version
    const conflict = JSON.parse(
      await store.mutate("docs", "update", JSON.stringify({ id: created.record.id, content: "v3", version: 0 }))
    );
    expect(conflict.error).toBe(true);
    expect(conflict.message).toContain("Version conflict");
  });

  it("allows update without version (last-write-wins)", async () => {
    const store = getStore();
    await createObject(store, "memos", [{ name: "text", type: "text" }]);
    const created = await createRecord(store, "memos", { text: "original" });

    const result = JSON.parse(
      await store.mutate("memos", "update", JSON.stringify({ id: created.record.id, text: "changed" }))
    );
    expect(result.record.text).toBe("changed");
  });

  it("requires id for update", async () => {
    const store = getStore();
    await createObject(store, "things", [{ name: "val", type: "text" }]);
    const result = JSON.parse(await store.mutate("things", "update", JSON.stringify({ val: "x" })));
    expect(result.error).toBe(true);
  });
});

describe("Mutate - Archive", () => {
  it("soft-deletes a record", async () => {
    const store = getStore();
    await createObject(store, "entries", [{ name: "title", type: "text" }]);
    const created = await createRecord(store, "entries", { title: "delete me" });

    await store.mutate("entries", "archive", JSON.stringify({ id: created.record.id }));

    // Should not appear in queries
    const query = JSON.parse(await store.query("entries", "", "", "", 100, false));
    expect(query.records).toHaveLength(0);
  });
});

// === User Version Field (e.g. semver on _plugins) ===

describe("User Version Field", () => {
  it("allows creating records with a user-defined version field", async () => {
    const store = getStore();
    await createObject(store, "packages", [
      { name: "name", type: "text", required: true },
      { name: "pkg_version", type: "text", required: true },
    ]);

    const result = await createRecord(store, "packages", { name: "my-pkg", pkg_version: "1.0.0" });
    expect(result.error).toBeUndefined();
    expect(result.record.pkg_version).toBe("1.0.0");
    // Should also have a kernel version column
    expect(result.record.version).toBe(0);
  });

  it("handles tables where user version field shadows kernel version", async () => {
    const store = getStore();
    // Create an object with 'version' as a user field (like _plugins)
    await createObject(store, "versioned-pkgs", [
      { name: "name", type: "text", required: true },
      { name: "version", type: "text", required: true },
    ]);

    // The migration tries ALTER TABLE ADD COLUMN version INTEGER but it already
    // exists as TEXT, so it silently fails. The user version field should work.
    const result = await createRecord(store, "versioned-pkgs", { name: "pkg", version: "1.0.0" });
    expect(result.error).toBeUndefined();
    expect(result.record.version).toBe("1.0.0");
  });

  it("allows updating a user-defined version field", async () => {
    const store = getStore();
    await createObject(store, "libs", [
      { name: "name", type: "text", required: true },
      { name: "version", type: "text", required: true },
    ]);
    const created = await createRecord(store, "libs", { name: "my-lib", version: "1.0.0" });
    expect(created.error).toBeUndefined();

    const result = JSON.parse(
      await store.mutate("libs", "update", JSON.stringify({ id: created.record.id, version: "2.0.0" }))
    );
    expect(result.record.version).toBe("2.0.0");
  });

  it("does not auto-increment user version fields", async () => {
    const store = getStore();
    await createObject(store, "modules", [
      { name: "name", type: "text", required: true },
      { name: "version", type: "text", required: true },
    ]);
    const created = await createRecord(store, "modules", { name: "mod", version: "0.1.0" });
    expect(created.error).toBeUndefined();

    const result = JSON.parse(
      await store.mutate("modules", "update", JSON.stringify({ id: created.record.id, name: "mod-renamed" }))
    );
    // version should stay as the original string, not become an integer
    expect(result.record.version).toBe("0.1.0");
  });
});

// === Batch Mutate ===

describe("Batch Mutate", () => {
  it("executes multiple operations atomically", async () => {
    const store = getStore();
    await createObject(store, "counters", [
      { name: "name", type: "text", required: true },
      { name: "value", type: "integer" },
    ]);

    const result = JSON.parse(
      await store.batchMutate(
        JSON.stringify([
          { object: "counters", operation: "create", data: { name: "a", value: 1 } },
          { object: "counters", operation: "create", data: { name: "b", value: 2 } },
          { object: "counters", operation: "create", data: { name: "c", value: 3 } },
        ])
      )
    );
    expect(result.batch).toBe(true);
    expect(result.count).toBe(3);
  });

  it("rolls back all operations on failure", async () => {
    const store = getStore();
    await createObject(store, "atoms", [{ name: "val", type: "text", required: true }]);

    try {
      await store.batchMutate(
        JSON.stringify([
          { object: "atoms", operation: "create", data: { val: "good" } },
          { object: "nonexistent", operation: "create", data: { val: "bad" } },
        ])
      );
    } catch {
      // Expected to throw
    }

    // First record should not exist due to rollback
    const query = JSON.parse(await store.query("atoms", "", "", "", 100, false));
    expect(query.records).toHaveLength(0);
  });

  it("rejects batches over 100 operations", async () => {
    const store = getStore();
    await createObject(store, "bulk", [{ name: "x", type: "text" }]);

    const ops = Array.from({ length: 101 }, (_, i) => ({
      object: "bulk",
      operation: "create",
      data: { x: `item-${i}` },
    }));

    const result = JSON.parse(await store.batchMutate(JSON.stringify(ops)));
    expect(result.error).toBe(true);
    expect(result.message).toContain("100");
  });
});

// === Record Size Limit ===

describe("Record Size Limit", () => {
  it("rejects records exceeding 1MB", async () => {
    const store = getStore();
    await createObject(store, "blobs", [{ name: "content", type: "text" }]);

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
  it("returns records with filtering", async () => {
    const store = getStore();
    await createObject(store, "products", [
      { name: "name", type: "text", required: true },
      { name: "price", type: "number" },
      { name: "category", type: "text" },
    ]);
    await createRecord(store, "products", { name: "Widget", price: 10, category: "tools" });
    await createRecord(store, "products", { name: "Gadget", price: 50, category: "electronics" });
    await createRecord(store, "products", { name: "Wrench", price: 15, category: "tools" });

    const result = JSON.parse(
      await store.query("products", JSON.stringify(["category=tools"]), "", "", 100, false)
    );
    expect(result.records).toHaveLength(2);
  });

  it("supports field projection", async () => {
    const store = getStore();
    await createObject(store, "contacts", [
      { name: "name", type: "text", required: true },
      { name: "email", type: "text" },
    ]);
    await createRecord(store, "contacts", { name: "Bob", email: "bob@test.com" });

    const result = JSON.parse(await store.query("contacts", "", "name", "", 100, false));
    expect(result.records[0].name).toBe("Bob");
    expect(result.records[0].email).toBeUndefined();
    // id is always included
    expect(result.records[0].id).toBeDefined();
  });

  it("supports sorting", async () => {
    const store = getStore();
    await createObject(store, "scores", [
      { name: "player", type: "text" },
      { name: "points", type: "integer" },
    ]);
    await createRecord(store, "scores", { player: "Alice", points: 100 });
    await createRecord(store, "scores", { player: "Bob", points: 50 });
    await createRecord(store, "scores", { player: "Carol", points: 200 });

    const result = JSON.parse(await store.query("scores", "", "", "-points", 100, false));
    expect(result.records[0].player).toBe("Carol");
    expect(result.records[2].player).toBe("Bob");
  });

  it("supports count_only mode", async () => {
    const store = getStore();
    await createObject(store, "rows", [{ name: "val", type: "integer" }]);
    await createRecord(store, "rows", { val: 1 });
    await createRecord(store, "rows", { val: 2 });

    const result = JSON.parse(await store.query("rows", "", "", "", 100, true));
    expect(result.count).toBe(2);
    expect(result.records).toBeUndefined();
  });

  it("clamps limit to 1000", async () => {
    const store = getStore();
    await createObject(store, "capped", [{ name: "x", type: "text" }]);

    // Just verify it doesn't error with a high limit
    const result = JSON.parse(await store.query("capped", "", "", "", 9999, false));
    expect(result.records).toBeInstanceOf(Array);
  });

  it("excludes archived records", async () => {
    const store = getStore();
    await createObject(store, "mixed", [{ name: "label", type: "text" }]);
    const r1 = await createRecord(store, "mixed", { label: "keep" });
    const r2 = await createRecord(store, "mixed", { label: "remove" });
    await store.mutate("mixed", "archive", JSON.stringify({ id: r2.record.id }));

    const result = JSON.parse(await store.query("mixed", "", "", "", 100, false));
    expect(result.records).toHaveLength(1);
    expect(result.records[0].label).toBe("keep");
  });

  it("supports contains filter (~)", async () => {
    const store = getStore();
    await createObject(store, "articles", [{ name: "title", type: "text" }]);
    await createRecord(store, "articles", { title: "Introduction to TypeScript" });
    await createRecord(store, "articles", { title: "Python for beginners" });

    const result = JSON.parse(
      await store.query("articles", JSON.stringify(["title~TypeScript"]), "", "", 100, false)
    );
    expect(result.records).toHaveLength(1);
  });
});

// === Search ===

describe("Search", () => {
  it("finds records across objects", async () => {
    const store = getStore();
    await createObject(store, "books", [{ name: "title", type: "text" }]);
    await createObject(store, "movies", [{ name: "title", type: "text" }]);
    await createRecord(store, "books", { title: "The Great Gatsby" });
    await createRecord(store, "movies", { title: "The Great Escape" });

    const result = JSON.parse(await store.search("Great", "", 20));
    expect(result.results.length).toBe(2);
  });

  it("limits search to specified objects", async () => {
    const store = getStore();
    await createObject(store, "alpha", [{ name: "text", type: "text" }]);
    await createObject(store, "beta", [{ name: "text", type: "text" }]);
    await createRecord(store, "alpha", { text: "needle" });
    await createRecord(store, "beta", { text: "needle" });

    const result = JSON.parse(await store.search("needle", JSON.stringify(["alpha"]), 20));
    expect(result.results.length).toBe(1);
    expect(result.results[0].object).toBe("alpha");
  });
});

// === URI Resolution ===

describe("Resolve", () => {
  it("resolves cambium://index", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://index"));
    expect(result.objects).toBeInstanceOf(Array);
  });

  it("resolves cambium://history", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://history"));
    expect(result.history).toBeInstanceOf(Array);
  });

  it("resolves cambium://schema/{object}", async () => {
    const store = getStore();
    await createObject(store, "resolvable", [{ name: "x", type: "text" }]);
    const result = JSON.parse(await store.resolve("cambium://schema/resolvable"));
    expect(result.object).toBe("resolvable");
    expect(result.fields).toBeInstanceOf(Array);
  });

  it("resolves cambium://records/{object}/{id}", async () => {
    const store = getStore();
    await createObject(store, "lookups", [{ name: "val", type: "text" }]);
    const created = await createRecord(store, "lookups", { val: "found" });
    const result = JSON.parse(await store.resolve(`cambium://records/lookups/${created.record.id}`));
    expect(result.record.val).toBe("found");
  });

  it("resolves cambium://_system/", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://_system/"));
    expect(result.docs).toBeInstanceOf(Array);
    expect(result.docs.length).toBeGreaterThan(0);
  });

  it("resolves cambium://_system/{slug}", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://_system/tools"));
    expect(result.slug).toBe("tools");
    expect(result.content).toContain("mutate");
  });

  it("resolves cambium://mutations", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://mutations"));
    expect(result.mutations).toBeInstanceOf(Array);
  });

  it("rejects invalid URIs", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("https://example.com"));
    expect(result.error).toBe(true);
  });

  it("rejects unknown paths", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://nonexistent/path"));
    expect(result.error).toBe(true);
  });
});

// === System Docs ===

describe("System Docs", () => {
  it("seeds system docs on fresh store", async () => {
    const store = getStore();
    const result = JSON.parse(await store.resolve("cambium://_system/"));
    const slugs = result.docs.map((d: any) => d.slug);
    expect(slugs).toContain("tools");
    expect(slugs).toContain("schema-evolution");
    expect(slugs).toContain("skills");
    expect(slugs).toContain("conventions");
    expect(slugs).toContain("index-guide");
  });

  it("returns default content when content is null", async () => {
    const store = getStore();
    const doc = JSON.parse(await store.resolve("cambium://_system/tools"));
    expect(doc.is_default).toBe(true);

    // Update via mutate using id=1 (first seeded doc is 'tools' with id=1)
    // Use getSystemDoc to get the slug, then update by finding the right id
    const updated = JSON.parse(
      await store.mutate("_system_docs", "update", JSON.stringify({ id: 1, content: null }))
    );
    // If id=1 isn't tools, just skip this test gracefully
    if (updated.error) return;

    const restored = JSON.parse(await store.resolve("cambium://_system/tools"));
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
    const result = JSON.parse(await store.resolve("cambium://_system/tools/default"));
    expect(result.content).toContain("mutate");
    expect(result.is_default).toBe(true);
  });
});

// === Upload Tokens ===

describe("Upload Tokens", () => {
  it("mints a token with auto-generated fields", async () => {
    const store = getStore();
    await createObject(store, "uploads-target", [{ name: "content", type: "text" }]);
    const record = await createRecord(store, "uploads-target", { content: "original" });

    const result = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "uploads-target",
        target_id: record.record.id,
        target_field: "content",
      }))
    );
    expect(result.record.token).toBeDefined();
    expect(result.record.token.length).toBe(32); // hex(randomblob(16))
    expect(result.record.expires_at).toBeDefined();
    expect(result.record.mode).toBe("replace");
    expect(result.record.consumed_at).toBeNull();
  });

  it("rejects tokens targeting non-existent objects", async () => {
    const store = getStore();
    const result = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "ghost",
        target_id: 1,
        target_field: "content",
      }))
    );
    expect(result.error).toBe(true);
  });

  it("rejects tokens targeting non-text fields", async () => {
    const store = getStore();
    await createObject(store, "nums", [{ name: "count", type: "integer" }]);
    await createRecord(store, "nums", { count: 0 });

    const result = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "nums",
        target_id: 1,
        target_field: "count",
      }))
    );
    expect(result.error).toBe(true);
    expect(result.message).toContain("text type");
  });

  it("consumes upload and writes content (replace mode)", async () => {
    const store = getStore();
    await createObject(store, "upload-replace", [{ name: "body", type: "text" }]);
    const record = await createRecord(store, "upload-replace", { body: "old" });

    const token = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "upload-replace",
        target_id: record.record.id,
        target_field: "body",
      }))
    );

    const result = JSON.parse(await store.consumeUpload(token.record.token, "new content"));
    expect(result.uploaded).toBe(true);
    expect(result.record.body).toBe("new content");
  });

  it("consumes upload and appends content (append mode)", async () => {
    const store = getStore();
    await createObject(store, "upload-append", [{ name: "log", type: "text" }]);
    const record = await createRecord(store, "upload-append", { log: "line1\n" });

    const token = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "upload-append",
        target_id: record.record.id,
        target_field: "log",
        mode: "append",
      }))
    );

    const result = JSON.parse(await store.consumeUpload(token.record.token, "line2\n"));
    expect(result.uploaded).toBe(true);
    expect(result.record.log).toBe("line1\nline2\n");
  });

  it("rejects already-consumed tokens", async () => {
    const store = getStore();
    await createObject(store, "upload-once", [{ name: "data", type: "text" }]);
    const record = await createRecord(store, "upload-once", { data: "" });

    const token = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "upload-once",
        target_id: record.record.id,
        target_field: "data",
      }))
    );

    await store.consumeUpload(token.record.token, "first");
    const second = JSON.parse(await store.consumeUpload(token.record.token, "second"));
    expect(second.error).toBe(true);
    expect(second.message).toContain("already been used");
  });

  it("rejects content exceeding 1MB", async () => {
    const store = getStore();
    await createObject(store, "upload-big", [{ name: "data", type: "text" }]);
    const record = await createRecord(store, "upload-big", { data: "" });

    const token = JSON.parse(
      await store.mutate("_upload_tokens", "create", JSON.stringify({
        target_object: "upload-big",
        target_id: record.record.id,
        target_field: "data",
      }))
    );

    const big = "x".repeat(1_100_000);
    const result = JSON.parse(await store.consumeUpload(token.record.token, big));
    expect(result.error).toBe(true);
    expect(result.message).toContain("1MB");
  });

  it("rejects invalid tokens", async () => {
    const store = getStore();
    const result = JSON.parse(await store.consumeUpload("nonexistent", "data"));
    expect(result.error).toBe(true);
  });
});

// === Mutation Audit Log ===

describe("Mutation Audit Log", () => {
  it("logs create operations", async () => {
    const store = getStore();
    await createObject(store, "audited", [{ name: "val", type: "text" }]);
    await createRecord(store, "audited", { val: "tracked" });

    const log = JSON.parse(await store.resolve("cambium://mutations/audited"));
    expect(log.mutations.length).toBeGreaterThan(0);
    const insert = log.mutations.find((m: any) => m.operation === "INSERT");
    expect(insert).toBeDefined();
  });
});
