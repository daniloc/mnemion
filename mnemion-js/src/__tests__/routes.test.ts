import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("HTTP Routes (unauthenticated)", () => {
  it("serves the SPA shell at root", async () => {
    // Unmatched browser GETs fall through to the React SPA (dist/web).
    const res = await SELF.fetch("https://test.local/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves the SPA shell for unknown browser routes (client-side routing)", async () => {
    const res = await SELF.fetch("https://test.local/random/path");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("still returns 404 for unknown backend (API) paths", async () => {
    // Backend prefixes are never shadowed by the SPA fallback.
    const res = await SELF.fetch("https://test.local/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET on upload path", async () => {
    const res = await SELF.fetch("https://test.local/upload/abc123");
    expect(res.status).toBe(404);
  });

  it("returns 400 for POST on upload with invalid token", async () => {
    const res = await SELF.fetch("https://test.local/upload/abc123", {
      method: "POST",
      body: "test content",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe(true);
  });

  it("rejects non-hex upload tokens", async () => {
    const res = await SELF.fetch("https://test.local/upload/not-hex!", {
      method: "POST",
      body: "test",
    });
    // Should be 404 because regex doesn't match
    expect(res.status).toBe(404);
  });
});

describe("Public Marketplace", () => {
  it("serves info/refs on public marketplace", async () => {
    const res = await SELF.fetch(
      "https://test.local/marketplace/public/info/refs?service=git-upload-pack"
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement"
    );
  });

  it("rejects non-upload-pack services", async () => {
    const res = await SELF.fetch(
      "https://test.local/marketplace/public/info/refs?service=git-receive-pack"
    );
    // This goes through handleMarketplaceGit which returns 403 for unsupported services
    expect(res.status).toBe(403);
  });
});

describe("Dev Mode", () => {
  // These tests run without MNEMION_SECRET, so dev mode is active

  it("serves private marketplace without auth in dev mode", async () => {
    const res = await SELF.fetch(
      "https://test.local/marketplace/info/refs?service=git-upload-pack"
    );
    expect(res.status).toBe(200);
  });
});

describe("Shared Entry Routes", () => {
  // Helper: set up a shared entry via the HiveDO directly
  async function setupSharedEntry(visibility: string) {
    const id = env.MNEMION_HIVE.idFromName("user:owner");
    const hive = env.MNEMION_HIVE.get(id);

    // Create pattern + entry
    const p = JSON.parse(await hive.proposeChange("Create", JSON.stringify({
      type: "create_pattern", pattern_name: "articles", pattern_description: "Test", doctrine: "test", facets: [{ name: "title", type: "text" }],
    })));
    await hive.applyChange(p.change_id);
    const entry = JSON.parse(await hive.mutate("articles", "create", JSON.stringify({ title: "Shared article" })));

    // Share it
    const s = JSON.parse(await hive.proposeChange("Share", JSON.stringify({
      type: "set_sharing", pattern_name: "articles", entry_id: entry.entry.id, visibility,
    })));
    await hive.applyChange(s.change_id);
    return entry.entry.id;
  }

  it("serves public shared entry at /o/entry/:pattern/:id", async () => {
    const entryId = await setupSharedEntry("public");
    const res = await SELF.fetch(`https://test.local/o/entry/articles/${entryId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = await res.json() as any;
    expect(body.title).toBe("Shared article");
  });

  it("returns 404 for unshared entry", async () => {
    // Pattern exists from previous test, but entry 999 is not shared
    const res = await SELF.fetch("https://test.local/o/entry/articles/999");
    expect(res.status).toBe(404);
  });

  it("supports ETag / If-None-Match", async () => {
    const entryId = await setupSharedEntry("public");
    const res1 = await SELF.fetch(`https://test.local/o/entry/articles/${entryId}`);
    const etag = res1.headers.get("ETag")!;
    expect(etag).toBeTruthy();

    const res2 = await SELF.fetch(`https://test.local/o/entry/articles/${entryId}`, {
      headers: { "If-None-Match": etag },
    });
    expect(res2.status).toBe(304);
  });
});

describe("Ingress error sanitization", () => {
  // A public, unauthenticated POST /i/{path} that provokes an unexpected DB throw
  // must NOT echo the raw SQLite message — that text names the target pattern's
  // columns/constraints and would let an attacker probe a write-only endpoint's
  // schema. The boundary collapses any `internal`-tagged error (routes/io.ts) to
  // a flat message; structured validation errors still pass through.
  it("collapses a raw DB error to a generic message (no schema leak)", async () => {
    const id = env.MNEMION_HIVE.idFromName("user:owner");
    const hive = env.MNEMION_HIVE.get(id);

    // A KNOWLEDGE pattern with a required facet: required→NOT NULL lands on the
    // column, but app-level required enforcement is dataset-only, so omitting it
    // reaches the INSERT and throws a NOT NULL constraint — the raw-throw branch.
    const p = JSON.parse(await hive.proposeChange("Create", JSON.stringify({
      type: "create_pattern", pattern_name: "leads", pattern_description: "Test", doctrine: "test",
      facets: [{ name: "email", type: "text" }, { name: "secret_code", type: "text", required: true }],
    })));
    await hive.applyChange(p.change_id);

    // Public ingress endpoint mapping the body to `email`, leaving `secret_code` NULL.
    await runInDurableObject(hive, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO "_inputs" (path, target_pattern, body_facet, visibility) VALUES ('lead-capture','leads','email','public')`,
      );
    });

    const res = await SELF.fetch("https://test.local/i/lead-capture", {
      method: "POST", body: "someone@example.com",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toBe("Could not process input.");
    // The raw SQLite text — column name, constraint kind, "Mutate failed" — must not leak.
    const blob = JSON.stringify(body);
    expect(blob).not.toContain("secret_code");
    expect(blob).not.toContain("NOT NULL");
    expect(blob).not.toContain("constraint");
    expect(blob).not.toContain("Mutate failed");
    expect(blob).not.toContain("internal");
  });

  it("still passes a structured validation error through (helps legit posters)", async () => {
    const id = env.MNEMION_HIVE.idFromName("user:owner");
    const hive = env.MNEMION_HIVE.get(id);

    const p = JSON.parse(await hive.proposeChange("Create", JSON.stringify({
      type: "create_pattern", pattern_name: "signups", pattern_description: "Test", doctrine: "test",
      facets: [{ name: "email", type: "text" }],
    })));
    await hive.applyChange(p.change_id);

    // body_facet names a facet that doesn't exist → executeMutate returns a
    // structured (non-internal) "Facet ... does not exist" error, which is safe
    // to surface and helps a legitimate caller fix their payload.
    await runInDurableObject(hive, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO "_inputs" (path, target_pattern, body_facet, visibility) VALUES ('signup','signups','nonexistent','public')`,
      );
    });

    const res = await SELF.fetch("https://test.local/i/signup", {
      method: "POST", body: "hello",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).not.toBe("Could not process input.");
    expect(body.message).toContain("nonexistent");
  });
});
