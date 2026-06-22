// Normalize the non-portable fields the coherence `docs` generator stamps into its
// output, so the committed artifacts are byte-identical regardless of WHERE they were
// generated (a dev's absolute checkout path vs CI's /home/runner/...). Without this the
// docs-freshness gate can only ever pass in the one environment that produced the
// committed files — which is why CI went red the moment that gate was added.
//
// Two non-portable bits:
//   - generatedAt / a "YYYY-MM-DD HH:MMZ" wall-clock timestamp (changes every run)
//   - absRoot: the absolute path of the entry dir (machine-specific)
//
// Both are derivation-irrelevant (the graph itself is derived from the spec tree + code
// + git history, which is identical across checkouts). We collapse them to constants in
// BOTH `coherence:docs` (so the committed copy is normalized) and `coherence:docs:check`
// (which regenerates, normalizes, then `git diff`s) — so the comparison is deterministic.
//
// Run with cwd = mnemion-js (as npm scripts do).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TS = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/g;
const FILES = ["docs/coherence/graph.json", "docs/coherence/_graph.html", "docs/coherence/_overview.html"];

// The absolute root, read from graph.json's own `absRoot` field — so we replace whatever
// path THIS environment produced (mac, Linux, …), not a hardcoded one.
let absRoot = null;
try {
  const g = readFileSync("docs/coherence/graph.json", "utf8");
  absRoot = g.match(/"absRoot":\s*"([^"]*)"/)?.[1] ?? null;
} catch { /* graph.json absent — nothing to normalize */ }

for (const f of FILES) {
  if (!existsSync(f)) continue;
  let s = readFileSync(f, "utf8");
  s = s.replace(TS, "NORMALIZED-TIMESTAMP");
  if (absRoot) s = s.split(absRoot).join("NORMALIZED-ABSROOT");
  writeFileSync(f, s);
}
