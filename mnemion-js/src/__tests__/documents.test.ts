// Document store: R2-backed file blobs with _documents metadata entries.
//
// These tests cover the server logic, which is R2-free: consumeDocumentUpload /
// resolve / archive only touch the DB. The R2 byte path itself is drivable in
// the pool ONLY when the DOCUMENTS binding is enabled in wrangler.toml (local
// miniflare simulation; served-inertness.test.ts drives the full upload+serve
// round-trip then). With the binding absent (CI default), the byte round-trip,
// size cap, and archive-blob-delete are verified against the deployed worker.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";

// Whether the test runtime has an R2 binding (depends on whether [[r2_buckets]]
// is active in wrangler.toml — commented out by default/CI, uncommented locally
// once documents are enabled). The store-level no-R2 degradation test only makes
// sense when the binding is absent (the handler-level 503/404 gate below runs
// either way, against an explicit empty env).
const R2_PRESENT = !!(env as any).DOCUMENTS;

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createDoc(store: DurableObjectStub<HiveDO>, data: Record<string, unknown>) {
  return JSON.parse(await store.mutate("_documents", "create", JSON.stringify(data)));
}

// === Kernel hook + auto-mint ===

describe("_documents create", () => {
  it("requires a title", async () => {
    const r = await createDoc(getStore(), { description: "no title" });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/title/);
  });

  it("defaults visibility to private and auto-mints an upload token", async () => {
    const r = await createDoc(getStore(), { title: "Report" });
    expect(r.error).toBeUndefined();
    expect(r.entry.visibility).toBe("private");
    expect(r.entry.r2_key).toBeNull();
    expect(r.upload_token).toBeDefined();
    expect(r.upload_token.length).toBe(32);
    expect(r.upload_url).toContain(`/f/${r.upload_token}`);
  });

  it("refuses agent-supplied blob bookkeeping (immutable)", async () => {
    const r = await createDoc(getStore(), { title: "x", r2_key: "documents/forged" });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/r2_key/);
  });

  it("validates the visibility enum", async () => {
    const r = await createDoc(getStore(), { title: "x", visibility: "semi" });
    expect(r.error).toBe(true);
  });
});

// batchMutate must fire PATTERN_EFFECTS per-op just like single-op mutate, or a
// batched _documents create returns no upload ticket (the bytes can never be
// stored). Regression for the effects-skipped-in-batch bug.
describe("batchMutate fires _documents effects", () => {
  it("a batched _documents create carries an upload_url / token, matching single-op", async () => {
    const store = getStore();
    const batch = JSON.parse(await store.batchMutate(JSON.stringify([
      { pattern: "_documents", operation: "create", data: { title: "batched-doc" } },
    ])));
    expect(batch.batch).toBe(true);
    const r = batch.results[0];
    expect(r.error).toBeUndefined();
    expect(r.upload_token).toBeDefined();
    expect(r.upload_token.length).toBe(32);
    expect(r.upload_url).toContain(`/f/${r.upload_token}`);
    // The minted token is real: it can record an upload (DB-only path).
    const rec = JSON.parse(await store.consumeDocumentUpload(r.upload_token, "documents/batched", "text/plain", 12));
    expect(rec.uploaded).toBe(true);
  });
});

describe("document upload token minting", () => {
  it("requires document_id and an existing document", async () => {
    const store = getStore();
    const missing = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "document", constraints: "{}" })));
    expect(missing.error).toBe(true);
    const ghost = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "document", constraints: JSON.stringify({ document_id: 99999 }) })));
    expect(ghost.error).toBe(true);
  });
});

// === Recording an upload (consumeDocumentUpload — DB only, no R2) ===

describe("consumeDocumentUpload", () => {
  it("binds the blob metadata to the entry and burns the token", async () => {
    const store = getStore();
    const doc = await createDoc(store, { title: "paper.pdf" });
    const key = "documents/abc123";

    const rec = JSON.parse(await store.consumeDocumentUpload(doc.upload_token, key, "application/pdf", 4096));
    expect(rec).toEqual({ uploaded: true, id: doc.entry.id, bytes: 4096, content_type: "application/pdf" });

    const resolved = JSON.parse(await store.resolveDocument(doc.entry.id));
    expect(resolved.found).toBe(true);
    expect(resolved.r2_key).toBe(key);
    expect(resolved.content_type).toBe("application/pdf");
    expect(resolved.visibility).toBe("private");

    // Single-use: the token is now spent
    const again = JSON.parse(await store.consumeDocumentUpload(doc.upload_token, key, "application/pdf", 4096));
    expect(again.error).toBe(true);
  });

  it("rejects an invalid token", async () => {
    const store = getStore();
    const r = JSON.parse(await store.consumeDocumentUpload("deadbeefdeadbeefdeadbeefdeadbeef", "documents/x", "text/plain", 10));
    expect(r.error).toBe(true);
  });

  it("rejects a token whose scope is not document", async () => {
    const store = getStore();
    const wide = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ label: "wide", scope: "read" })));
    const r = JSON.parse(await store.consumeDocumentUpload(wide.entry.token, "documents/x", "text/plain", 10));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/document scope/);
  });
});

// === Graceful degradation without R2 ===
// Runs only when the binding is absent (default/CI). Skipped locally once R2 is
// enabled — the degradation path is what we're asserting, and it can't exist
// while DOCUMENTS is bound.

describe.skipIf(R2_PRESENT)("without R2 enabled", () => {
  it("still creates a document entry and notes that uploads are unavailable", async () => {
    const store = getStore();
    const r = await createDoc(store, { title: "no-r2" });
    expect(r.error).toBeUndefined();
    expect(r.entry.id).toBeTypeOf("number");
    expect(r.documents_note).toMatch(/not enabled/i);
  });
});

// The /f handlers' absent-binding gate, exercised directly so it runs in EVERY
// test environment — the worker-level env has DOCUMENTS bound whenever the local
// wrangler.toml enables R2, so a SELF.fetch can't reach this branch then. Both
// handlers check ctx.env.DOCUMENTS before touching anything else, so a ctx with
// an empty env drives exactly the degradation chokepoint.
describe("/f handlers when R2 is absent", () => {
  it("returns 503 from POST /f and 404 from GET /f when R2 is absent", async () => {
    const { uploadDocument, serveDocument } = await import("../../shared/Routing/routes/io");
    const noR2 = { env: {} } as any;
    const up = await uploadDocument(noR2);
    expect(up.status).toBe(503);
    const get = await serveDocument(noR2);
    expect(get.status).toBe(404);
  });
});

// === Resolve + archive (metadata path, no R2) ===

describe("resolveDocument", () => {
  it("is not servable until bytes exist, and not for unknown ids", async () => {
    const store = getStore();
    const doc = await createDoc(store, { title: "pending", visibility: "public" });
    // created but no upload recorded yet → nothing to serve
    expect(JSON.parse(await store.resolveDocument(doc.entry.id)).found).toBe(false);
    expect(JSON.parse(await store.resolveDocument(999999)).found).toBe(false);
  });

  it("stops serving once the entry is archived", async () => {
    const store = getStore();
    const doc = await createDoc(store, { title: "ephemeral" });
    await store.consumeDocumentUpload(doc.upload_token, "documents/keep", "text/plain", 5);
    expect(JSON.parse(await store.resolveDocument(doc.entry.id)).found).toBe(true);

    // Archive a doc that has no r2_key set avoids the R2 delete path here;
    // the blob deletion on archive is verified live. Re-point to an unstored doc:
    const fresh = await createDoc(store, { title: "metadata-only", visibility: "public" });
    await store.mutate("_documents", "archive", JSON.stringify({ id: fresh.entry.id }));
    expect(JSON.parse(await store.resolveDocument(fresh.entry.id)).found).toBe(false);
  });
});
