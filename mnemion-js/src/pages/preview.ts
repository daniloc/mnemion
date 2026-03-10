import { mount } from 'svelte';
import SchemaViewer from './SchemaViewer.svelte';

// Mock data — edit to match what you're designing for
const props = {
  guidance: 'Mnemion is active. 4 patterns, 2 conventions.',
  conventions: [
    'Use kebab-case for pattern names',
    'Prefer text facets for human-readable identifiers',
  ],
  patterns: [
    {
      name: 'research-threads',
      description: 'Long-running research topics with sources and evolving notes',
      entry_count: 12,
      facets: [
        { name: 'title', type: 'text', required: true },
        { name: 'status', type: 'text', required: true, default: 'active' },
        { name: 'summary', type: 'text', required: false },
        { name: 'source_url', type: 'text', required: false },
        { name: 'priority', type: 'integer', required: false, default: 0 },
      ],
    },
    {
      name: 'daily-notes',
      description: 'Freeform daily journal entries',
      entry_count: 47,
      facets: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text', required: true },
        { name: 'mood', type: 'text', required: false },
        { name: 'tags', type: 'text', required: false },
      ],
    },
    {
      name: 'bookmarks',
      description: 'Saved links with tags and annotations',
      entry_count: 203,
      facets: [
        { name: 'url', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'description', type: 'text', required: false },
        { name: 'tags', type: 'text', required: false },
        { name: 'starred', type: 'boolean', required: false, default: false },
      ],
    },
    {
      name: 'axioms',
      description: 'Core principles and beliefs that guide decision-making',
      entry_count: 8,
      facets: [
        { name: 'text', type: 'text', required: true },
        { name: 'category', type: 'text', required: false },
      ],
    },
    {
      name: '_system_docs',
      description: 'Agent orientation documentation',
      entry_count: 7,
      facets: [
        { name: 'slug', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'text', required: true },
        { name: 'default_content', type: 'text', required: false },
      ],
    },
    {
      name: '_auth_codes',
      description: 'One-time bearer tokens for remote agents',
      entry_count: 3,
      facets: [
        { name: 'token', type: 'text', required: true },
        { name: 'label', type: 'text', required: false },
        { name: 'scope', type: 'text', required: false },
      ],
    },
    {
      name: '_inputs',
      description: 'Ingress endpoint definitions',
      entry_count: 1,
      facets: [
        { name: 'path', type: 'text', required: true },
        { name: 'target_pattern', type: 'text', required: true },
        { name: 'facet_mapping', type: 'text', required: false },
        { name: 'body_facet', type: 'text', required: false },
        { name: 'visibility', type: 'text', required: false, default: 'public' },
      ],
    },
    {
      name: '_outputs',
      description: 'Egress endpoint definitions',
      entry_count: 0,
      facets: [
        { name: 'path', type: 'text', required: true },
        { name: 'content', type: 'text', required: true },
        { name: 'mime_type', type: 'text', required: false, default: 'text/plain' },
        { name: 'visibility', type: 'text', required: false, default: 'public' },
      ],
    },
  ],
};

// Mock the API endpoint for entry fetching
const mockEntries: Record<string, any[]> = {
  'research-threads': [
    { id: 1, title: 'Svelte 5 SSR in Workers', status: 'active', summary: 'Exploring how to render Svelte components server-side inside Cloudflare Workers without SvelteKit', source_url: 'https://svelte.dev/docs', priority: 2, created_at: '2026-03-08T10:00:00Z', updated_at: '2026-03-10T14:30:00Z', archived_at: null },
    { id: 2, title: 'WebAuthn passkey UX', status: 'active', summary: 'Studying passkey registration and authentication flows across platforms', source_url: null, priority: 1, created_at: '2026-03-07T09:00:00Z', updated_at: '2026-03-09T18:00:00Z', archived_at: null },
    { id: 3, title: 'Durable Object SQLite patterns', status: 'complete', summary: 'Best practices for schema management in DO SQLite — migrations, versioning, partial indexes', source_url: 'https://developers.cloudflare.com/durable-objects/', priority: 0, created_at: '2026-03-01T08:00:00Z', updated_at: '2026-03-05T12:00:00Z', archived_at: null },
  ],
  'daily-notes': [
    { id: 1, title: 'March 10 — router refactor', body: 'Extracted the flat if/else chain into a declarative dispatch table. Much cleaner. The route table reads like a spec now.\n\nAlso added Svelte SSR — the schema viewer is live.', mood: 'productive', tags: 'mnemion, architecture', created_at: '2026-03-10T08:00:00Z', updated_at: '2026-03-10T22:00:00Z', archived_at: null },
    { id: 2, title: 'March 9 — nomenclature', body: 'Renamed everything from database terms to biological vocabulary. Pattern, entry, facet, link. It feels right.', mood: 'satisfied', tags: 'mnemion, naming', created_at: '2026-03-09T08:00:00Z', updated_at: '2026-03-09T20:00:00Z', archived_at: null },
  ],
  'axioms': [
    { id: 7, text: 'Code should scan like a schematic — declarative tables over procedural chains', category: 'engineering', created_at: '2026-03-10T18:00:00Z', updated_at: '2026-03-10T18:00:00Z', archived_at: null },
    { id: 8, text: 'Vocabulary shapes thought. Name things for what they are, not what the database calls them.', category: 'design', created_at: '2026-03-10T18:05:00Z', updated_at: '2026-03-10T18:05:00Z', archived_at: null },
  ],
};

// Intercept fetch for /api/query/* in preview mode
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const match = url.match(/^\/api\/query\/(.+)$/);
  if (match) {
    const pattern = match[1];
    const entries = mockEntries[pattern] || [];
    return new Response(JSON.stringify({ entries }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
};

mount(SchemaViewer, { target: document.getElementById('app')!, props });
