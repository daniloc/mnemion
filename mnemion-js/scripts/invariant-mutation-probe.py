#!/usr/bin/env python3
"""Invariant-oracle mutation harness (PROTOTYPE).

Pressure-tests whether each boundary's totality ORACLE is SEMANTIC: does breaking
the boundary's own chokepoint actually trip its oracle? For each edge we apply one
compile-safe mutation to the chokepoint, run the oracle, and classify:

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

# dirty-tree guard
for e in EDGES:
    f=e[0]
    if sh(["git","diff","--quiet","--",f]).returncode != 0:
        print(f"refusing to run: {f} has uncommitted changes (harness restores via git checkout)."); sys.exit(2)

def restore():
    for f in {e[0] for e in EDGES}:
        sh(["git","checkout","--",f])

results=[]; notes=[]
try:
    print(f"{'BOUNDARY (oracle)':<48} VERDICT")
    print(f"{'-'*48} -------")
    for f,match,repl,oracle,label,shadow in EDGES:
        path=os.path.join(JS,f)
        src=open(path).read()
        if match not in src:
            print(f"{label:<48} SKIP (match drifted)"); results.append((label,"SKIP")); continue
        open(path,"w").write(src.replace(match,repl,1))
        r=sh(["npx","vitest","run",oracle])
        sh(["git","checkout","--",f])           # revert immediately
        log=r.stdout+r.stderr
        if r.returncode==0:
            if shadow:
                v="SHADOWED"; mark="o SHADOWED (expected — chokepoint not operative in test runtime)"
            else:
                v="VACUOUS"; mark="x VACUOUS  (oracle missed the break — CONFIRM not shadowed)"
        elif re.search(r"Tests\s+\d+\s+failed", log):
            v="ANCHORED"; mark="+ ANCHORED"
        else:
            v="INVALID"; mark="~ INVALID  (no compile / inconclusive)"
        print(f"{label:<48} {mark}"); results.append((label,v))
        if v=="SHADOWED" and shadow: notes.append((label,shadow))
finally:
    restore()

for label,note in notes:
    print(f"\n  note [{label}]:\n    {note}")

a=sum(1 for _,v in results if v=="ANCHORED"); vc=sum(1 for _,v in results if v=="VACUOUS")
iv=sum(1 for _,v in results if v=="INVALID"); sh_=sum(1 for _,v in results if v=="SHADOWED")
sk=sum(1 for _,v in results if v=="SKIP")
print(f"\n=== {a} anchored · {vc} VACUOUS · {sh_} shadowed · {iv} invalid · {sk} skip  (of {len(EDGES)} edges) ===")
sys.exit(1 if vc else 0)
