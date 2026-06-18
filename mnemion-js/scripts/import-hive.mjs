#!/usr/bin/env node
// Load dev-data/hive.json (from pull-hive) into a running local dev worker.
//
//   npm run dev            # in one terminal (wrangler dev on :8787 + vite)
//   npm run import-hive    # in another — loads your real data into the local hive
//
// Optional arg: a different worker origin (default http://localhost:8787).
import { readFileSync } from 'node:fs';

const origin = process.argv[2] || 'http://localhost:8787';
let body;
try {
  body = readFileSync('dev-data/hive.json', 'utf8');
} catch {
  console.error('dev-data/hive.json not found — run `npm run pull-hive <url> <token>` first');
  process.exit(1);
}

const res = await fetch(`${origin}/dev/import`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
if (!res.ok) {
  console.error(`import failed: ${res.status} ${await res.text()}`);
  console.error('(is `npm run dev` running, and in DEV mode — no MNEMION_SECRET?)');
  process.exit(1);
}
console.log('imported:', await res.text());
