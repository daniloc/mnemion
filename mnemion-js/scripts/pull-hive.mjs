#!/usr/bin/env node
// Pull a real hive's data to dev-data/hive.json, for seeding a local dev hive.
//
//   node scripts/pull-hive.mjs <url> <token>
//
// <url>   your instance, e.g. https://mnemion.daniloc.workers.dev
// <token> a `*` access token. Mint one from an MCP client / the app:
//         mutate(_access_tokens, create, { scope: "*", label: "dev pull" })
//
// Then load it into a running `npm run dev` worker with: npm run import-hive
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , url, token] = process.argv;
if (!url || !token) {
  console.error('usage: node scripts/pull-hive.mjs <url> <token>');
  process.exit(1);
}

const res = await fetch(`${url.replace(/\/$/, '')}/export`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`export failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();
const out = 'dev-data/hive.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 2));

const counts = Object.fromEntries(Object.entries(data.entries || {}).map(([k, v]) => [k, v.length]));
console.log(`pulled ${data.patterns?.length ?? 0} patterns → ${out}`);
console.log('entries:', counts, '· views:', data.views?.length ?? 0);
console.log('next: start `npm run dev`, then `npm run import-hive`');
