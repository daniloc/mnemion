// documents/schema.ts — the documents feature's PATTERN STRUCTURE, as PURE DATA:
// the _documents kernel-pattern declaration (DDL + facet metadata + doctrine) and
// the feature's own schema migration. This is the "a feature owns its schema" half
// of the footprint, kept SEPARATE from manifest.ts so it stays pure data + TYPES
// only (no route handlers, no effect bodies) — composePatterns/composeMigrations
// (entities/features/compose.ts) fold it back into schema.ts's KERNEL_TABLES + boot
// migration pile, byte-for-byte the same rows the central array used to hold, so
// verifyFieldsIntegrity (the DDL↔_fields drift oracle) sees no change.
//
// NOTE: the kernel pre-mutation HOOKS for _documents (the title-required create
// validation + the immutable r2_key/size/etc. bookkeeping invariants) live in the
// sibling ./hooks.ts (code, type-only kernel import), composed into kernel.ts's
// ON_CREATE / IMMUTABLE registries and enforced at the applyKernelRules chokepoint.

import type { FeaturePattern, FeatureMigration } from "../feature";

export const patterns: FeaturePattern[] = [
  {
    name: "_documents",
    description: "Document store. Each entry is metadata for a file whose bytes live in R2 (never in the hive). Two-step upload: create the entry (the response carries a single-use upload_url), then POST the file to it. Served at GET /f/{id}, gated by the entry's visibility. On upload, text is extracted into extracted_text so document contents are searchable (search) and recallable (prime). Bytes are immutable; the metadata is the evolvable knowledge layer that points at them — link documents to other entries like any pattern.",
    doctrine: "Create a document entry with at least a title (plus optional description, tags); the create response includes a single-use upload_url and token — POST the file bytes there to store them in R2. The r2_key, size, content_type, stored_at, extracted_text, and extraction_status facets are filled by the system on upload — never set them yourself. On upload, text is extracted (text files inline, PDFs in the background) into extracted_text, which makes document CONTENTS searchable via search and recallable via prime; extraction_status reports done/pending/failed/unsupported. visibility defaults to private (not served); set it to unlisted (token-gated) or public ONLY when the human approves publishing the file — that flip is consent-gated. Archive an entry to delete both the metadata and the R2 object.",
    ddl: `CREATE TABLE IF NOT EXISTS "_documents" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "title" TEXT NOT NULL,
      "description" TEXT,
      "tags" TEXT,
      "content_type" TEXT,
      "size" INTEGER,
      "r2_key" TEXT,
      "stored_at" TEXT,
      "extracted_text" TEXT,
      "extraction_status" TEXT,
      "visibility" TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    facets: [
      { name: "title", type: "text", required: true },
      { name: "description", type: "text", required: false },
      { name: "tags", type: "text", required: false },
      { name: "content_type", type: "text", required: false },
      { name: "size", type: "integer", required: false },
      { name: "r2_key", type: "text", required: false },
      { name: "stored_at", type: "datetime", required: false },
      { name: "extracted_text", type: "text", required: false },
      { name: "extraction_status", type: "text", required: false },
      { name: "visibility", type: "text", required: false },
    ],
  },
];

export const migrations: FeatureMigration[] = [
  {
    // v12: add extraction columns to an existing _documents table. Fresh hives get
    // these from the DDL above; this backfills installs that predate them. Idempotent
    // (PRAGMA guard), runs every boot after the kernel DDL loop. The version is the
    // global slot this migration historically held in schema.ts's procedural pile.
    version: 12,
    label: "documents: add extracted_text / extraction_status to _documents",
    apply(db: any) {
      try {
        const docCols = db.exec(`PRAGMA table_info("_documents")`).toArray() as any[];
        if (docCols.length) {
          if (!docCols.some((c: any) => c.name === "extracted_text")) {
            db.exec(`ALTER TABLE "_documents" ADD COLUMN "extracted_text" TEXT`);
          }
          if (!docCols.some((c: any) => c.name === "extraction_status")) {
            db.exec(`ALTER TABLE "_documents" ADD COLUMN "extraction_status" TEXT`);
          }
        }
      } catch {}
    },
  },
];
