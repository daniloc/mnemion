// effects.ts — declarative pattern effects, the SIDE-EFFECTING half of the kernel.
//
// kernel.ts holds the PURE pre-mutation hooks (ON_CREATE/ON_WRITE): they validate
// and transform DATA before insert, no I/O. This file is their symmetric impure
// twin: orchestration that runs AROUND a commit — mint a sub-token, schedule an R2
// delete, build a capability URL, run a task. Keyed by pattern, scannable as a
// table, so adding a side-effecting pattern is one entry instead of another
// `if (patternName === …)` branch in mutate().
//
// An effect receives an `EffectContext` — the DO's NARROWED hands — never `this`,
// and never a raw trusted `executeMutate` (that would be a second uncontrolled write
// chokepoint). The one sanctioned internal write is `internalCreate`.
//
// Two phases, mirroring the kernel hooks but with a side-effect contract:
//   before — runs PRE-commit; may read; may abort by throwing (reserve for effects
//            that MUST succeed for the write to be valid).
//   after  — runs POST-commit; best-effort / annotating. A failed URL or token
//            DEGRADES the result (matches today), it never unwinds the committed row.

export interface EffectContext {
  env: any;
  /** A public URL on this instance (host is configuration, never request data). */
  instanceUrl(path: string): string;
  /** Post-response work that outlives the RPC (ctx.waitUntil). */
  schedule(p: Promise<unknown>): void;
  /** Run a queued system task. */
  runTask(taskId: number, task: string): Promise<unknown>;
  /** A narrow single-column read by id (literal pattern/field only). */
  readField(pattern: string, id: number, field: string): unknown;
  /** The ONLY trusted write an effect may perform: a born-hashed create through the
   *  core's owner context. Returns the committed entry + the one-time raw secret. */
  internalCreate(
    pattern: string,
    data: Record<string, unknown>,
  ): Promise<{ entry?: any; error?: boolean; once?: Record<string, string> | null }>;
}

type Scratch = Record<string, unknown>;

export interface PatternEffect {
  before?(parsed: any, operation: string, ctx: EffectContext): Scratch | void;
  after?(
    entry: any,
    result: any,
    parsed: any,
    operation: string,
    scratch: Scratch,
    ctx: EffectContext,
  ): void | Promise<void>;
}

export const PATTERN_EFFECTS: Record<string, PatternEffect> = {
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

  _pages: {
    // A page is born (or re-saved) → hand back the link to give the human, so the
    // agent never has to guess the host or the public-vs-private route. Public pages
    // serve at /page/{path} (+ OG card); private pages open only in the signed-in app
    // at /#page:{path}. Derived from the live host + visibility, never stored.
    after(entry, result, parsed, operation, scratch, ctx) {
      if ((operation === "create" || operation === "update") && entry?.path) {
        const isPublic = entry.visibility === "public";
        const slug = encodeURIComponent(entry.path);
        result.page_url = isPublic ? ctx.instanceUrl(`page/${slug}`) : ctx.instanceUrl(`#page:${slug}`);
        if (isPublic) result.og_image = ctx.instanceUrl(`page/${slug}/og.png`);
        else result.page_note = "Private page — only you, signed in, can open this link. Publishing it (visibility: public) is consent-gated.";
      }
    },
  },

  _system_tasks: {
    async after(entry, result, parsed, operation, scratch, ctx) {
      if (operation === "create" && entry) await ctx.runTask(entry.id, entry.task);
    },
  },
};
