// pages — agent-authored public/private pages feature.
//
// Live slot: `effects` (the post-mutate link-back). Other registries it touches:
//   patterns/writePolicy → schema.ts (_pages DDL + path index) + policy.ts
//   routes               → src/index.ts (/page/:path, /page/:path/og.{svg,png})
//   systemDocs           → src/system-docs/http-io.md (pages section)

import type { Feature } from "../feature";

export const pages: Feature = {
  name: "pages",
  effects: {
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
  },
};
