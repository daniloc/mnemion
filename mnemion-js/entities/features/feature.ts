// feature.ts — the Feature TYPE: one per-feature declaration that FEEDS the
// scattered registries from a single co-located module.
//
// A "feature" is the extensibility keystone. Today a feature's footprint is
// smeared across registries a forker's agent must find and edit in lockstep:
//   - post-mutate side effects   → entities/Hive/effects.ts  (PATTERN_EFFECTS)
//   - HTTP routes                → src/index.ts              (routes[])
//   - MCP tools                  → entities/Session/tools.ts (TOOLS)
//   - kernel patterns + DDL      → entities/Hive/schema.ts   (KERNEL_PATTERNS)
//   - write-policy class         → entities/Hive/policy.ts   (KERNEL_WRITE_POLICY)
//   - system docs                → src/system-docs/*.md      (imported in schema.ts)
//   - coherence spec             → <dir>/*.spec.md
//
// A `Feature` object declares each of those contributions in ONE place. The
// composers in this directory then DERIVE the registries from `FEATURES` (the
// barrel in ./index.ts). Adding a feature = create one dir + add one import line
// to the barrel — its whole footprint is legible in the manifest, not scattered.
//
// This file is intentionally dependency-light: it imports only the TYPES of the
// contributions, never the runtime registries, so a feature manifest can be read
// (and reasoned about) in isolation. `effects` is wired end-to-end today; the
// remaining fields are TYPED and documented so the next agent fills a slot rather
// than re-discovering a registry. See ./compose.ts for what is live vs. designed.

import type { PatternEffect } from "../Hive/effects";

/** A kernel-pattern declaration as schema.ts expects it (DDL + facet metadata +
 *  doctrine). Kept as the existing `KernelTable` shape so a feature can hand
 *  schema.ts a row verbatim — composePatterns folds these into KERNEL_TABLES, and
 *  the boot DDL loop / _fields seeding / verifyFieldsIntegrity treat them
 *  identically to a CORE row. `indexes` mirror the KernelTable field (a feature
 *  pattern may carry its own unique/partial indexes, e.g. _pages' path index). */
export interface FeaturePattern {
  name: string;
  description: string;
  doctrine: string;
  ddl: string;
  indexes?: string[];
  facets: Array<{ name: string; type: string; required: boolean; options?: string[] }>;
}

/** A one-shot, idempotent ALTER/backfill keyed by a monotonic version, mirroring
 *  the `runMigrations` switch in schema.ts. Runs at boot, after pattern DDL. */
export interface FeatureMigration {
  /** Globally-unique, monotonic. The composer asserts no two features collide. */
  version: number;
  /** Human label for the migration log. */
  label: string;
  /** Receives the raw `db` (ctx.storage.sql). Must be idempotent (guard with
   *  PRAGMA table_info / IF NOT EXISTS) — boot may re-run. */
  apply: (db: any) => void;
}

/** A route contribution: the existing Route shape plus the handler. Imported as a
 *  type only so the manifest doesn't pull the router runtime. The composer splices
 *  these into the `routes[]` array in src/index.ts in feature-declaration order,
 *  AFTER the core routes (a feature route can't shadow a core route). */
export interface FeatureRoute {
  method: "GET" | "POST" | "ANY";
  pattern: string;
  /** Auth gate name (matches the `Auth` enum). Omit → NONE. */
  auth?: string;
  where?: Record<string, RegExp>;
  /** Handler signature matches the router's RouteContext handler. */
  handler: (ctx: any) => Promise<Response> | Response;
  /** Path prefix the worker owns for this route (feeds BACKEND_PREFIXES so an
   *  unmatched GET doesn't fall through to the SPA shell). */
  backendPrefix?: string;
}

/** MCP tool metadata — the ToolMeta shape from tools.ts. A feature that adds an
 *  agent-facing verb declares it here; the composer concatenates onto TOOLS. The
 *  feature ALSO supplies the Zod schema + handler wiring (a `registerTool`
 *  callback) since session.ts binds those — see compose design notes. */
export interface FeatureTool {
  name: string;
  description: string;
  when: string;
  /** Bind the tool to the live McpServer + hive stub. Called once per session
   *  during MCP registration. Optional so a pure-metadata declaration still
   *  surfaces in /api/tools even before the handler is wired. */
  register?: (server: any, hive: any) => void;
}

/** A system-doc contribution: the raw markdown (imported as a text module) plus
 *  its slug/title, seeded into _system_docs at boot exactly like schema.ts does. */
export interface FeatureSystemDoc {
  slug: string;
  title: string;
  /** Raw markdown text (import the .md as a text module in the manifest). */
  body: string;
}

/** One feature, declaring every registry contribution it makes. Only `name` is
 *  required; every contribution field is optional so a feature opts into exactly
 *  the registries it touches. */
export interface Feature {
  /** Unique feature id (e.g. "documents"). The composer asserts uniqueness and
   *  uses it in collision diagnostics. */
  name: string;

  /** Post-mutate side effects, keyed by pattern name. Folded into PATTERN_EFFECTS
   *  by composeEffects(). WIRED END-TO-END today. */
  effects?: Record<string, PatternEffect>;

  /** Kernel patterns this feature owns (DDL + facets + doctrine). DESIGN: folded
   *  into KERNEL_PATTERNS by composePatterns() at boot. */
  patterns?: FeaturePattern[];

  /** Write-policy class per pattern this feature owns, keyed by pattern name.
   *  Value is the policy record policy.ts expects. DESIGN: folded into
   *  KERNEL_WRITE_POLICY; absence still fails CLOSED (System/denied). */
  writePolicy?: Record<string, unknown>;

  /** One-shot schema migrations. DESIGN: run by composeMigrations() at boot. */
  migrations?: FeatureMigration[];

  /** HTTP routes. DESIGN: spliced into the route table + BACKEND_PREFIXES. */
  routes?: FeatureRoute[];

  /** MCP tools. DESIGN: concatenated onto TOOLS + registered on the McpServer. */
  tools?: FeatureTool[];

  /** System docs seeded into _system_docs. DESIGN: folded into the seed list. */
  systemDocs?: FeatureSystemDoc[];
}
