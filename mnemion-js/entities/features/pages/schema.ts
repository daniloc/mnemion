// pages/schema.ts — the pages feature's PATTERN STRUCTURE, as PURE DATA: the
// _pages kernel-pattern declaration (DDL + path index + facet metadata + doctrine).
// Same discipline as documents/schema.ts — pure data + TYPES only, no manifest code —
// so composePatterns (entities/features/compose.ts) can fold it back into schema.ts's
// KERNEL_TABLES verbatim, and verifyFieldsIntegrity sees the identical table + _fields
// rows the central array used to hold.
//
// describeBlockPalette() is a pure, dependency-light helper (shared/core block
// palette) used only to enrich the agent-facing description — it carries no runtime
// edge into the security leaf (this file is imported by the manifest, not policy.ts).
//
// No feature migration: every _pages column lives in the base DDL (there was never a
// _pages ALTER in schema.ts's migration pile). The kernel HOOKS for _pages (block
// validation, the public-page invariants) stay in entities/Hive/kernel.ts — a
// separate, deliberate design call, not part of this structure move.

import type { FeaturePattern } from "../feature";
import { describeBlockPalette } from "../../../shared/core/block-palette";

export const patterns: FeaturePattern[] = [
  {
    name: "_pages",
    description: `Agent-authored pages — arbitrary compositions that reference any patterns and entries. A page is a list of blocks (metric, chart, an embedded pattern view, a specific entry, prose) arranged in a grid. Build one when the human wants a dashboard or an overview you didn't pre-design. Set a unique "path" (slug) per page.

${describeBlockPalette()}`,
    doctrine: `Compose a page when the human wants a custom dashboard or overview across patterns. Blocks are declarative data interpreted against a fixed component palette — never code. Reference real patterns/entries; the kernel rejects a page that names a missing pattern, facet, or an unknown block type. The create/update response carries page_url — give it to the human so they can open the page. Pages are private by default (page_url opens only in the signed-in app); set visibility: public to serve it over the web at /page/{path} with an OG unfurl card (og_image) — that flip is consent-gated.`,
    ddl: `CREATE TABLE IF NOT EXISTS "_pages" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "title" TEXT,
      "description" TEXT,
      "blocks" TEXT,
      "visibility" TEXT DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS "_pages_path_active" ON "_pages" ("path") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "name", type: "text", required: true },
      { name: "path", type: "text", required: true },
      { name: "title", type: "text", required: false },
      { name: "description", type: "text", required: false },
      { name: "blocks", type: "text", required: false },
      { name: "visibility", type: "select", required: false, options: ["private", "public"] },
    ],
  },
];
