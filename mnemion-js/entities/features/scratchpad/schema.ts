// scratchpad/schema.ts — the scratchpad feature's PATTERN STRUCTURE, as PURE DATA:
// the _scratchpad kernel-pattern declaration (DDL + facets + a per-pad index). Same
// discipline as documents/pages/clipboards schema.ts — pure data + TYPES only — so
// composePatterns folds it into KERNEL_TABLES verbatim and verifyFieldsIntegrity sees
// no drift.
//
// A _scratchpad row is a NOTE posted to a named shared PAD: a coordination channel for
// agents in neighboring sessions. Append-only, durable-as-memory but GC'd at a horizon
// (the boot sweep in entities/Hive/schema.ts), audit-exempt (high-frequency, like the
// access logs). created_by/updated_by (auto kernel columns) attribute each note to its
// poster, so a fanout of agents can see who left what.

import type { FeaturePattern } from "../feature";

export const patterns: FeaturePattern[] = [
  {
    name: "_scratchpad",
    description: `Scratchpad — shared coordination pads for agents working in neighboring sessions on the same hive. Post a NOTE to a named pad (a free-form name you agree on — a task id, a clipboard name) and agents watching that pad are notified. Use it to coordinate a fanout: "claimed item 7", "job done", "found X". Notes are durable and queryable (query _scratchpad pad=<name> id><cursor> to catch up) but pruned after ~30 days.`,
    doctrine: `Post to a pad with mutate create _scratchpad {pad, kind, body}: pad is the shared channel name (URL-safe slug), kind is a short tag you choose (e.g. "claim"/"done"/"note"/"question"), body is the message (text or JSON). To watch a pad, subscribe to the resource mnemion://scratchpad/{pad} (you'll get a resources/updated nudge on each new note, then re-read) or poll query _scratchpad pad=<name> id><lastSeenId>. created_by attributes each note to the poster. Notes are coordination, not memory — they don't surface in prime and are GC'd after ~30 days.`,
    ddl: `CREATE TABLE IF NOT EXISTS "_scratchpad" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "pad" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "body" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      // Per-pad reads (the resource + the poll path) filter by pad and order by id.
      `CREATE INDEX IF NOT EXISTS "_scratchpad_pad" ON "_scratchpad" ("pad", "id")`,
    ],
    facets: [
      { name: "pad", type: "text", required: true },
      { name: "kind", type: "text", required: true },
      { name: "body", type: "text", required: false },
    ],
  },
];
