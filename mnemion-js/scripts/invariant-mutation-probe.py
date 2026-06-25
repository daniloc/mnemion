#!/usr/bin/env python3
"""Invariant-oracle mutation harness — the boundary-oracle ratchet.

Pressure-tests whether each boundary's totality ORACLE is SEMANTIC: does breaking
the boundary's own chokepoint actually trip its oracle? For each edge we apply one
compile-safe mutation to the chokepoint, run the oracle, and classify:

Usage:
  python3 scripts/invariant-mutation-probe.py            # full sweep (CI backstop on main)
  python3 scripts/invariant-mutation-probe.py --changed <ref>   # only edges touched vs <ref> (PR CI)

Exit nonzero (ratchet FAIL) on any VACUOUS / SKIP / INVALID edge; pass only when
every run edge is ANCHORED or declared-SHADOWED.


  ANCHORED — oracle ran and a test FAILED   -> catches a real break. Good.
  VACUOUS  — oracle ran and all tests PASSED -> missed the break. NEEDS HUMAN CONFIRM.
  INVALID  — oracle could not load/compile   -> mutation not compile-safe; inconclusive.

Two methodological guards learned from running this:

  1. INVALID: a mutation that breaks compilation would make the oracle "fail" for
     the wrong reason and masquerade as ANCHORED. Trust ANCHORED only when tests
     actually RAN and an ASSERTION failed.

  2. SHADOWED: a VACUOUS verdict does NOT prove a weak oracle. The mutated chokepoint
     may be behavior-preserving in the TEST RUNTIME because a redundant earlier gate
     enforces the same property (defense-in-depth). Example: denyUnlessBearerScope is
     shadowed under DEV=true/no-secret — io.ts refuses non-public reads with 404
     before reaching it, so disabling it changes nothing the oracle can observe. Such
     edges carry shadowed=True and their VACUOUS is EXPECTED, not a gap. Every other
     VACUOUS must be human-confirmed to actually exercise the chokepoint before it is
     called a real oracle weakness.

EDGES are self-edges here (break a boundary -> its own oracle). The same record
shape expresses COMPOSITION edges (break a BASE lemma -> a DEPENDENT's oracle): just
point `oracle` at the dependent's test. Run only the dependent subtree of what you
changed and you get the colleague's incremental-verification payoff for free.

Safe by construction: refuses a dirty tree, restores every file via `git checkout`
in a finally block (survives Ctrl-C), touches only declared files.
"""
import subprocess, sys, os

ROOT = subprocess.run(["git","rev-parse","--show-toplevel"],capture_output=True,text=True).stdout.strip()
JS = os.path.join(ROOT, "mnemion-js")

# (chokepoint_file, match, replace, oracle_test, label, shadowed_note)
# shadowed_note != "" means: this chokepoint is NOT the operative gate in the test
# runtime, so a VACUOUS verdict is EXPECTED and not an oracle weakness.
EDGES = [
 ("entities/Hive/hive.ts",
  "{ ...this.ctxFields(actor), trusted: false }",
  "{ ...this.ctxFields(actor), trusted: true }",
  "src/__tests__/context-capability.test.ts",
  "kernel read+write capability (trusted flag)", ""),
 ("shared/core/sql.ts",
  'if (typeof name !== "string" || !IDENTIFIER_RE.test(name))',
  "if (false)",
  "src/__tests__/sql-ident.test.ts",
  "sql-identifier quoting (quoteIdent grammar)", ""),
 ("entities/Hive/kernel.ts",
  'if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;',
  'if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;',
  "src/__tests__/ssrf.test.ts",
  "SSRF block-host (isBlockedFederationHost)", ""),
 ("shared/core/host.ts",
  "if (configured && configured !== WORKER_HOST_PLACEHOLDER) return configured;",
  "if (false && configured !== WORKER_HOST_PLACEHOLDER) return configured;",
  "src/__tests__/host-resolution.test.ts",
  "instance-identity host (resolveHost prefers config)", ""),
 ("shared/Routing/router.ts",
  "if (!token || !(await ctx.hive.validateAccessToken(token, scope))) {",
  "if (false) {",
  "src/__tests__/served-bearer-gating.test.ts",
  "served-read gating (denyUnlessBearerScope)",
  "DEV=true/no-secret runtime refuses non-public reads with 404 BEFORE reaching "
  "denyUnlessBearerScope; the boundary (not-served-unauthenticated) is still enforced "
  "and tested via that gate. The 401 path needs a configured-secret runtime to isolate."),
 ("entities/Hive/policy.ts",
  "for (const c of cols) delete out[c.column];",
  "for (const c of cols) out[c.column];",
  "src/__tests__/security.test.ts",
  "egress-sensitivity (seal strips SENSITIVE_COLUMNS)", ""),
 ("entities/Hive/hive.ts",
  "data[col] = await cred.hashToken(raw);",
  "data[col] = raw;",
  "src/__tests__/born-hashed-secret.test.ts",
  "born-hashed secrets (mintSecrets digests before INSERT)", ""),
]

def sh(args, **kw): return subprocess.run(args, cwd=JS, capture_output=True, text=True, **kw)

import re

# --- run-set selection -------------------------------------------------------
# Full mode (default) runs every edge — the backstop on push to main. `--changed
# <ref>` runs ONLY edges whose chokepoint OR oracle file changed vs <ref>; on PRs
# this is the incremental-verification payoff (most PRs touch no boundary and pay
# nothing) AND it keeps an oracle weakened without touching its chokepoint in scope
# (the oracle file changed). git diff returns repo-root-relative paths.
RUN = EDGES
if "--changed" in sys.argv:
    ref = sys.argv[sys.argv.index("--changed") + 1]
    # two-dot (tip-vs-tip), not three-dot: robust when only the base TIP is fetched
    # (CI shallow-fetches the base). Over-running a few edges if base advanced is
    # harmless for a ratchet; missing one is not.
    changed = set(sh(["git","diff","--name-only",ref,"HEAD"]).stdout.split())
    RUN = [e for e in EDGES if f"mnemion-js/{e[0]}" in changed or f"mnemion-js/{e[3]}" in changed]
    if not RUN:
        print(f"no boundary chokepoint or oracle changed vs {ref} — nothing to mutate."); sys.exit(0)
    print(f"--changed {ref}: {len(RUN)} of {len(EDGES)} edges in scope\n")

# dirty-tree guard (only the files we will mutate)
for e in RUN:
    f=e[0]
    if sh(["git","diff","--quiet","--",f]).returncode != 0:
        print(f"refusing to run: {f} has uncommitted changes (harness restores via git checkout)."); sys.exit(2)

def restore():
    for f in {e[0] for e in RUN}:
        sh(["git","checkout","--",f])

results=[]; notes=[]; diaglogs=[]
try:
    print(f"{'BOUNDARY (oracle)':<48} VERDICT")
    print(f"{'-'*48} -------")
    for f,match,repl,oracle,label,shadow in RUN:
        path=os.path.join(JS,f)
        src=open(path).read()
        if match not in src:
            print(f"{label:<48} SKIP (match drifted)"); results.append((label,"SKIP")); continue
        open(path,"w").write(src.replace(match,repl,1))
        # NO_COLOR: keep vitest output plain. CI forces ANSI, which interleaves
        # escape codes INTO the summary ("Tests \x1b[..m1 failed") and broke the
        # ANCHORED match on the first CI run — the tests DID catch the mutation, the
        # harness just couldn't read its own output. Belt: strip ANSI before matching.
        r=sh(["npx","vitest","run",oracle], env={**os.environ,"NO_COLOR":"1","FORCE_COLOR":"0"})
        sh(["git","checkout","--",f])           # revert immediately
        log=re.sub(r"\x1b\[[0-9;]*m","",r.stdout+r.stderr)
        # ANCHORED = the oracle RAN and an assertion FAILED (any of vitest's failure
        # markers), as opposed to erroring before running (INVALID).
        ran_and_failed = (re.search(r"Tests\s+\d+\s+failed", log)
                          or re.search(r"Failed Tests\s+\d+", log)
                          or re.search(r"\bFAIL\b.*\.test\.", log))
        if r.returncode==0:
            if shadow:
                v="SHADOWED"; mark="o SHADOWED (expected — chokepoint not operative in test runtime)"
            else:
                v="VACUOUS"; mark="x VACUOUS  (oracle missed the break — CONFIRM not shadowed)"
        elif ran_and_failed:
            v="ANCHORED"; mark="+ ANCHORED"
        else:
            v="INVALID"; mark="~ INVALID  (no compile / inconclusive)"
        print(f"{label:<48} {mark}"); results.append((label,v))
        if v=="SHADOWED" and shadow: notes.append((label,shadow))
        # Diagnosability: dump the captured oracle output for any verdict that means
        # "the harness could not confirm this oracle is semantic" — without it an
        # INVALID/VACUOUS in CI is a black box (the lesson from the first re-land).
        if v in ("VACUOUS","INVALID"):
            tail="\n".join((log or "<no output captured>").splitlines()[-40:])
            diaglogs.append((label,v,tail))
finally:
    restore()

for label,note in notes:
    print(f"\n  note [{label}]:\n    {note}")

for label,v,tail in diaglogs:
    print(f"\n----- captured oracle output [{label}] ({v}) — last 40 lines -----\n{tail}")

a=sum(1 for _,v in results if v=="ANCHORED"); vc=sum(1 for _,v in results if v=="VACUOUS")
iv=sum(1 for _,v in results if v=="INVALID"); sh_=sum(1 for _,v in results if v=="SHADOWED")
sk=sum(1 for _,v in results if v=="SKIP")
print(f"\n=== {a} anchored · {vc} VACUOUS · {sh_} shadowed · {iv} invalid · {sk} skip  (of {len(RUN)} edges) ===")

# Ratchet exit policy: pass only when every run edge is ANCHORED or (declared)
# SHADOWED. VACUOUS = an oracle went blind to a real break. SKIP = the mutation's
# match string drifted (a chokepoint was edited) → coverage silently lost, update
# the edge. INVALID = the mutation no longer compiles → the edge no longer verifies
# anything. All three fail loudly so the edge table stays live with the code.
fail = vc + sk + iv
if fail:
    bad = [f"{label} [{v}]" for label,v in results if v in ("VACUOUS","SKIP","INVALID")]
    print("\nRATCHET FAILED — these boundary oracles are not provably semantic:")
    for b in bad: print(f"  - {b}")
    print("\nFix: harden the oracle (VACUOUS), or update the edge's match/mutation in\n"
          "scripts/invariant-mutation-probe.py (SKIP/INVALID after a chokepoint refactor).")
sys.exit(1 if fail else 0)
