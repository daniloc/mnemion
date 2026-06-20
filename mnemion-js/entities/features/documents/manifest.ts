// documents — R2-backed file store feature.
//
// The whole feature, legible in one place. `effects` + `routes` are composed
// end-to-end today. The remaining slots are commented pointers to the live
// registries that still own them — not duplicated definitions, so there is
// exactly one source of truth per registry until migration.
//
//   patterns + migrations → ./schema.ts (pure data: _documents DDL/facets + the v12
//                          extraction-columns migration), folded into schema.ts's
//                          KERNEL_TABLES + boot migration pile by composePatterns /
//                          composeMigrations. Wired below.
//   writePolicy + egress → ./security.ts (pure data: _documents write class +
//                          r2_key redaction), composed into the effective
//                          KERNEL_WRITE_POLICY / SENSITIVE_COLUMNS by
//                          entities/features/security.ts. Re-exported below so the
//                          feature's security footprint is legible from its dir.
//   systemDocs           → src/system-docs/http-io.md (shared with the other
//                          HTTP-I/O features — egress/publications/ingress — so
//                          it stays a single doc, not split per-feature)

import type { Feature } from "../feature";
import { uploadDocument, serveDocument } from "../../../shared/Routing/routes/io";
import { patterns as documentsPatterns, migrations as documentsMigrations } from "./schema";
import { onCreate as documentsOnCreate, immutable as documentsImmutable } from "./hooks";

// The feature's security footprint (write class + egress sensitivity) lives in the
// pure-data sibling ./security.ts so policy.ts — the dependency-free security leaf —
// can fold it in without importing this manifest (which carries code).

export const documents: Feature = {
  name: "documents",
  // Pattern structure (DDL/facets) + the feature's schema migration, owned by the
  // feature dir (./schema.ts, pure data) and composed into schema.ts at boot.
  patterns: documentsPatterns,
  migrations: documentsMigrations,
  // Pre-mutation hooks (title-required create validation + the system-managed
  // bookkeeping immutables), owned by ./hooks.ts (code, type-only kernel import)
  // and composed into kernel.ts's ON_CREATE / IMMUTABLE registries — enforced at
  // the applyKernelRules chokepoint, byte-for-byte as before.
  hooks: { onCreate: documentsOnCreate, immutable: documentsImmutable },
  // The feature's two HTTP edges, spliced into the route table by composeRoutes.
  // Handlers stay in the I/O adapter layer (routes/io.ts); only the routing rows
  // live here. /f/:token streams bytes to R2 (single-use upload ticket, hex-guarded);
  // /f/:id serves a stored blob (numeric-id-guarded, visibility-gated). The /f/
  // backendPrefix keeps an unmatched GET off the SPA shell.
  routes: [
    { method: "POST", pattern: "/f/:token", where: { token: /^[a-fA-F0-9]+$/ }, handler: uploadDocument, backendPrefix: "/f/" },
    { method: "GET",  pattern: "/f/:id",    where: { id: /^\d+$/ },              handler: serveDocument },
  ],
  effects: {
    _documents: {
      before(parsed, operation, ctx) {
        // Capture the R2 key BEFORE the row is archived, so `after` can free the blob.
        if (operation !== "archive" || parsed.id == null) return;
        const key = ctx.readField("_documents", parsed.id, "r2_key");
        return { archivedDocKey: typeof key === "string" ? key : null };
      },
      async after(entry, result, parsed, operation, scratch, ctx) {
        // create → born with a single-use upload ticket; bytes are POSTed to upload_url,
        // which records r2_key/size on the entry. Digest at rest, raw shown once.
        if (operation === "create" && entry && !entry.r2_key) {
          const tok = await ctx.internalCreate("_access_tokens", {
            scope: "document",
            label: `upload:document:${entry.id}`,
            constraints: JSON.stringify({ document_id: entry.id }),
          });
          const rawTok = tok.once?.token;
          if (!tok.error && rawTok) {
            result.upload_token = rawTok; // raw, shown once (DB holds the digest)
            result.upload_url = ctx.instanceUrl(`f/${rawTok}`);
          }
          // Minting the token is pure DB; the bytes need R2. If it isn't enabled, say so
          // plainly rather than handing back an upload_url that 503s.
          if (!ctx.env.DOCUMENTS) {
            result.documents_note =
              "File storage (R2) is not enabled on this instance — the metadata entry was created, but uploading bytes to upload_url will fail until R2 is enabled. Everything else works without it.";
          }
        }
        // archive → free the R2 object: the metadata and the blob die together.
        const key = scratch.archivedDocKey as string | null | undefined;
        if (key && ctx.env.DOCUMENTS) {
          ctx.schedule(ctx.env.DOCUMENTS.delete(key).catch(() => {}));
        }
      },
    },
  },
};
