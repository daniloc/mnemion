// Dev seed: realistic data for local development
//
// Called from initializeSchema when DEV_SEED is set and no user patterns exist.
// Uses raw SQL (runs inside blockConcurrencyWhile during DO construction).

import { PRODUCT_NAME, uri } from "./constants";
import { ensureAuditTriggers } from "../../entities/Hive/schema";

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

// === Helpers ===

function pat(db: DB, name: string, desc: string, doctrine: string, facets: { name: string; type: string; required?: boolean; ref?: string; format?: string }[]) {
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
      "INSERT INTO _fields (object_name, name, type, required, references_object, format) VALUES (?, ?, ?, ?, ?, ?)",
      name, f.name, f.type, f.required ? 1 : 0, f.ref ?? null, f.format ?? null
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
    { name: "url", type: "text", required: true, format: "link" }, // intrinsic: clickable everywhere
    { name: "title", type: "text", required: true },
    { name: "description", type: "text" },
    { name: "tags", type: "text" },
  ]);

  // A prose/knowledge pattern: entries are short essays, not records — the shape
  // the document view is built for (title + a lead + headed prose sections).
  pat(db, "frames", "Reusable thinking primitives — a frame, why it holds, and where it applies", "Capture a frame when a way of seeing earns reuse. Each is an essay: state it, explain the mechanism, ground it in cases.", [
    { name: "title", type: "text", required: true },
    { name: "observation", type: "text" },
    { name: "resolution", type: "text" },
    { name: "explains", type: "text" },
    { name: "examples", type: "text" },
    { name: "lineage", type: "text" },
  ]);

  // A dataset: numeric metrics for analysis, not prose. Stresses numeric
  // rendering (separators, right-align) and numeric sort.
  pat(db, "tweets", "Posts and their engagement — tabular data for analysis, not prose", "Record a post with its metrics. Aggregate by year or engagement.", [
    { name: "summary", type: "text", required: true },
    { name: "faves", type: "integer" },
    { name: "retweets", type: "integer" },
    { name: "engagement", type: "integer" },
    { name: "year", type: "integer" },
    { name: "platform", type: "text" }, // categorical → series / pie / donut dimension
  ]);
  db.exec("UPDATE _objects SET pattern_class = 'dataset' WHERE name = 'tweets'");

  // --- Entries ---

  const g1 = ins(db, "goals", { title: "Complete the React web migration", status: "active", notes: "Move the notebook UI onto React + Vite, served as static assets by the worker; retire the legacy SSR pages." });
  const g2 = ins(db, "goals", { title: "Improve local dev experience", status: "active", notes: "Make wrangler dev useful without deploying. Seed data, remote bindings, fast iteration." });
  const g3 = ins(db, "goals", { title: "Federation protocol", status: "planning", notes: "Cross-hive data sharing. Sovereign hives, voluntary connections, HTTP as protocol." });

  ins(db, "tasks", { title: "Build the notebook UI in React", status: "done", goal_id: g1, notes: "Normalized store, useSyncExternalStore, granular /ws deltas" });
  ins(db, "tasks", { title: "Add optimistic-locking conflict UI", status: "in-progress", goal_id: g1, notes: "Surface version-mismatch on concurrent edits and offer a merge/reload choice" });
  ins(db, "tasks", { title: "Render charts with recharts", status: "in-progress", goal_id: g1 });
  ins(db, "tasks", { title: "Wire the SPA shell fallback in the worker", status: "done", goal_id: g1 });
  ins(db, "tasks", { title: "Seed realistic dev data on local startup", status: "in-progress", goal_id: g2 });
  ins(db, "tasks", { title: "Document dev workflow in CLAUDE.md", status: "todo", goal_id: g2 });
  ins(db, "tasks", { title: "Design federation URI resolution for foreign hives", status: "todo", goal_id: g3 });
  ins(db, "tasks", { title: "Implement auth code exchange for private federation", status: "todo", goal_id: g3 });

  ins(db, "notes", { title: "Architecture insight: code as schematic", body: "The route table in index.ts is the reference example. Method, pattern, auth gate, handler — one line per route. The full surface is visible in 15 lines. The CHANGE_TYPES table follows the same pattern. Structure as declarative, scannable tables.", tags: "architecture, design" });
  ins(db, "notes", { title: "Vocabulary matters", body: "Renamed everything from database terms to biological vocabulary. Pattern, entry, facet, link, hive. It reshapes how agents think about the data — not rows in a table, but living structures in an organism.", tags: "naming, philosophy" });
  ins(db, "notes", { title: "Chokepoints over block-lists", body: "A recurring bug is a structural question answered at call sites. Convert a block-list (N guards at N sinks — fails open the moment one is forgotten) into one chokepoint every path crosses, with a totality oracle proving it is the only path.", tags: "architecture, security" });
  ins(db, "notes", { title: "Fragment promotion works", body: "Short-term fragments that surface in 3+ prime calls auto-promote to long-term. The 30-day TTL on short-term handles cleanup. Write liberally — relevance is proved by recall, not by upfront judgment.", tags: "memory, prime" });
  ins(db, "notes", { title: "Session cookies for browser pages", body: "HMAC-SHA256 session cookies with 24h expiry. The session gate redirects to /login, which supports both passkey and master secret. Clean separation from the OAuth flow used by MCP clients.", tags: "auth" });

  ins(db, "bookmarks", { url: "https://developers.cloudflare.com/durable-objects/", title: "Durable Objects docs", description: "Reference for DO SQLite, alarms, websockets, PITR", tags: "cloudflare, reference" });
  ins(db, "bookmarks", { url: "https://react.dev", title: "React docs", description: "Hooks, components, the React 19 way", tags: "react, reference" });
  ins(db, "bookmarks", { url: "https://modelcontextprotocol.io/", title: "MCP specification", description: "Model Context Protocol — tools, resources, prompts", tags: "mcp, reference" });

  ins(db, "frames", {
    title: "Constraints are the design",
    observation: "A constraint is usually read as the thing you work around — the budget, the deadline, the platform limit, the legacy schema. But the durable design decisions almost never come from the space of free choices; they come from the constraints that close most of the space off. When everything is possible, nothing is decided. A hard limit collapses a thousand vague options into a few sharp ones, and the sharpness is what makes the result feel inevitable rather than arbitrary.",
    resolution: "the constraint level, not the feature level",
    explains: "Why the most admired products often emerge from the most starved conditions, and why teams with unlimited runway frequently ship mush. The constraint is doing the editorial work that taste would otherwise have to do by hand. Remove it and you remove the forcing function, not just the obstacle.",
    examples: "The original Macintosh's tiny memory forced an interface economy that became its identity. Twitter's 140 characters made a writing form. A single-file architecture rule prevents the sprawl that a styleguide only nags about. In each case the limit was not survived — it was the source.",
    lineage: "A recurring pattern across the design work here: the moments of clarity arrived when an option was taken away. Named as a frame so it can be reached for on purpose rather than rediscovered each time under pressure.",
  });
  ins(db, "frames", {
    title: "The interface is a promise",
    observation: "Every control a system exposes is a commitment about what it will do and what it will protect. A button is a promise that pressing it is safe to mean what it says; a field is a promise that what you type is the thing that gets stored. When the promise and the behavior diverge — the button that sometimes destroys, the field that silently truncates — the damage is not a bug, it is a broken contract, and trust does not degrade gracefully. It collapses.",
    resolution: "the contract level (what is promised), above the implementation level (how it is met)",
    explains: "Why small inconsistencies feel disproportionately bad, and why 'it technically works' is not a defense. Users build a model from the promises; a violation invalidates the model, not just the action. It also explains why the best interfaces feel calm: their promises are narrow and kept.",
    examples: "An undo that doesn't cover every action teaches users to distrust undo entirely. A save indicator that lies once is never believed again. Conversely, a destructive action gated behind a real confirmation keeps a promise the layout already made.",
    lineage: "Drawn from repeated cases where a technically-correct UI still felt untrustworthy. The throughline was always a promise the system made with its shape and broke with its behavior.",
  });

  // --- Views (one of each shape, so the desk shows the palette's range) ---
  // Seeds are trusted (raw SQL, bypass the kernel hook) so they must be valid
  // against the palette: every facet named below is real on its pattern.
  ins(db, "_views", { pattern: "tasks", name: "default", view_type: "board",
    config: JSON.stringify({ group_by: "status", title: "title", columns: ["todo", "in-progress", "done"] }) });
  ins(db, "_views", { pattern: "bookmarks", name: "default", view_type: "table",
    // url renders as a link from its intrinsic facet format; tags is overridden
    // to chips at the view level — both sources of the resolve chain, one view.
    config: JSON.stringify({ columns: ["title", "url", "tags"], title: "title", sort: "title", formats: { tags: "tags" } }) });
  ins(db, "_views", { pattern: "notes", name: "default", view_type: "cards",
    config: JSON.stringify({ title: "title", subtitle: "tags", fields: ["body"] }) });
  ins(db, "_views", { pattern: "goals", name: "default", view_type: "list",
    config: JSON.stringify({ title: "title", secondary: "notes", meta: "status" }) });
  ins(db, "_views", { pattern: "frames", name: "default", view_type: "document",
    // observation reads as the lead; the rest as headed sections.
    config: JSON.stringify({ title: "title", lead: "observation", sections: ["resolution", "explains", "examples", "lineage"] }) });
  ins(db, "_views", { pattern: "tweets", name: "default", view_type: "table",
    // integer facets render as numbers (separators, right-aligned) by default;
    // sort by engagement descending — numerically, not lexically.
    config: JSON.stringify({ columns: ["summary", "faves", "retweets", "engagement", "year"], title: "summary", sort: "-engagement" }) });
  ins(db, "_views", { pattern: "tweets", name: "by year", view_type: "chart",
    // a second view of the same dataset, as a line (a value over time) with a
    // headline — the "data shitpost" shape.
    config: JSON.stringify({ mark: "line", x: "year", y: "engagement", agg: "sum", title: "Engagement by year", caption: "sum of engagement per year" }) });
  ins(db, "_views", { pattern: "tweets", name: "faves vs reach", view_type: "chart",
    // a third view: scatter — does fave count predict total engagement? raw
    // points, one per post (no aggregation).
    config: JSON.stringify({ mark: "scatter", x: "faves", y: "engagement", title: "Do faves predict reach?", caption: "one point per post" }) });
  ins(db, "_views", { pattern: "tweets", name: "by platform", view_type: "chart",
    // multi-series STACKED area: engagement per year split by platform — the
    // stack reads as the year's total while showing each platform's share.
    config: JSON.stringify({ mark: "area", x: "year", y: "engagement", series: "platform", stack: true, title: "Engagement by year & platform", caption: "stacked — each band is a platform" }) });
  ins(db, "_views", { pattern: "tweets", name: "faves × platform", view_type: "chart",
    // multi-series GROUPED bar: faves per year, one bar per platform side by side.
    config: JSON.stringify({ mark: "bar", x: "year", y: "faves", series: "platform", title: "Faves by year, by platform", caption: "grouped — bars side by side" }) });
  ins(db, "_views", { pattern: "tweets", name: "platform mix", view_type: "chart",
    // DONUT: share of total engagement by platform (parts of a whole).
    config: JSON.stringify({ mark: "donut", x: "platform", y: "engagement", title: "Where the engagement lives", caption: "share of total engagement" }) });
  ins(db, "_views", { pattern: "tweets", name: "post share", view_type: "chart",
    // PIE: how many posts per platform (count, no measure).
    config: JSON.stringify({ mark: "pie", x: "platform", title: "Posts per platform", caption: "count of posts" }) });

  // --- Pages: an agent-composed dashboard referencing several patterns ---
  ins(db, "_pages", { name: "Pulse", path: "pulse", title: "Pulse",
    blocks: JSON.stringify([
      { type: "heading", text: "This week", width: "full" },
      { type: "metric", pattern: "tweets", metric: "engagement", agg: "sum", label: "Total engagement", width: "third" },
      { type: "metric", pattern: "tweets", agg: "count", label: "Posts", width: "third" },
      { type: "metric", pattern: "tasks", agg: "count", label: "Open tasks", width: "third" },
      { type: "chart", pattern: "tweets", mark: "bar", x: "year", y: "engagement", agg: "sum", title: "Engagement by year", width: "full" },
      { type: "chart", pattern: "tweets", mark: "donut", x: "platform", y: "engagement", agg: "sum", title: "Engagement by platform", width: "half" },
      { type: "chart", pattern: "tweets", mark: "bar", x: "year", y: "faves", series: "platform", title: "Faves by platform", width: "half" },
      { type: "heading", text: "The board", width: "full" },
      { type: "view", pattern: "tasks", width: "full" }, // embeds tasks as its own default view (the board)
      { type: "heading", text: "Recent notes", width: "half" },
      { type: "heading", text: "A goal", width: "half" },
      { type: "list", pattern: "notes", limit: 4, width: "half" },
      { type: "entry", pattern: "goals", id: 1, width: "half" },
    ]) });

  // A PUBLIC page — a "data shitpost": opinionated title + description + a chart,
  // served at /page/engagement with OG unfurl. (visibility=public, so it serves
  // over HTTP without auth.)
  ins(db, "_pages", { name: "Engagement", path: "engagement", visibility: "public",
    title: "Old posts don't die — they compound",
    description: "Total engagement by year across my posts. One 2022 thread still dwarfs everything since.",
    blocks: JSON.stringify([
      { type: "metric", pattern: "tweets", metric: "engagement", agg: "sum", label: "Total engagement", width: "third" },
      { type: "metric", pattern: "tweets", agg: "count", label: "Posts", width: "third" },
      { type: "chart", pattern: "tweets", mark: "line", x: "year", y: "engagement", agg: "sum", title: "Engagement by year", caption: "sum of engagement per year", width: "full" },
      { type: "text", text: "One viral thread in 2022 carries more engagement than every year since combined.", width: "full" },
    ]) });

  // A second PUBLIC page exercising the multi-series machinery end to end: a
  // stacked area (drives the OG card), a donut, and a grouped bar — the "many
  // platforms, one audience" story. Served at /page/platforms.
  ins(db, "_pages", { name: "Platforms", path: "platforms", visibility: "public",
    title: "I didn't leave Twitter — my audience did",
    description: "Engagement by year, stacked by platform. You can watch the migration happen in the bands.",
    blocks: JSON.stringify([
      { type: "chart", pattern: "tweets", mark: "area", x: "year", y: "engagement", series: "platform", stack: true, title: "Engagement by year & platform", caption: "stacked bands — each platform's share of the year", width: "full" },
      { type: "chart", pattern: "tweets", mark: "donut", x: "platform", y: "engagement", agg: "sum", title: "Lifetime engagement share", width: "half" },
      { type: "chart", pattern: "tweets", mark: "bar", x: "year", y: "faves", series: "platform", title: "Faves by year & platform", width: "half" },
      { type: "text", text: "The 2022 spike was all one platform. By 2025 the bands tell a different story.", width: "full" },
    ]) });

  ins(db, "tweets", { summary: "helping a senior fix a laptop she overpaid for", faves: 27608, retweets: 4200, engagement: 132368, year: 2022, platform: "twitter" });
  ins(db, "tweets", { summary: "if only there were a word for a religious travel ban", faves: 18696, retweets: 9800, engagement: 33090, year: 2017, platform: "twitter" });
  ins(db, "tweets", { summary: "the line outside Silicon Valley Bank wraps the building", faves: 3476, retweets: 1100, engagement: 14800, year: 2023, platform: "twitter" });
  ins(db, "tweets", { summary: "live-tweeting a deploy that would not go green", faves: 900, retweets: 200, engagement: 5200, year: 2023, platform: "twitter" });
  ins(db, "tweets", { summary: "a small thread on why constraints make better design", faves: 980, retweets: 210, engagement: 4300, year: 2024, platform: "twitter" });
  ins(db, "tweets", { summary: "first week posting on a new network", faves: 600, retweets: 40, engagement: 2600, year: 2024, platform: "bluesky" });
  ins(db, "tweets", { summary: "a quiet observation about interfaces as promises", faves: 2210, retweets: 540, engagement: 8700, year: 2025, platform: "bluesky" });
  ins(db, "tweets", { summary: "the wizard isn't code generation, it's feeling rescued", faves: 1540, retweets: 330, engagement: 6100, year: 2025, platform: "threads" });
  ins(db, "tweets", { summary: "a hot take that aged badly within the hour", faves: 800, retweets: 120, engagement: 3200, year: 2025, platform: "twitter" });
  ins(db, "tweets", { summary: "shipping notes from a long week of migrations", faves: 412, retweets: 55, engagement: 1800, year: 2026, platform: "bluesky" });
  ins(db, "tweets", { summary: "threads keeps suggesting i post and i keep obliging", faves: 520, retweets: 30, engagement: 2400, year: 2026, platform: "threads" });

  // --- Links ---

  ins(db, "_links", { source_pattern: "tasks", source_id: 1, target_pattern: "notes", target_id: 3, label: "inspired-by" });
  ins(db, "_links", { source_pattern: "goals", source_id: 1, target_pattern: "goals", target_id: 2, label: "depends-on" });
  ins(db, "_links", { source_pattern: "notes", source_id: 1, target_pattern: "bookmarks", target_id: 1, label: "references" });

  // --- Shared entry for testing /o/entry/ routes ---

  ins(db, "_shared", { source_pattern: "notes", source_id: 1, visibility: "public" });

  // Update guidance
  db.exec("UPDATE _meta SET guidance = ?, version = version + 1",
    `${PRODUCT_NAME} is active (dev mode). Read ${uri("index")} for orientation, then query and mutate to work with data.`);
}
