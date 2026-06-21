#!/usr/bin/env node
// Convention detector — the structural lens of "conventions are a failure lurking
// in the code; we need contracts."
//
// A CONVENTION is a correctness property that depends on a human/agent REMEMBERING
// to do something at each site: a load-bearing GUARD reached at N>1 call sites with
// no enforcing contract. It is a block-list — it fails open the moment one site
// forgets (exactly how /f and /p drifted from the served-inertness doctrine). A
// CONTRACT enforces the property by structure: an anchored coherence boundary
// (chokepoint + totality oracle) or, at least, a "totality"-named test.
//
// This script surfaces guards (by a guard-verb lexicon + a curated seed), counts
// each one's call-site fan-out, and classifies it against the contracts that exist
// (boundary claims in *.spec.md, totality tests in src/__tests__). Guards with
// fan-out and NO contract are flagged — the candidate conventions to convert.
//
// ADVISORY by default (like `coherence decompose`): it surfaces candidates, you
// judge — a high-fan-out guard may be a legitimate chokepoint every path must
// traverse, OR a block-list. `--check` makes it a RATCHET against a baseline: it
// fails if a NEW convention appears (or an existing one's fan-out grows) without a
// contract, so the convention surface can only shrink. `--update-baseline` pins it.
//
// Usage:  node scripts/conventions.mjs            # advisory report
//         node scripts/conventions.mjs --check    # ratchet (exit 1 on regression)
//         node scripts/conventions.mjs --update-baseline
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIRS = ["entities", "shared", "src"];
const TEST_DIR = join("src", "__tests__");
const BASELINE = join(ROOT, "scripts", "conventions-baseline.json");

// Guard-verb lexicon: function names that signal a correctness/security decision.
const GUARD_VERB =
  /^(is|has|can|should|assert|verify|check|validate|ensure|require|deny|refuse|reject|gate|seal|sanitiz|escape|guard|enforce|redact|mint|scope)/;
// Curated seed — load-bearing guards whose names don't match the verb lexicon.
const SEED = new Set([
  "seal", "sealAll", "servedQuery", "currentHost", "inertHeaders",
  "scopeMatches", "applyKernelRules", "normalizeHost", "writeClass",
]);
// Triage, codified: guards the detector surfaces but that are NOT unguarded
// conventions — each is covered by another contract or is not a fail-open guard.
// Encoding the judgment here (with its reason) makes the triage repeatable instead
// of a one-time human call, and keeps the flagged set real signal. A guard leaves
// this map only when its stated cover is removed.
const DISMISSED = {
  escapeXml: "chokepoint-shaped HTML-escape guard — covered by the injection-lint ratchet (coarse; quoteIdent-style enshrinement is the structural upgrade)",
  isValidColumn: "chokepoint-shaped SQL-identifier guard — covered by the injection-lint ratchet",
  escapeLike: "chokepoint-shaped LIKE-escape guard — covered by the injection-lint ratchet",
  sealAll: "covered by the egress-sensitivity boundary (SENSITIVE_COLUMNS / verifyEgressTotality)",
  isDevAutoApprove: "covered by auth-fail-closed.test.ts (the name heuristic missed its describe)",
  isPrivateIPv4: "internal helper of isBlockedFederationHost — covered by the SSRF block-host totality",
  normalizeHost: "feeds isBlockedFederationHost + the federation fetch — covered transitively by SSRF + federation tests",
  isMemberActive: "enforced inside the applyKernelRules kernel-hook chokepoint, not at scattered sites",
  ensureAuditTriggers: "idempotent infra setup, not a fail-open guard",
  verifyFieldsIntegrity: "a boot integrity verifier (itself a check), not a remembered guard",
  hasPasskey: "a read ('does a passkey exist') used to choose UI, not a security gate",
};

// Imperative debt-markers: comments telling a future author to remember something.
const IMPERATIVE =
  /\/\/.*\b(any new |callers? must|must (call|always|route|go through|seal|use|never)|by convention|remember to|don'?t forget|be sure to|make sure (to|that)|always (call|use|route|seal|go)|never (forget|bypass|skip)|every (new )?\w+ (must|should))\b/i;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

const allTs = SRC_DIRS.flatMap((d) => walk(join(ROOT, d)));
const testFiles = allTs.filter((p) => p.includes(`${TEST_DIR}`));
const srcFiles = allTs.filter((p) => !p.includes(`${TEST_DIR}`));
const read = (p) => readFileSync(p, "utf8");

// 1. Surface candidate guards from source declarations.
const DECL =
  /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_]\w*)\s*\(|(?:export\s+)?const\s+([a-zA-Z_]\w*)\s*=\s*(?:async\s*)?\(/g;
const guards = new Map(); // name -> { defFile }
for (const f of srcFiles) {
  const txt = read(f);
  for (const m of txt.matchAll(DECL)) {
    const name = m[1] || m[2];
    if (!name) continue;
    if (GUARD_VERB.test(name) || SEED.has(name)) {
      if (!guards.has(name)) guards.set(name, { defFile: f });
    }
  }
}

// 2. Count call-site fan-out per guard (across source, excluding its own declaration).
const srcText = srcFiles.map((f) => ({ f, t: read(f) }));
function callSites(name) {
  const call = new RegExp(`\\b${name}\\s*\\(`, "g");
  const decl = new RegExp(`function\\s+${name}\\s*\\(`, "g");
  let n = 0;
  for (const { t } of srcText) n += (t.match(call)?.length ?? 0) - (t.match(decl)?.length ?? 0);
  return n;
}

// 3. Contracts that exist: boundary-claim chokepoint symbols from every *.spec.md.
const allSpecs = [];
(function specWalk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) specWalk(p);
    else if (name.endsWith(".spec.md")) allSpecs.push(p);
  }
})(ROOT);
const anchored = new Set();
const BOUNDARY = /boundary\s+"[^"]+"\s+at\s+([A-Za-z_]\w*)\s+via\b/g;
for (const s of allSpecs)
  for (const m of read(s).matchAll(BOUNDARY)) anchored.add(m[1]);

// 4. Totality-oracle coverage: a test file that references the guard AND declares a
//    describe/it whose title contains "totality".
const totalityTests = testFiles
  .map((f) => ({ f, t: read(f) }))
  .filter(({ t }) => /(?:describe|it)\s*\(\s*["'`][^"'`]*totality/i.test(t));
function hasOracle(name) {
  const ref = new RegExp(`\\b${name}\\b`);
  return totalityTests.some(({ t }) => ref.test(t));
}

// 5. Classify.
const rows = [];
for (const [name, { defFile }] of guards) {
  const sites = callSites(name);
  if (sites < 1) continue; // definition-only / unused
  const isAnchored = anchored.has(name);
  const oracle = hasOracle(name);
  let status, reason = "";
  if (DISMISSED[name]) { status = "dismissed"; reason = DISMISSED[name]; }
  else if (isAnchored) status = "ANCHORED";  // a coherence boundary chokepoint — best
  else if (oracle) status = "ORACLE";        // a totality test, not yet a formal boundary
  else if (sites <= 1) status = "single";    // one site — not a block-list
  else status = "CONVENTION";                // fan-out + no contract — the flag
  rows.push({ name, sites, status, reason, def: defFile.replace(ROOT + "/", "") });
}
rows.sort((a, b) => b.sites - a.sites);
const conventions = rows.filter((r) => r.status === "CONVENTION");

// Linguistic lens: imperative debt-marker density.
let markerCount = 0;
const markerByFile = {};
for (const f of srcFiles) {
  let c = 0;
  for (const line of read(f).split("\n")) if (IMPERATIVE.test(line)) c++;
  if (c) { markerByFile[f.replace(ROOT + "/", "")] = c; markerCount += c; }
}

// --- modes ---
const mode = process.argv[2];
if (mode === "--update-baseline") {
  const base = conventions.map((c) => ({ name: c.name, sites: c.sites })).sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n");
  console.log(`Pinned ${base.length} known conventions to ${BASELINE.replace(ROOT + "/", "")}`);
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n  CONVENTION DETECTOR — load-bearing guards vs the contracts that enforce them\n");
console.log(`  ${pad("guard", 26)} ${pad("call-sites", 11)} status`);
console.log(`  ${"-".repeat(26)} ${"-".repeat(11)} ${"-".repeat(12)}`);
for (const r of rows) {
  const flag = r.status === "CONVENTION" ? "  ◀ CONVENTION (no contract)"
    : r.status === "ANCHORED" ? "  ✓ boundary"
    : r.status === "ORACLE" ? "  ✓ totality test"
    : r.status === "dismissed" ? `  — dismissed: ${r.reason}`
    : "";
  console.log(`  ${pad(r.name, 26)} ${pad(r.sites, 11)} ${pad(r.status, 12)}${flag}`);
}
console.log(`\n  Structural: ${conventions.length} candidate convention(s) — guards with fan-out and no contract.`);
if (conventions.length)
  console.log("  → convert each to a contract: a chokepoint every path must traverse, or a totality oracle over its call-site category.");
console.log(`\n  Linguistic: ${markerCount} imperative debt-marker comment(s) across ${Object.keys(markerByFile).length} files`);
const worst = Object.entries(markerByFile).sort((a, b) => b[1] - a[1]).slice(0, 5);
for (const [f, c] of worst) console.log(`    ${pad(c, 4)} ${f}`);
console.log(`  (anchored boundaries: ${anchored.size})`);

if (mode === "--check") {
  if (!existsSync(BASELINE)) {
    console.error("\n  --check: no baseline. Run --update-baseline first.");
    process.exit(2);
  }
  const base = JSON.parse(read(BASELINE));
  const baseMap = new Map(base.map((b) => [b.name, b.sites]));
  const regressions = [];
  for (const c of conventions) {
    if (!baseMap.has(c.name)) regressions.push(`NEW convention: ${c.name} (${c.sites} sites)`);
    else if (c.sites > baseMap.get(c.name)) regressions.push(`${c.name} fan-out grew ${baseMap.get(c.name)}→${c.sites} without a contract`);
  }
  if (regressions.length) {
    console.error(`\n  ✗ convention ratchet FAILED — the surface grew:\n${regressions.map((r) => "    - " + r).join("\n")}`);
    console.error("  Convert it to a contract, or (if intentional) re-pin with --update-baseline.\n");
    process.exit(1);
  }
  console.log("\n  ✓ convention ratchet held — no new conventions.\n");
}
