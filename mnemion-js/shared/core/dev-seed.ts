// Dev seed: realistic data for local development
//
// Called from initializeSchema when DEV_SEED is set and no user patterns exist.
// Uses raw SQL (runs inside blockConcurrencyWhile during DO construction).

import { PRODUCT_NAME, uri } from "./constants";
import { ensureAuditTriggers } from "../../entities/Hive/schema";

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

// === Helpers ===

function pat(db: DB, name: string, desc: string, doctrine: string, facets: { name: string; type: string; required?: boolean; ref?: string }[]) {
  const sqlTypes: Record<string, string> = { text: "TEXT", integer: "INTEGER", number: "REAL", boolean: "INTEGER", datetime: "TEXT", select: "TEXT" };
  const colDefs = facets.map(f => {
    let col = `"${f.name}" ${sqlTypes[f.type] || "TEXT"}`;
    if (f.required) col += " NOT NULL";
    if (f.ref) col += ` REFERENCES "${f.ref}"("id")`;
    return col;
  });
  db.exec(`CREATE TABLE "${name}" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ${colDefs.join(",\n    ")},
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT
  )`);
  db.exec("INSERT INTO _objects (name, description, doctrine) VALUES (?, ?, ?)", name, desc, doctrine);
  for (const f of facets) {
    db.exec(
      "INSERT INTO _fields (object_name, name, type, required, references_object) VALUES (?, ?, ?, ?, ?)",
      name, f.name, f.type, f.required ? 1 : 0, f.ref ?? null
    );
  }
  ensureAuditTriggers(db, name);
}

function ins(db: DB, table: string, data: Record<string, unknown>): number {
  const keys = Object.keys(data);
  const cols = keys.map(k => `"${k}"`).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  db.exec(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`, ...keys.map(k => data[k]));
  return (db.exec(`SELECT last_insert_rowid() as id`).one() as { id: number }).id;
}

// === Seed ===

export function seedDevData(db: DB): void {
  // Charter
  ins(db, "_charter", { key: "owner", value: "Local Developer" });
  ins(db, "_charter", { key: "purpose", value: "Development and testing" });

  // --- Patterns ---

  pat(db, "goals", "High-level objectives and outcomes to work toward", "Record goals when the human establishes clear objectives. Keep them concise and outcome-oriented.", [
    { name: "title", type: "text", required: true },
    { name: "status", type: "text" },
    { name: "notes", type: "text" },
  ]);

  pat(db, "tasks", "Concrete work items that advance goals", "Create tasks for specific actionable work. Link to the goal they serve.", [
    { name: "title", type: "text", required: true },
    { name: "status", type: "text" },
    { name: "goal_id", type: "integer", ref: "goals" },
    { name: "notes", type: "text" },
  ]);

  pat(db, "notes", "Freeform observations, ideas, and journal entries", "Write notes freely. Date and context emerge naturally from timestamps.", [
    { name: "title", type: "text", required: true },
    { name: "body", type: "text" },
    { name: "tags", type: "text" },
  ]);

  pat(db, "bookmarks", "Saved links with annotations", "Save URLs worth revisiting. Always include a reason — bare links are noise.", [
    { name: "url", type: "text", required: true },
    { name: "title", type: "text", required: true },
    { name: "description", type: "text" },
    { name: "tags", type: "text" },
  ]);

  // --- Entries ---

  const g1 = ins(db, "goals", { title: "Ship the canvas feature", status: "active", notes: "Spatial thinking for Mnemion. SVG-based infinite canvas with notes, entries, links, and connections." });
  const g2 = ins(db, "goals", { title: "Improve local dev experience", status: "active", notes: "Make wrangler dev useful without deploying. Seed data, remote bindings, fast iteration." });
  const g3 = ins(db, "goals", { title: "Federation protocol", status: "planning", notes: "Cross-hive data sharing. Sovereign hives, voluntary connections, HTTP as protocol." });

  ins(db, "tasks", { title: "Build Canvas.svelte with three-panel layout", status: "done", goal_id: g1, notes: "SVG stage, canvas list panel, object palette" });
  ins(db, "tasks", { title: "Add canvas auto-save and persistence", status: "in-progress", goal_id: g1, notes: "Debounced snapshot save to _canvases pattern" });
  ins(db, "tasks", { title: "Implement connection drawing between shapes", status: "in-progress", goal_id: g1 });
  ins(db, "tasks", { title: "Add drag-to-canvas from pattern palette", status: "done", goal_id: g1 });
  ins(db, "tasks", { title: "Seed realistic dev data on local startup", status: "in-progress", goal_id: g2 });
  ins(db, "tasks", { title: "Document dev workflow in CLAUDE.md", status: "todo", goal_id: g2 });
  ins(db, "tasks", { title: "Design federation URI resolution for foreign hives", status: "todo", goal_id: g3 });
  ins(db, "tasks", { title: "Implement auth code exchange for private federation", status: "todo", goal_id: g3 });

  ins(db, "notes", { title: "Architecture insight: code as schematic", body: "The route table in index.ts is the reference example. Method, pattern, auth gate, handler — one line per route. The full surface is visible in 15 lines. The CHANGE_TYPES table follows the same pattern. Structure as declarative, scannable tables.", tags: "architecture, design" });
  ins(db, "notes", { title: "Vocabulary matters", body: "Renamed everything from database terms to biological vocabulary. Pattern, entry, facet, link, hive. It reshapes how agents think about the data — not rows in a table, but living structures in an organism.", tags: "naming, philosophy" });
  ins(db, "notes", { title: "SVG canvas vs Konva", body: "Started with tldraw (React, commercial license) then switched to svelte-konva, then realized plain SVG with foreignObject gives us rich HTML shapes without any canvas library dependency. The browser IS the rendering engine.", tags: "canvas, architecture" });
  ins(db, "notes", { title: "Fragment promotion works", body: "Short-term fragments that surface in 3+ prime calls auto-promote to long-term. The 30-day TTL on short-term handles cleanup. Write liberally — relevance is proved by recall, not by upfront judgment.", tags: "memory, prime" });
  ins(db, "notes", { title: "Session cookies for browser pages", body: "HMAC-SHA256 session cookies with 24h expiry. The session gate redirects to /login, which supports both passkey and master secret. Clean separation from the OAuth flow used by MCP clients.", tags: "auth" });

  ins(db, "bookmarks", { url: "https://developers.cloudflare.com/durable-objects/", title: "Durable Objects docs", description: "Reference for DO SQLite, alarms, websockets, PITR", tags: "cloudflare, reference" });
  ins(db, "bookmarks", { url: "https://svelte.dev/docs/svelte/overview", title: "Svelte 5 docs", description: "Runes, snippets, SSR — the Svelte 5 way", tags: "svelte, reference" });
  ins(db, "bookmarks", { url: "https://modelcontextprotocol.io/", title: "MCP specification", description: "Model Context Protocol — tools, resources, prompts", tags: "mcp, reference" });

  // --- Views (one of each shape, so the desk shows the palette's range) ---
  // Seeds are trusted (raw SQL, bypass the kernel hook) so they must be valid
  // against the palette: every facet named below is real on its pattern.
  ins(db, "_views", { pattern: "tasks", name: "default", view_type: "board",
    config: JSON.stringify({ group_by: "status", title: "title", columns: ["todo", "in-progress", "done"] }) });
  ins(db, "_views", { pattern: "bookmarks", name: "default", view_type: "table",
    config: JSON.stringify({ columns: ["title", "url", "tags"], title: "title", sort: "title" }) });
  ins(db, "_views", { pattern: "notes", name: "default", view_type: "cards",
    config: JSON.stringify({ title: "title", subtitle: "tags", fields: ["body"] }) });
  ins(db, "_views", { pattern: "goals", name: "default", view_type: "list",
    config: JSON.stringify({ title: "title", secondary: "notes", meta: "status" }) });

  // --- Links ---

  ins(db, "_links", { source_pattern: "tasks", source_id: 1, target_pattern: "notes", target_id: 3, label: "inspired-by" });
  ins(db, "_links", { source_pattern: "goals", source_id: 1, target_pattern: "goals", target_id: 2, label: "depends-on" });
  ins(db, "_links", { source_pattern: "notes", source_id: 1, target_pattern: "bookmarks", target_id: 1, label: "references" });

  // --- Canvases ---

  const canvasSnapshot = JSON.stringify({
    shapes: [
      { id: "n1", type: "note", x: 100, y: 100, w: 200, h: 100, data: { text: "Canvas MVP: notes, entries, links, connections", color: "#e8c872" } },
      { id: "n2", type: "note", x: 400, y: 80, w: 200, h: 100, data: { text: "Next: drag-and-drop from palette, named groups", color: "#4a6a8a" } },
      { id: "e1", type: "entry", x: 100, y: 280, w: 240, h: 120, data: { pattern: "goals", entryId: g1, label: "Ship the canvas feature", facets: { status: "active" } } },
      { id: "e2", type: "entry", x: 400, y: 280, w: 240, h: 120, data: { pattern: "goals", entryId: g2, label: "Improve local dev experience", facets: { status: "active" } } },
    ],
    connections: [
      { id: "c1", from: "n1", to: "e1" },
      { id: "c2", from: "n2", to: "e1" },
      { id: "c3", from: "e1", to: "e2" },
    ],
    camera: { x: 0, y: 0, zoom: 1 },
  });
  ins(db, "_canvases", { name: "project roadmap", snapshot: canvasSnapshot });
  ins(db, "_canvases", { name: "architecture notes", snapshot: "{}" });

  // --- Shared entry for testing /o/entry/ routes ---

  ins(db, "_shared", { source_pattern: "notes", source_id: 1, visibility: "public" });

  // Update guidance
  db.exec("UPDATE _meta SET guidance = ?, version = version + 1",
    `${PRODUCT_NAME} is active (dev mode). Read ${uri("index")} for orientation, then query and mutate to work with data.`);
}
