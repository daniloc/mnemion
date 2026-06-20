// documents — R2-backed file store feature.
//
// The whole feature, legible in one place. Today only `effects` is composed
// end-to-end (the post-mutate orchestration that used to live inline in
// effects.ts's PATTERN_EFFECTS literal). The other slots show what this feature
// WOULD declare once those registries adopt the composer — they are commented
// pointers to the live registries that own them, not duplicated definitions, so
// there is exactly one source of truth per registry until migration.
//
//   patterns/writePolicy → entities/Hive/schema.ts (_documents DDL) +
//                          entities/Hive/policy.ts (_documents write class)
//   routes               → src/index.ts (/f/:token upload, /f/:id serve)
//   migrations           → schema.ts v12 (extracted_text / extraction_status)
//   systemDocs           → src/system-docs/http-io.md

import type { Feature } from "../feature";

export const documents: Feature = {
  name: "documents",
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
