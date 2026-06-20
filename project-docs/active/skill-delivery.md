# Cambium Skills

> **⚠️ Historical design doc.** Predates the **Cambium → Mnemion** rename and the current architecture. Vocabulary is pre-rename (`cambium://` → `mnemion://`, `record` → `entry`, `${CAMBIUM_TOKEN}`/`X-Cambium-Token` → Mnemion equivalents) and the marketplace/skill-delivery mechanism here is aspirational, not a description of shipped code. Kept for the design *rationale*. **For current truth, see [`CLAUDE.md`](../../CLAUDE.md).**

## Skills as schema objects, served as a live marketplace

A Cambium instance can serve itself as a Claude Code plugin marketplace. Skills are records in schema objects, authored through the same `mutate` tool used for everything else. The Worker synthesizes a marketplace-compliant directory structure from those records on every request. No git repo, no static files, no build step. The agent says "make a skill," writes records, and it's installable.

---

## The insight

Claude Code plugins are files in a git repo. A marketplace is a git repo with a `marketplace.json` that catalogs plugins, where each plugin has a `plugin.json`, optional SKILL.md files, agents, hooks, and supporting references.

But Claude Code doesn't actually need git. It needs to *clone* a repo — which is just "download a tree of files over HTTP." The Git Smart HTTP protocol is one way to serve that tree. A Cloudflare Worker that responds to the same HTTP requests with synthesized content is another. The client can't tell the difference.

Cambium already has:

- A Worker serving HTTP
- Records containing text content
- An addressing scheme (`cambium://`)
- Schema evolution for defining new object shapes

Skills are records. The marketplace is a projection. The organism grows the ability to teach other agents by writing to its own memory.

---

## Schema

Two objects support the entire system. They're created through normal schema evolution — `propose_change` / `apply_change` — not hardcoded. A Cambium instance that doesn't need skills never creates them. One that does creates them once, then they're permanent.

### `_plugins`

Each record is a plugin — a named package of skills, agents, and configuration.

```
_plugins
├── id              (text, primary)
├── name            (text, required)  — kebab-case identifier, e.g. "research-tools"
├── description     (text, required)  — what the plugin provides
├── version         (text, required)  — semver, bumped on any child skill change
├── visibility      (text, required)  — "public" or "private" (default: "private")
├── author          (text)            — who made it
├── claude_md       (text)            — CLAUDE.md content: system instructions when active
├── settings_json   (text)            — settings.json content: default config
├── mcp_json        (text)            — .mcp.json content: MCP server definitions
├── created_at      (datetime)
├── updated_at      (datetime)
```

### `_skills`

Each record is a skill within a plugin. A plugin has many skills.

```
_skills
├── id              (text, primary)
├── plugin_id       (text, required)  — references _plugins.id
├── name            (text, required)  — kebab-case, e.g. "track-research"
├── description     (text)            — triggers and purpose (goes in SKILL.md frontmatter)
├── argument_hint   (text)            — e.g. "[topic or question]"
├── skill_md        (text, required)  — the full SKILL.md body after frontmatter
├── visibility      (text, required)  — "public" or "private" (default: "private")
├── created_at      (datetime)
├── updated_at      (datetime)
```

The `visibility` field controls which marketplace endpoint serves the skill. Private skills contain operational specifics — your actual Cambium URLs, project names, workflow details. Public skills teach general patterns — how to do research tracking, how to run a daily review — that anyone can adopt. The agent should default to `private` and only mark a skill `public` when the human explicitly intends to share it.

### Optional: `_skill_references`

Supporting documents that a skill can load progressively.

```
_skill_references
├── id              (text, primary)
├── skill_id        (text, required)  — references _skills.id
├── filename        (text, required)  — e.g. "schema.md", "conventions.md"
├── content         (text, required)  — the file contents
├── created_at      (datetime)
```

### Optional: `_skill_scripts`

Executable scripts a skill can invoke.

```
_skill_scripts
├── id              (text, primary)
├── skill_id        (text, required)
├── filename        (text, required)  — e.g. "validate.sh", "format.py"
├── content         (text, required)  — script contents
├── executable      (boolean)         — chmod +x equivalent
├── created_at      (datetime)
```

---

## The marketplace endpoints: split serving

The Worker serves two marketplace routes — one public, one private — that synthesize plugin directory structures from the same underlying records, filtered by visibility.

### Public marketplace: `/marketplace/public/`

**Unauthenticated.** Serves only plugins and skills with `visibility=public`. This is the venture altruism surface — anyone can browse and install without credentials. Your evolved skills, freely available. General patterns that teach the world how to use a schema shape.

```
/plugin marketplace add https://cambium.example.com/marketplace/public
```

No token, no OAuth, no git credentials. Claude Code fetches the marketplace, discovers public plugins, installs public skills.

### Private marketplace: `/marketplace/`

**Authenticated.** Requires a Bearer token — the same OAuth token that gates `/mcp`. Serves all plugins and skills regardless of visibility. This is the personal operational surface — your specific Cambium URLs, project names, workflow details, plus everything public.

```
# Token in environment for auto-update
export CAMBIUM_TOKEN="your-oauth-token"

# Install with token-in-URL for initial add
/plugin marketplace add https://token:${CAMBIUM_TOKEN}@cambium.example.com/marketplace
```

The authenticated marketplace is a superset. Private skills appear alongside public ones. A user who installs both marketplaces gets deduplicated plugins — the private version takes precedence since it includes everything.

### Why split serving

The alternative — a single endpoint with auth-gated visibility — forces a binary choice: either all skills require credentials (killing the sharing path) or all skills are public (leaking operational specifics). Split serving lets the same `_skills` record appear in different contexts:

- A skill with `visibility=public` appears on both endpoints. The public endpoint serves it to anyone. The private endpoint includes it alongside private skills.
- A skill with `visibility=private` appears only on the authenticated endpoint. It's invisible to the public marketplace.
- A plugin with `visibility=public` appears on the public endpoint only if all of its skills are public. A single private skill in the plugin hides the whole plugin from the public marketplace. This prevents partial exposure.

The `.mcp.json` served by the public marketplace should point to the MCP endpoint but cannot include credentials — the installing user needs to authenticate separately via Claude Code's MCP OAuth flow. The private marketplace's `.mcp.json` can reference `${CAMBIUM_TOKEN}` for the user's own instance.

### Route structure (both endpoints follow the same pattern)

`GET /marketplace/[public/].claude-plugin/marketplace.json`

Synthesized from `_plugins` records (filtered by visibility):

```json
{
  "name": "cambium-marketplace",
  "owner": {
    "name": "{{from auth/config}}"
  },
  "plugins": [
    {
      "name": "research-tools",
      "source": "./plugins/research-tools",
      "description": "Skills for tracking research threads and sources",
      "version": "1.2.0"
    }
  ]
}
```

`GET /marketplace/[public/]plugins/{plugin_name}/.claude-plugin/plugin.json`

Synthesized from the plugin record:

```json
{
  "name": "research-tools",
  "version": "1.2.0",
  "description": "Skills for tracking research threads and sources",
  "skills": [
    "./skills/track-research",
    "./skills/log-source"
  ]
}
```

The `skills` array is built by querying `_skills` for records matching this plugin_id (filtered by visibility on the public endpoint).

`GET /marketplace/[public/]plugins/{plugin_name}/skills/{skill_name}/SKILL.md`

Synthesized from the skill record:

```markdown
---
name: track-research
description: Track research threads across sessions. Use when the conversation opens a new question worth investigating or revisits an existing thread.
argument-hint: "[question or topic]"
---

{skill_md content from record}
```

The frontmatter is assembled from record fields. The body is the `skill_md` field verbatim.

`GET /marketplace/[public/]plugins/{plugin_name}/skills/{skill_name}/references/{filename}`

Served from the matching `_skill_references` record's `content` field.

`GET /marketplace/[public/]plugins/{plugin_name}/skills/{skill_name}/scripts/{filename}`

Served from the matching `_skill_scripts` record's `content` field.

`GET /marketplace/[public/]plugins/{plugin_name}/CLAUDE.md`

Served from the plugin record's `claude_md` field.

`GET /marketplace/[public/]plugins/{plugin_name}/settings.json`

Served from the plugin record's `settings_json` field.

---

## The git layer

Claude Code installs plugins via `/plugin marketplace add <url>`. It expects to clone a git repo. The Worker can serve the Git Smart HTTP protocol at `/marketplace.git/`, projecting the same synthesized file tree as actual git objects.

There are two implementation paths:

**Path A: Use `git-on-cloudflare` as a reference.** Implement the minimal Git Smart HTTP v2 endpoints (`/info/refs`, `/git-upload-pack`) that synthesize packfiles from the record-backed file tree. This is the most compatible path — any git client works.

**Path B: Don't emulate git at all.** Claude Code's plugin marketplace system may accept HTTPS URLs that serve raw files without git. The LiteLLM marketplace works this way — it serves `marketplace.json` over plain HTTP. If Claude Code can add a marketplace by URL and fetch files over HTTPS without git clone, the above HTTP routes are sufficient. Test this first. It's dramatically simpler.

**Path C: Hybrid.** Serve the plain HTTP routes for browsing and direct access. Wrap them in a minimal git layer only for the `/plugin marketplace add` command. The git protocol is only needed at install time; after that, auto-update can poll the plain HTTP `plugin.json` for version changes.

---

## How skills get created

The agent creates skills through the same tools it uses for everything else. No special skill API. No separate authoring workflow.

### Step 1: Ensure skill objects exist

If this is the first skill being created, the agent proposes the `_plugins` and `_skills` objects through normal schema evolution. This is a one-time setup that the agent handles automatically when the human says "make a skill."

### Step 2: Create the plugin record

```
mutate(_plugins, create, {
  name: "cambium-ops",
  description: "Operational skills for working with this Cambium instance",
  version: "0.1.0",
  visibility: "private",
  claude_md: "Always read the Cambium index at session start via resolve('cambium://index')."
})
```

### Step 3: Create the skill record

```
mutate(_skills, create, {
  plugin_id: "01JD8...",
  name: "daily-review",
  description: "Review active items and surface what needs attention. Use at the start of every session or when the user asks for a status update.",
  argument_hint: "[focus area]",
  visibility: "private",
  skill_md: "# Daily Review\n\nRead the Cambium index. For each object...[full instructions]"
})
```

### Step 4: Add references if needed

```
mutate(_skill_references, create, {
  skill_id: "01JD8...",
  filename: "conventions.md",
  content: "# Conventions\n\nThis Cambium instance uses the following conventions..."
})
```

### Step 5: Install

The human runs in Claude Code:

```
# For private skills (your operational specifics):
/plugin marketplace add https://cambium.example.com/marketplace

# For public skills only (shareable, no auth needed):
/plugin marketplace add https://cambium.example.com/marketplace/public
```

The private marketplace requires authentication — set `CAMBIUM_TOKEN` in your environment or use the token-in-URL pattern. The public marketplace is open to anyone.

Claude Code fetches `marketplace.json`, discovers the plugins, and makes them available. Skills are loadable via `/cambium-ops:daily-review` or invoked automatically when the description matches the conversation context.

### Step 6: Update

The agent modifies a skill record via `mutate`. The plugin's `version` field gets bumped (the agent does this, or a convention establishes that the Worker auto-increments on child changes). Claude Code's auto-update detects the version change on next startup and pulls the new content.

---

## Self-describing skills

Here's where it compounds. A skill can instruct the agent to use Cambium itself. The `daily-review` skill's SKILL.md might say:

```markdown
# Daily Review

1. Call `resolve("cambium://index")` to read the current state
2. For each object in the index, call `query` with `status=active` and `sort=-updated_at` and `limit=5`
3. Summarize what's active, what's overdue, what changed recently
4. If anything is overdue, ask the user how to handle it
5. Log this review as a record in the `sessions` object if it exists
```

The skill teaches an agent how to compose Cambium's six tools for a specific workflow. The skill is *stored in* Cambium, *served by* Cambium, and *operates on* Cambium. The organism teaches agents how to interact with it, using itself as both the instruction manual and the operating surface.

---

## The `.mcp.json` connection

Every plugin can include an `.mcp.json` that points Claude Code at the Cambium MCP endpoint. This means installing the marketplace gives Claude Code both the skills *and* the tool connection in one step:

```json
{
  "mcpServers": {
    "cambium": {
      "type": "url",
      "url": "https://cambium.example.com/mcp"
    }
  }
}
```

Stored in the plugin record's `mcp_json` field. Served at `/marketplace/plugins/{name}/.mcp.json`. The agent sets this when creating the plugin record — it knows the Cambium URL because it's already connected to it.

First plugin install = MCP connection + skill instructions + auto-update. One command.

---

## What this enables

**Skills that evolve.** The agent updates a SKILL.md by mutating a record. The marketplace serves the new content on next fetch. No git commit, no deploy, no PR. The skill evolves as fast as the agent can write.

**Skills that reflect the schema.** A skill's instructions can reference the actual objects and fields in this Cambium instance. When the schema evolves, the agent can update the skill to match. The instructions and the data they operate on live in the same system.

**Skills authored from any surface.** Claude.ai can create a skill via `mutate`. Claude Code can refine it. The iOS app can display and edit skill content. All surfaces write to the same records.

**Private skills for personal operations, public skills for the commons.** A daily-review skill that references your specific Cambium URL and project names stays private. A research-tracking skill that teaches a general pattern — how to compose `query` and `mutate` for thread-based investigation — goes public. Flip the `visibility` field from `private` to `public` when a skill has been tested enough to share. The same record, served on a different endpoint.

**Exportable skill packages.** Query `_plugins` and `_skills`, dump the results, and you have a portable skill package. Someone else imports it into their Cambium instance by creating the same records. The organism's learned behaviors are transferable.

**Skills as a teaching mechanism.** When someone forks a Cambium instance (installs it as a plugin seed per `cambium-plugins.md`), the skills come with it. The new user gets not just the schema shape but the operational instructions for how an agent should work with that shape. The organism's knowledge of how to use itself propagates alongside its structure.

**Gradual publication.** A skill starts private. You use it for a week, refine the instructions, fix edge cases. When it's solid, you change `visibility` to `public` and it immediately appears on the public marketplace. No separate publishing workflow. No copying between systems. The same record serves both your private operations and the public commons.

---

## Relationship to the six tools

Skills don't add tools. Skills compose the existing six tools into workflows. The tool surface stays frozen. The skill surface is infinitely extensible through record creation.

A skill is data — a record in `_skills` with a `skill_md` field. Creating a skill is a `mutate` call. Updating a skill is a `mutate` call. Reading a skill is a `resolve` call. Finding skills is a `search` call. The skill system is built entirely on the six primitives.

This is the pattern: every new capability is a schema configuration, not a code change. Skills, routes, plugins, conventions — all data. The kernel never grows. The organism grows.

---

## Open questions

**Auto-versioning.** When a skill record is updated via `mutate`, should the Worker automatically bump the parent plugin's version? Pros: no manual version management. Cons: every typo fix triggers an auto-update for every Claude Code client. Probably: auto-bump patch version, let the agent explicitly bump minor/major.

**Skill validation.** Should `mutate` validate SKILL.md content? At minimum, check that the frontmatter fields (name, description) are present. Beyond that, validation is the agent's job — the SKILL.md format is just markdown with YAML frontmatter, and the agent knows the spec.

**Marketplace discovery.** Claude Code's marketplace system expects to clone-and-scan. If we go the plain HTTP route (Path B), does Claude Code's marketplace add command accept non-git URLs? This is the key technical validation needed before implementation. LiteLLM serves `marketplace.json` over plain HTTP and it works — but their docs show Claude Code fetching a JSON URL directly, not cloning a repo. Needs testing.

**Skill composition across instances.** If two Cambium instances serve public marketplaces, Claude Code can install skills from both. The skills operate on their respective Cambium MCP connections. But can a skill from instance A reference data in instance B? Via `resolve` with different base URLs, potentially — but this is uncharted territory.

**Public skill sanitization.** When a skill is marked public, should the Worker scan the `skill_md` content for references to private Cambium URIs or instance-specific details? A skill that accidentally includes `https://myhive.workers.dev/mcp` in its instructions would leak infrastructure details. The agent should generalize private references to `{{CAMBIUM_URL}}` before publishing — but enforcing this automatically without false positives is hard.

**Private marketplace auth transport.** Claude Code's git credential handling is unreliable for private repos. The token-in-URL pattern (`https://token:xxx@host/marketplace`) is the most portable option but puts credentials in Claude Code's config files. An alternative: the Worker accepts a custom header (`X-Cambium-Token`) and Claude Code's `--header` flag on `mcp add` passes it. Whether `/plugin marketplace add` supports custom headers needs testing.

