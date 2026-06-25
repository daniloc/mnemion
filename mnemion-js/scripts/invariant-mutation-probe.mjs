#!/usr/bin/env node
// Invariant-oracle mutation harness — the boundary-oracle ratchet.
//
// Pressure-tests whether each boundary's totality ORACLE is SEMANTIC: does breaking
// the boundary's own chokepoint actually trip its oracle? For each edge we apply one
// compile-safe mutation to the chokepoint, run the oracle, and classify:
//
// Usage:
//   node scripts/invariant-mutation-probe.mjs            # full sweep (CI backstop on main)
//   node scripts/invariant-mutation-probe.mjs --changed <ref>   # only edges touched vs <ref> (PR CI)
//
// Exit nonzero (ratchet FAIL) on any VACUOUS / SKIP / INVALID edge; pass only when
// every run edge is ANCHORED or declared-SHADOWED.
//
//   ANCHORED — oracle ran and a test FAILED    -> catches a real break. Good.
//   VACUOUS  — oracle ran and all tests PASSED  -> missed the break. NEEDS HUMAN CONFIRM.
//   INVALID  — oracle could not load/compile    -> mutation not compile-safe; inconclusive.
//
// Two methodological guards learned from running this:
//
//   1. INVALID: a mutation that breaks compilation would make the oracle "fail" for
//      the wrong reason and masquerade as ANCHORED. Trust ANCHORED only when tests
//      actually RAN and an ASSERTION failed.
//
//   2. SHADOWED: a VACUOUS verdict does NOT prove a weak oracle. The mutated chokepoint
//      may be behavior-preserving in the TEST RUNTIME because a redundant earlier gate
//      enforces the same property (defense-in-depth). Example: denyUnlessBearerScope is
//      shadowed under DEV=true/no-secret — io.ts refuses non-public reads with 404
//      before reaching it, so disabling it changes nothing the oracle can observe. Such
//      edges carry a shadowed note and their VACUOUS is EXPECTED, not a gap. Every other
//      VACUOUS must be human-confirmed to actually exercise the chokepoint before it is
//      called a real oracle weakness.
//
// EDGES are self-edges here (break a boundary -> its own oracle). The same record
// shape expresses COMPOSITION edges (break a BASE lemma -> a DEPENDENT's oracle): just
// point `oracle` at the dependent's test. Run only the dependent subtree of what you
// changed and you get the colleague's incremental-verification payoff for free.
//
// Safe by construction: refuses a dirty tree, restores every file via `git checkout`
// in a finally block (and on SIGINT), touches only declared files.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sh = (args, opts = {}) =>
  spawnSync(args[0], args.slice(1), { cwd: JS, encoding: "utf8", ...opts });

const ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const JS = join(ROOT, "mnemion-js");

// [chokepoint_file, match, replace, oracle_test, label, shadowed_note]
// shadowed_note != "" means: this chokepoint is NOT the operative gate in the test
// runtime, so a VACUOUS verdict is EXPECTED and not an oracle weakness.
const EDGES = [
  ["entities/Hive/hive.ts",
   "{ ...this.ctxFields(actor), trusted: false }",
   "{ ...this.ctxFields(actor), trusted: true }",
   "src/__tests__/context-capability.test.ts",
   "kernel read+write capability (trusted flag)", ""],
  ["shared/core/sql.ts",
   'if (typeof name !== "string" || !IDENTIFIER_RE.test(name))',
   "if (false)",
   "src/__tests__/sql-ident.test.ts",
   "sql-identifier quoting (quoteIdent grammar)", ""],
  ["entities/Hive/kernel.ts",
   'if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;',
   'if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;',
   "src/__tests__/ssrf.test.ts",
   "SSRF block-host (isBlockedFederationHost)", ""],
  ["shared/core/host.ts",
   "if (configured && configured !== WORKER_HOST_PLACEHOLDER) return configured;",
   "if (false && configured !== WORKER_HOST_PLACEHOLDER) return configured;",
   "src/__tests__/host-resolution.test.ts",
   "instance-identity host (resolveHost prefers config)", ""],
  ["shared/Routing/router.ts",
   "if (!token || !(await ctx.hive.validateAccessToken(token, scope))) {",
   "if (false) {",
   "src/__tests__/served-bearer-gating.test.ts",
   "served-read gating (denyUnlessBearerScope)",
   "DEV=true/no-secret runtime refuses non-public reads with 404 BEFORE reaching " +
   "denyUnlessBearerScope; the boundary (not-served-unauthenticated) is still enforced " +
   "and tested via that gate. The 401 path needs a configured-secret runtime to isolate."],
  ["entities/Hive/policy.ts",
   "for (const c of cols) delete out[c.column];",
   "for (const c of cols) out[c.column];",
   "src/__tests__/security.test.ts",
   "egress-sensitivity (seal strips SENSITIVE_COLUMNS)", ""],
  ["entities/Hive/hive.ts",
   "data[col] = await cred.hashToken(raw);",
   "data[col] = raw;",
   "src/__tests__/born-hashed-secret.test.ts",
   "born-hashed secrets (mintSecrets digests before INSERT)", ""],
];

const pad = (s, n) => String(s).padEnd(n);

// --- run-set selection -------------------------------------------------------
// Full mode (default) runs every edge — the backstop on push to main. `--changed
// <ref>` runs ONLY edges whose chokepoint OR oracle file changed vs <ref>; on PRs
// this is the incremental-verification payoff (most PRs touch no boundary and pay
// nothing) AND it keeps an oracle weakened without touching its chokepoint in scope
// (the oracle file changed). git diff returns repo-root-relative paths.
let RUN = EDGES;
const ci = process.argv.indexOf("--changed");
if (ci !== -1) {
  const ref = process.argv[ci + 1];
  // two-dot (tip-vs-tip), not three-dot: robust when only the base TIP is fetched
  // (CI shallow-fetches the base). Over-running a few edges if base advanced is
  // harmless for a ratchet; missing one is not.
  const changed = new Set(sh(["git", "diff", "--name-only", ref, "HEAD"]).stdout.split(/\s+/).filter(Boolean));
  RUN = EDGES.filter((e) => changed.has(`mnemion-js/${e[0]}`) || changed.has(`mnemion-js/${e[3]}`));
  if (RUN.length === 0) {
    console.log(`no boundary chokepoint or oracle changed vs ${ref} — nothing to mutate.`);
    process.exit(0);
  }
  console.log(`--changed ${ref}: ${RUN.length} of ${EDGES.length} edges in scope\n`);
}

// dirty-tree guard (only the files we will mutate)
for (const [f] of RUN) {
  if (sh(["git", "diff", "--quiet", "--", f]).status !== 0) {
    console.log(`refusing to run: ${f} has uncommitted changes (harness restores via git checkout).`);
    process.exit(2);
  }
}

const restore = () => {
  for (const f of new Set(RUN.map((e) => e[0]))) sh(["git", "checkout", "--", f]);
};
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });

const results = [], notes = [], diaglogs = [];
try {
  console.log(`${pad("BOUNDARY (oracle)", 48)} VERDICT`);
  console.log(`${"-".repeat(48)} -------`);
  for (const [f, match, repl, oracle, label, shadow] of RUN) {
    const path = join(JS, f);
    const src = readFileSync(path, "utf8");
    if (!src.includes(match)) {
      console.log(`${pad(label, 48)} SKIP (match drifted)`);
      results.push([label, "SKIP"]);
      continue;
    }
    writeFileSync(path, src.replace(match, () => repl)); // function replacer: no $-substitution
    // NO_COLOR: keep vitest output plain. CI forces ANSI, which interleaves escape
    // codes INTO the summary ("Tests \x1b[..m1 failed") and broke the ANCHORED match
    // on the first CI run — the tests DID catch the mutation, the harness just couldn't
    // read its own output. Belt: strip ANSI before matching.
    const r = sh(["npx", "vitest", "run", oracle], { env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    sh(["git", "checkout", "--", f]); // revert immediately
    const log = `${r.stdout || ""}${r.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    // ANCHORED = the oracle RAN and an assertion FAILED (any of vitest's failure
    // markers), as opposed to erroring before running (INVALID).
    const ranAndFailed = /Tests\s+\d+\s+failed/.test(log) || /Failed Tests\s+\d+/.test(log) || /\bFAIL\b.*\.test\./.test(log);
    let v, mark;
    if (r.status === 0) {
      if (shadow) { v = "SHADOWED"; mark = "o SHADOWED (expected — chokepoint not operative in test runtime)"; }
      else { v = "VACUOUS"; mark = "x VACUOUS  (oracle missed the break — CONFIRM not shadowed)"; }
    } else if (ranAndFailed) {
      v = "ANCHORED"; mark = "+ ANCHORED";
    } else {
      v = "INVALID"; mark = "~ INVALID  (no compile / inconclusive)";
    }
    console.log(`${pad(label, 48)} ${mark}`);
    results.push([label, v]);
    if (v === "SHADOWED" && shadow) notes.push([label, shadow]);
    // Diagnosability: dump the captured oracle output for any verdict that means
    // "the harness could not confirm this oracle is semantic" — without it an
    // INVALID/VACUOUS in CI is a black box (the lesson from the first re-land).
    if (v === "VACUOUS" || v === "INVALID") {
      const tail = (log || "<no output captured>").split("\n").slice(-40).join("\n");
      diaglogs.push([label, v, tail]);
    }
  }
} finally {
  restore();
}

for (const [label, note] of notes) console.log(`\n  note [${label}]:\n    ${note}`);
for (const [label, v, tail] of diaglogs)
  console.log(`\n----- captured oracle output [${label}] (${v}) — last 40 lines -----\n${tail}`);

const count = (k) => results.filter(([, v]) => v === k).length;
const a = count("ANCHORED"), vc = count("VACUOUS"), sh_ = count("SHADOWED"), iv = count("INVALID"), sk = count("SKIP");
console.log(`\n=== ${a} anchored · ${vc} VACUOUS · ${sh_} shadowed · ${iv} invalid · ${sk} skip  (of ${RUN.length} edges) ===`);

// Ratchet exit policy: pass only when every run edge is ANCHORED or (declared)
// SHADOWED. VACUOUS = an oracle went blind to a real break. SKIP = the mutation's
// match string drifted (a chokepoint was edited) → coverage silently lost, update
// the edge. INVALID = the mutation no longer compiles → the edge no longer verifies
// anything. All three fail loudly so the edge table stays live with the code.
const fail = vc + sk + iv;
if (fail) {
  console.log("\nRATCHET FAILED — these boundary oracles are not provably semantic:");
  for (const [label, v] of results)
    if (v === "VACUOUS" || v === "SKIP" || v === "INVALID") console.log(`  - ${label} [${v}]`);
  console.log("\nFix: harden the oracle (VACUOUS), or update the edge's match/mutation in\n" +
              "scripts/invariant-mutation-probe.mjs (SKIP/INVALID after a chokepoint refactor).");
}
process.exit(fail ? 1 : 0);
