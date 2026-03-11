---
slug: skills
title: "Skills & Marketplace"
---
# Skills & Marketplace Distribution

{{PRODUCT_NAME}} can serve itself as a Claude Code plugin marketplace. Skills are entries authored through `mutate`, served as a synthesized git repo on every request.

## Supporting patterns

Two patterns support the skill system. Create them via `propose_change` / `apply_change` when first needed:

### `_plugins`
Each entry is a plugin — a named package of skills and configuration.
- `name` (text, required) — kebab-case identifier
- `description` (text, required)
- `version` (text, required) — semver, bump on skill changes
- `visibility` (text, required) — "public" or "private"
- `author` (text) — optional
- `claude_md` (text) — CLAUDE.md content injected when plugin is active
- `settings_json` (text) — settings.json content
- `mcp_json` (text) — .mcp.json for MCP server definitions

### `_skills`
Each entry is a skill within a plugin.
- `plugin_id` (integer, required) — links to `_plugins.id`
- `name` (text, required) — kebab-case
- `description` (text) — triggers and purpose
- `argument_hint` (text) — e.g. "[topic or question]"
- `skill_md` (text, required) — full SKILL.md body after frontmatter
- `visibility` (text, required) — "public" or "private"

## Creating a skill workflow
1. Ensure `_plugins` and `_skills` patterns exist (one-time setup)
2. `mutate(_plugins, create, {...})` — create the plugin entry
3. `mutate(_skills, create, {...})` — create skill entries within it
4. Human installs: `/plugin marketplace add <url>`

## Marketplace endpoints
- `/marketplace/` — private, token-authenticated, serves all visibility levels
- `/marketplace/public/` — unauthenticated, serves only public plugins/skills

## Scoped tokens
Create via `mutate(_access_tokens, create, {label, scope: "marketplace", plugins: [...]})`.
- `plugins`: array of plugin names (omit for all plugins)
- `token`: auto-generated, returned in response
- Install URL: `https://{{URI_SCHEME}}:<token>@<host>/marketplace.git`

## Visibility rules
- Private skills: only on authenticated marketplace
- Public plugins: appear on public marketplace ONLY if ALL skills are public
- Default to `private`. Only mark `public` when explicitly sharing.

## Updating skills
Mutate the skill entry. Bump the plugin version. Claude Code detects the version change on next startup.
Note: Users may need to restart Claude Code for skill changes to take effect.
