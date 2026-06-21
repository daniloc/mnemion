#!/usr/bin/env node
// Security ATLAS — the trust-graded manifold made explicit.
//
// THE MODEL.
// The codebase implicitly forms a TRUST-GRADED MANIFOLD. We make its atlas
// declarative so "is the manifold well-formed?" becomes a rendered, checkable map.
//
//  • A CHART is a trust domain where code reasons in LOCAL terms — inside it, a
//    given trust level is assumed and the code need not re-establish it. The charts:
//      owner-trusted     full kernel access (the ownerDataCtx capability)
//      served-untrusted  public reads + ingress/upload writes (the servedDataCtx capability)
//      agent-mcp         the MCP tool surface — agent input, consent-gated
//      public-egress     served HTTP responses (/o /p /f) and the /ws broadcast
//      federated         cross-hive resolve over the network
//      storage           the SQLite / R2 substrate
//
//  • A TRANSITION MAP is a CHOKEPOINT that crosses between charts — it translates
//    coordinates (re-marshals the data) and RE-ESTABLISHES the invariant that holds
//    in the destination chart. Trust is DIRECTIONAL: most arrows preserve-or-LOWER
//    trust (owner→egress strips secrets; agent→storage gates the write); only an
//    ENSHRINED chokepoint may RAISE it (served-untrusted → owner-trusted, the
//    capability split — which is exactly why it is structurally impossible to bypass).
//
//  • Each transition map has a TIER, DERIVED from the live code:
//      tier-1  ENSHRINED       structural impossibility — one crossing, can't bypass
//      tier-2  TOTALITY-CHECKED N sites, a totality oracle proves they agree
//      tier-3  CONVENTION       N unmanaged sites — a tier-3 crossing on a security
//                               boundary is a LATENT TEAR in the manifold.
//
//    The tier is read FROM the source of truth, not asserted here: a crossing is
//    ANCHORED when a `## works when` boundary claim names its chokepoint — either the
//    transition's own symbol, OR a `anchoredBy` symbol it cites (some crossings are
//    GOVERNED by a boundary claim filed under a sibling symbol: the capability split
//    ownerDataCtx/servedDataCtx is proven by the `context-capability totality` oracle
//    anchored at `query`; seal/born-hashed by the egress oracle anchored at
//    SENSITIVE_COLUMNS). Anchored → tier 1 or 2 (`via guard` = structural/enshrined →
//    tier-1, `via test` = totality-checked → tier-2). A crossing with no governing
//    boundary claim at all is a tier-3 convention.
//
// THE CHECK (what keeps the atlas honest):
//   (a) DRIFT — a spec boundary chokepoint that is NOT in TRANSITION_MAPS (a managed
//       transition with no atlas entry).
//   (b) DANGLING — a TRANSITION_MAPS symbol that no longer exists in the source.
//   `--check` exits non-zero if either fires, so the atlas can't drift from the specs.
//
// Usage:  node scripts/atlas.mjs              # render the atlas (advisory)
//         node scripts/atlas.mjs --check      # exit 1 on drift / dangling
//         node scripts/atlas.mjs --emit-doc   # also (re)write docs/coherence/atlas.md
//   (a plain render also refreshes the doc; --emit-doc just makes that the intent.)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIRS = ["entities", "shared", "src"];
const DOC_OUT = join(ROOT, "docs", "coherence", "atlas.md");

// ─── 1. CHARTS — the trust domains ───────────────────────────────────────────
const CHARTS = {
  "owner-trusted":    "Full kernel access — the ownerDataCtx capability (the only trusted:true reader/writer).",
  "served-untrusted": "Public reads + ingress/upload writes — the servedDataCtx capability (trusted:false).",
  "agent-mcp":        "The MCP tool surface — agent input, consent-gated, never trusted with the kernel.",
  "public-egress":    "Served HTTP responses (/o /p /f) and the /ws broadcast — leaves the DO in the clear.",
  "federated":        "Cross-hive resolve over the network — a sovereign foreign hive.",
  "storage":          "The SQLite / R2 substrate beneath every chart.",
};

// ─── 2. TRANSITION_MAPS — chokepoint symbol → the crossing it manages ─────────
// Each entry: the chart it crosses FROM, the chart it crosses TO, and the
// invariant it re-establishes on the far side. The `security` flag marks crossings
// where a tier-3 (unmanaged) state would be a security tear, not merely untidy.
const TRANSITION_MAPS = {
  // The capability split — the ONE place trust is RAISED. Two named constructors
  // over a trust-agnostic ctxFields; no trust parameter exists at any call site.
  ownerDataCtx: {
    from: "served-untrusted", to: "owner-trusted", security: true,
    anchoredBy: "query", // governed by the `context-capability totality` guard at `query`
    translates: "raises trust to kernel-full — the sole trusted:true capability; structurally the only door up",
  },
  servedDataCtx: {
    from: "owner-trusted", to: "served-untrusted", security: true,
    anchoredBy: "query",
    translates: "lowers to trusted:false — an untrusted ctx may neither read nor write a kernel pattern",
  },
  // The kernel read+write capability gate (the `trusted` flag, enforced in query/mutate).
  query: {
    from: "served-untrusted", to: "storage", security: true,
    translates: "refuses a kernel-pattern READ from an untrusted ctx (the symmetric read half of the trust flag)",
  },
  // Agent write → storage: the mutation chokepoint and the write-class registry.
  applyKernelRules: {
    from: "agent-mcp", to: "storage", security: true,
    translates: "applies ON_CREATE/ON_WRITE/IMMUTABLE kernel hooks before the row lands — forged/immutable fields refused",
  },
  writeClass: {
    from: "agent-mcp", to: "storage", security: true,
    translates: "resolves a pattern's write-class (User/System/Internal) — a System/Internal pattern is not agent-writable",
  },
  // Storage → public-egress: the redaction dual of the write registry.
  SENSITIVE_COLUMNS: {
    from: "storage", to: "public-egress", security: true,
    translates: "declares secret/redact columns — born-hashed at mint and stripped by seal on every outward emission",
  },
  sealAll: {
    from: "storage", to: "public-egress", security: true,
    anchoredBy: "SENSITIVE_COLUMNS", // the egress-sensitivity oracle is filed at the registry symbol
    translates: "strips SENSITIVE_COLUMNS from rows before they leave the DO (every served emission routes through it)",
  },
  // Served content → public-egress: inert, never active script on the first-party origin.
  inertHeaders: {
    from: "served-untrusted", to: "public-egress", security: true,
    translates: "stamps Content-Security-Policy: sandbox so agent-authored egress can't execute as first-party script",
  },
  // Public request → served read: the bearer-scope auth gate.
  denyUnlessBearerScope: {
    from: "public-egress", to: "served-untrusted", security: true,
    translates: "refuses an unlisted served read unless the request carries a bearer token whose scope matches",
  },
  // Agent → credential mint: the token-scope grammar gate.
  isBroadTokenScope: {
    from: "agent-mcp", to: "owner-trusted", security: true,
    translates: "recognizes broad token scopes so minting one is consent-gated — an agent can't silently mint '*' standing access",
  },
  // The consent dual of egress: a born-hashed-bearer-minting create must be gated.
  // Oracle DERIVES the rule from SENSITIVE_COLUMNS × KERNEL_WRITE_POLICY.
  findUngatedCredentialMints: {
    from: "agent-mcp", to: "owner-trusted", security: true,
    translates: "proves every secret-minting pattern's create is consent-gated — a misclassified patch_only minter fails the build",
  },
  // Hive → federated: the SSRF block-host gate.
  isBlockedFederationHost: {
    from: "owner-trusted", to: "federated", security: true,
    translates: "blocks loopback/private/link-local/metadata hosts outright — they can't be allow-listed or token-leaked-to",
  },
  // Storage: secrets are born hashed — the preimage never lands in a column.
  mintSecrets: {
    from: "agent-mcp", to: "storage", security: true,
    anchoredBy: "SENSITIVE_COLUMNS", // born-hashed-secret totality is filed at the registry symbol
    translates: "generates secret columns as a digest BEFORE insert — a read yields a hash, never a usable bearer",
  },
  // Request → host: instance identity is configuration, not request data.
  currentHost: {
    from: "public-egress", to: "owner-trusted", security: true,
    anchoredBy: "resolveHost", // the instance-identity host resolution guard is filed at the pure resolveHost
    translates: "returns WORKER_HOST and IGNORES the inbound Host — a spoofed Host can't poison an owner capability URL",
  },
  // Agent SQL identifier → storage: defense-in-depth identifier quoting.
  quoteIdent: {
    from: "agent-mcp", to: "storage", security: true,
    translates: "quotes a SQL identifier (pattern/column) before interpolation — beneath the kernel-column allow-lists",
  },
};

// NON_TRANSITION — spec boundary chokepoints that are NOT chart crossings, so they
// legitimately have no TRANSITION_MAPS entry and must not count as atlas drift. These
// are STRUCTURAL totality boundaries (a registry is complete / two declarations
// partition exactly / an SSOT reconciles) that hold WITHIN a chart, not across one.
// Each carries its reason — the triage is codified, not a one-time call.
const NON_TRANSITION = {
  PATTERN_EFFECTS: "registry-completeness within storage (post-mutate effects), not a trust crossing",
  FACET_RESERVED_COLUMNS: "facet/kernel-column partition at propose_change — a naming-collision totality, not a trust crossing",
  findStoredDerivedAggregates: "data-is-destiny no-hybrid schema property — a doctrine ratchet over the schema, not a trust crossing",
  TOOLS: "tool-registry SSOT reconciliation (Session) — a declaration-totality, not a trust crossing",
};

// KNOWN-PENDING — symbols expected to exist soon but possibly not yet in source.
// A pending symbol that is MISSING is reported but does NOT fail --check, so two
// parallel changes (this atlas + the agent adding the symbol) compose cleanly.
// Remove an entry once its symbol lands (it then becomes a hard dangling check).
const KNOWN_PENDING = new Set([
  // quoteIdent — a parallel change is enshrining identifier quoting; tolerate absence
  // until it lands so the two branches don't race. (Present today → this is a no-op.)
  "quoteIdent",
]);

// ─── plumbing ─────────────────────────────────────────────────────────────────
function walk(dir, pred, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, acc);
    else if (pred(name)) acc.push(p);
  }
  return acc;
}
const read = (p) => readFileSync(p, "utf8");

const srcFiles = SRC_DIRS
  .flatMap((d) => walk(join(ROOT, d), (n) => n.endsWith(".ts") && !n.endsWith(".d.ts")))
  .filter((p) => !p.includes(join("src", "__tests__")));
const specFiles = walk(ROOT, (n) => n.endsWith(".spec.md"));

const srcText = srcFiles.map(read).join("\n");
function symbolExists(sym) {
  // A genuine occurrence as an identifier anywhere in non-test source.
  return new RegExp(`\\b${sym}\\b`).test(srcText);
}

// ─── 3. DERIVE tier from the live boundary claims ─────────────────────────────
// boundary "<name>" at <symbol> via (test|guard) "<oracle>"
const BOUNDARY = /boundary\s+"([^"]+)"\s+at\s+([A-Za-z_]\w*)\s+via\s+(test|guard)\s+"([^"]+)"/g;
const claims = new Map(); // symbol -> { name, kind, oracle, spec }
for (const s of specFiles) {
  const rel = s.replace(ROOT + "/", "");
  for (const m of read(s).matchAll(BOUNDARY)) {
    claims.set(m[2], { name: m[1], kind: m[3], oracle: m[4], spec: rel });
  }
}

function tierOf(sym, anchoredBy) {
  // Anchored either by the crossing's own symbol or the governing boundary it cites.
  const c = claims.get(sym) || (anchoredBy && claims.get(anchoredBy));
  if (!c) return { tier: 3, label: "convention", note: "no boundary claim" };
  const via = anchoredBy && !claims.get(sym) ? ` (via ${anchoredBy})` : "";
  // `via guard` = a structural/enshrined gate (the capability/grammar lives in code);
  // `via test`  = a totality oracle proves N sites agree.
  if (c.kind === "guard") return { tier: 1, label: "enshrined", note: c.oracle + via };
  return { tier: 2, label: "totality-checked", note: c.oracle + via };
}

// ─── assemble the atlas rows ──────────────────────────────────────────────────
const edges = Object.entries(TRANSITION_MAPS).map(([sym, def]) => {
  const t = tierOf(sym, def.anchoredBy);
  const pending = KNOWN_PENDING.has(sym);
  const present = symbolExists(sym);
  return { sym, ...def, ...t, present, pending };
});

// ─── 4 + 5. FLAGS ─────────────────────────────────────────────────────────────
// (a) DRIFT: a spec boundary chokepoint with no TRANSITION_MAPS entry — UNLESS it is
// a declared NON_TRANSITION (a structural boundary that holds within a chart).
// A boundary chokepoint is accounted-for if it IS a transition, a declared
// within-chart non-transition, OR the `anchoredBy` symbol a transition cites (its
// oracle is filed at that symbol even though the crossing is labelled by another —
// e.g. currentHost's guard lives at the pure resolveHost).
const anchoredBySyms = new Set(
  Object.values(TRANSITION_MAPS).map((d) => d.anchoredBy).filter(Boolean),
);
const drift = [...claims.keys()].filter(
  (sym) => !(sym in TRANSITION_MAPS) && !(sym in NON_TRANSITION) && !anchoredBySyms.has(sym),
);
// (b) DANGLING: a mapped symbol that no longer exists in source (pending excused).
const dangling = edges.filter((e) => !e.present && !e.pending);
const pendingMissing = edges.filter((e) => !e.present && e.pending);

// ─── RENDER ───────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
function renderConsole() {
  const out = [];
  out.push("\n  SECURITY ATLAS — the trust-graded manifold, made explicit\n");

  out.push("  CHARTS (trust domains):");
  for (const [name, desc] of Object.entries(CHARTS))
    out.push(`    ${pad(name, 18)} ${desc}`);

  out.push("\n  TRANSITION MAPS (chokepoints crossing charts), by tier:");
  for (const tier of [1, 2, 3]) {
    const group = edges.filter((e) => e.tier === tier).sort((a, b) => a.sym.localeCompare(b.sym));
    if (!group.length) continue;
    const label = tier === 1 ? "ENSHRINED (structural, one crossing)"
      : tier === 2 ? "TOTALITY-CHECKED (N sites, oracle proves agreement)"
      : "CONVENTION (N unmanaged sites — latent tear if security)";
    out.push(`\n  ── tier-${tier} · ${label} ──`);
    for (const e of group) {
      const arrow = `${e.from} → ${e.to}`;
      const flags = (e.security ? "" : " [non-security]") + (!e.present ? (e.pending ? " [PENDING]" : " [DANGLING]") : "");
      out.push(`    ${pad(arrow, 38)} [tier-${e.tier}] ${pad(e.sym, 24)}${flags}`);
      out.push(`      ${pad("", 38)} translates: ${e.translates}`);
    }
  }

  out.push("\n  ── flags ──");
  if (drift.length) {
    out.push(`  ✗ ATLAS DRIFT — ${drift.length} spec boundary chokepoint(s) with NO TRANSITION_MAPS entry:`);
    for (const sym of drift) {
      const c = claims.get(sym);
      out.push(`      ${pad(sym, 28)} (boundary "${c.name}", ${c.spec})`);
    }
  } else out.push("  ✓ no drift — every spec boundary chokepoint is mapped (or declared a within-chart non-transition).");
  if (Object.keys(NON_TRANSITION).length) {
    out.push(`  · ${Object.keys(NON_TRANSITION).length} spec boundary chokepoint(s) deliberately OUT of the atlas (within-chart structural totalities):`);
    for (const [sym, why] of Object.entries(NON_TRANSITION)) out.push(`      ${pad(sym, 28)} ${why}`);
  }

  if (dangling.length) {
    out.push(`  ✗ DANGLING — ${dangling.length} mapped symbol(s) no longer in source:`);
    for (const e of dangling) out.push(`      ${e.sym}`);
  } else out.push("  ✓ no dangling edges — every mapped symbol exists in source.");

  if (pendingMissing.length)
    out.push(`  ⋯ pending — ${pendingMissing.map((e) => e.sym).join(", ")} not yet in source (KNOWN_PENDING, does not fail --check).`);

  // Tier summary + the headline: tier-3 security crossings.
  const counts = [1, 2, 3].map((t) => edges.filter((e) => e.tier === t).length);
  out.push(`\n  Tiers: ${counts[0]} enshrined · ${counts[1]} totality-checked · ${counts[2]} convention  (${edges.length} crossings total)`);
  const tier3sec = edges.filter((e) => e.tier === 3 && e.security);
  if (tier3sec.length) {
    out.push(`\n  ◀ HEADLINE — ${tier3sec.length} tier-3 SECURITY crossing(s) (unmanaged — a latent tear in the manifold):`);
    for (const e of tier3sec)
      out.push(`      ${pad(e.sym, 24)} ${e.from} → ${e.to} — ${e.translates}`);
    out.push("    Each is a security boundary enforced by convention, not by a chokepoint+oracle. Enshrine or add a totality oracle.");
  } else {
    out.push("\n  ✓ no tier-3 security crossings — every security transition is enshrined or totality-checked.");
  }
  return out.join("\n") + "\n";
}

// ─── doc artifact ─────────────────────────────────────────────────────────────
function renderDoc() {
  const L = [];
  L.push("# Security Atlas");
  L.push("");
  L.push("> Generated by `npm run atlas` (`scripts/atlas.mjs`). Do not edit by hand —");
  L.push("> the tiers are derived from the `## works when` boundary claims in the `*.spec.md` tree.");
  L.push("");
  L.push("The security architecture is a **trust-graded manifold**. Modules are CHARTS");
  L.push("(local trust domains); chokepoints are TRANSITION MAPS that cross between them,");
  L.push("translating coordinates and re-establishing the destination chart's invariant.");
  L.push("Trust is directional — most crossings preserve-or-lower it; only an enshrined");
  L.push("chokepoint may raise it.");
  L.push("");
  L.push("## Charts (trust domains)");
  L.push("");
  L.push("| chart | description |");
  L.push("| --- | --- |");
  for (const [name, desc] of Object.entries(CHARTS)) L.push(`| \`${name}\` | ${desc} |`);
  L.push("");
  L.push("## Transition maps (chokepoints), by tier");
  L.push("");
  L.push("Tiers: **tier-1** enshrined (structural, one crossing) · **tier-2** totality-checked");
  L.push("(N sites, an oracle proves they agree) · **tier-3** convention (N unmanaged sites — a");
  L.push("latent tear if it's a security crossing).");
  L.push("");
  L.push("| tier | from → to | chokepoint | oracle | re-establishes |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const tier of [1, 2, 3])
    for (const e of edges.filter((x) => x.tier === tier).sort((a, b) => a.sym.localeCompare(b.sym))) {
      const mark = e.present ? "" : (e.pending ? " _(pending)_" : " _(DANGLING)_");
      L.push(`| tier-${e.tier} | \`${e.from}\` → \`${e.to}\` | \`${e.sym}\`${mark} | ${e.note} | ${e.translates} |`);
    }
  L.push("");
  const counts = [1, 2, 3].map((t) => edges.filter((e) => e.tier === t).length);
  L.push(`**Tiers:** ${counts[0]} enshrined · ${counts[1]} totality-checked · ${counts[2]} convention (${edges.length} crossings).`);
  L.push("");
  const tier3sec = edges.filter((e) => e.tier === 3 && e.security);
  if (tier3sec.length) {
    L.push("### Headline — tier-3 security crossings (unmanaged)");
    L.push("");
    L.push("Security boundaries enforced by convention, not a chokepoint + totality oracle. Each is a latent tear:");
    L.push("");
    for (const e of tier3sec) L.push(`- \`${e.sym}\` (\`${e.from}\` → \`${e.to}\`) — ${e.translates}`);
  } else {
    L.push("### Headline");
    L.push("");
    L.push("No tier-3 security crossings — every security transition is enshrined or totality-checked.");
  }
  L.push("");
  return L.join("\n");
}

// ─── modes ────────────────────────────────────────────────────────────────────
const mode = process.argv[2];

console.log(renderConsole());

// A plain render and --emit-doc both refresh the doc (the manifold stays legible).
mkdirSync(dirname(DOC_OUT), { recursive: true });
writeFileSync(DOC_OUT, renderDoc());
if (mode === "--emit-doc") console.log(`  wrote ${DOC_OUT.replace(ROOT + "/", "")}\n`);

if (mode === "--check") {
  const fail = drift.length > 0 || dangling.length > 0;
  if (fail) {
    console.error("  ✗ atlas --check FAILED — the atlas is out of sync with the boundary claims.");
    if (drift.length) console.error("    drift: " + drift.join(", "));
    if (dangling.length) console.error("    dangling: " + dangling.map((e) => e.sym).join(", "));
    process.exit(1);
  }
  console.log("  ✓ atlas --check held — every boundary chokepoint is mapped, no dangling edges.\n");
}
