// pages — agent-authored public/private pages feature.
//
// Live slots: `effects` (the post-mutate link-back) + `routes` (the public-page
// HTTP edges). Other registries it touches:
//   patterns     → ./schema.ts (pure data: _pages DDL + path index + facets),
//                  folded into schema.ts's KERNEL_TABLES by composePatterns. Wired
//                  below. (No feature migration — every _pages column is in the base
//                  DDL.)
//   writePolicy  → ./security.ts (pure data: _pages write class), composed into the
//                  effective KERNEL_WRITE_POLICY by entities/features/security.ts.
//                  Re-exported below so the footprint is legible from the dir.
//   systemDocs   → src/system-docs/http-io.md (shared HTTP-I/O doc)

import type { Feature } from "../feature";
import { servePage, servePageOg, servePageOgPng } from "../../../shared/Routing/routes/io";
import { patterns as pagesPatterns } from "./schema";
import { onWrite as pagesOnWrite } from "./hooks";

// Security footprint as pure data, foldable into the policy.ts leaf without pulling
// this manifest's code. Re-exported so the dir shows its whole footprint.
export { writePolicy } from "./security";

export const pages: Feature = {
  name: "pages",
  // Pattern structure (DDL/facets/index), owned by the feature dir (./schema.ts,
  // pure data) and composed into schema.ts's KERNEL_TABLES at boot.
  patterns: pagesPatterns,
  // The _pages write-time hook (URL-safe path + block-palette validation + the
  // kernel-pattern exfil guard), owned by ./hooks.ts (code, type-only kernel
  // import) and composed into kernel.ts's ON_WRITE registry — enforced at the
  // applyKernelRules chokepoint, byte-for-byte as before.
  hooks: { onWrite: pagesOnWrite },
  // Public-page serving + OG-card edges, spliced into the route table by
  // composeRoutes. Handlers stay in routes/io.ts. The og.svg/og.png variants are
  // declared before the catch-all /page/:path; their regexes don't overlap (a
  // segment can't span a slash) but declaration order is preserved for clarity.
  // /page/ backendPrefix keeps an unmatched GET off the SPA shell.
  routes: [
    { method: "GET", pattern: "/page/:path/og.svg", handler: servePageOg,    backendPrefix: "/page/" },
    { method: "GET", pattern: "/page/:path/og.png", handler: servePageOgPng },
    { method: "GET", pattern: "/page/:path",        handler: servePage },
  ],
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
