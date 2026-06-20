// documents.ts — document-store lifecycle (R2-backed blobs), evicted from HiveDO.
//
// Receives a narrow DocumentsContext, never `this` and never a trusted executeMutate.
// Its writes are SYSTEM bookkeeping on _documents' IMMUTABLE columns (r2_key / size /
// content_type / stored_at / extracted_text / extraction_status) — the columns agents
// cannot set through mutate — so they stay narrow, specific UPDATEs rather than a new
// general write chokepoint. The DO keeps thin RPC wrappers; this holds the logic.
import * as cred from "../../shared/Auth/credentials";
import { capText, extractPdfText } from "../../shared/IO/extract";

export interface DocumentsContext {
  db: any;
  env: any;
  broadcast(patterns: string[]): void;
  /** Re-embed a document so extracted text joins prime recall. */
  embed(documentId: number): Promise<unknown>;
  /** Post-response work (ctx.waitUntil). */
  schedule(p: Promise<unknown>): void;
  errorJson(message: string): string;
}

/** Record a completed upload: bind the R2 key + metadata to the document entry and
 *  burn the single-use token. */
export async function consumeDocumentUpload(
  ctx: DocumentsContext, token: string, r2Key: string, contentType: string, size: number,
): Promise<string> {
  const accessToken = await cred.findAccessToken(ctx.db, token);
  if (!accessToken) return ctx.errorJson("Invalid or expired upload token");
  if (!cred.scopeMatches(accessToken.scope, "document")) return ctx.errorJson("Token does not have document scope");

  let documentId: number;
  try {
    documentId = JSON.parse(accessToken.constraints ?? "{}").document_id;
  } catch { return ctx.errorJson("Upload token has invalid constraints"); }
  if (documentId == null) return ctx.errorJson("Upload token missing document_id");

  const rows = ctx.db.exec(`SELECT id FROM "_documents" WHERE id = ? AND archived_at IS NULL`, documentId).toArray();
  if (rows.length === 0) return ctx.errorJson("Document not found");

  ctx.db.exec(
    `UPDATE "_documents" SET r2_key = ?, "size" = ?, content_type = ?, stored_at = datetime('now'), updated_at = datetime('now'), version = version + 1 WHERE id = ?`,
    r2Key, size, contentType, documentId,
  );
  cred.consumeToken(ctx.db, accessToken.id);
  ctx.broadcast(["_documents"]);

  const entry = ctx.db.exec(`SELECT * FROM "_documents" WHERE id = ?`, documentId).one();
  return JSON.stringify({ uploaded: true, id: documentId, bytes: size, content_type: contentType, entry });
}

/** Record extracted text + status, then re-embed so the text joins prime recall. */
export async function recordExtraction(
  ctx: DocumentsContext, documentId: number, text: string, status: string,
): Promise<string> {
  try {
    const rows = ctx.db.exec(`SELECT id FROM "_documents" WHERE id = ? AND archived_at IS NULL`, documentId).toArray();
    if (rows.length === 0) return ctx.errorJson("Document not found");

    ctx.db.exec(
      `UPDATE "_documents" SET extracted_text = ?, extraction_status = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?`,
      text || null, status, documentId,
    );
    ctx.broadcast(["_documents"]);
    ctx.schedule(ctx.embed(documentId));
    return JSON.stringify({ recorded: true, id: documentId, status, chars: (text || "").length });
  } catch (err: any) {
    return ctx.errorJson(`Failed to record extraction: ${err.message}`);
  }
}

/** Schedule async PDF text extraction: mark pending, read the blob from R2, extract,
 *  record. Returns immediately; the work outlives the RPC via schedule(). */
export async function extractDocument(ctx: DocumentsContext, id: number): Promise<string> {
  const rows = ctx.db.exec(`SELECT r2_key FROM "_documents" WHERE id = ? AND archived_at IS NULL`, id).toArray() as any[];
  if (rows.length === 0 || !rows[0].r2_key) return ctx.errorJson("Document not found or not uploaded");
  const r2Key = rows[0].r2_key as string;

  ctx.db.exec(`UPDATE "_documents" SET extraction_status = 'pending', updated_at = datetime('now') WHERE id = ?`, id);

  ctx.schedule((async () => {
    try {
      const obj = ctx.env.DOCUMENTS ? await ctx.env.DOCUMENTS.get(r2Key) : null;
      if (!obj) { await recordExtraction(ctx, id, "", "failed"); return; }
      const text = capText(await extractPdfText(await obj.arrayBuffer()));
      await recordExtraction(ctx, id, text, text.trim() ? "done" : "empty");
    } catch {
      await recordExtraction(ctx, id, "", "failed");
    }
  })());

  return JSON.stringify({ scheduled: true, id });
}

/** Resolve a document for serving. Returns found:false until bytes exist. */
export function resolveDocument(ctx: DocumentsContext, id: number): string {
  try {
    const rows = ctx.db.exec(
      `SELECT title, visibility, r2_key, content_type, stored_at FROM "_documents" WHERE id = ? AND archived_at IS NULL`, id,
    ).toArray() as any[];
    if (rows.length === 0 || !rows[0].r2_key) return JSON.stringify({ found: false });
    return JSON.stringify({ found: true, ...rows[0] });
  } catch {
    return JSON.stringify({ found: false });
  }
}
