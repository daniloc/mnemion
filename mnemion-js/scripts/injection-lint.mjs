#!/usr/bin/env node
// Injection-surface lint — the contract for the CHOKEPOINT-shaped injection guards
// (escapeXml, isValidColumn, escapeLike) that a totality oracle can't cover (there
// is no registry of HTML sinks or SQL identifiers to iterate).
//
// These guards are followed by CONVENTION today ("validate the identifier before
// you interpolate it"; "escapeXml every value in HTML") — and the current sites are
// correct. The risk is a FUTURE site that forgets. This lint surfaces every raw
// interpolation into a dangerous context, baselines the current (reviewed) set, and
// RATCHETS: a NEW raw interpolation fails `--check`, so it can't ship without being
// made safe or consciously baselined. It does not prove the baselined sites safe —
// it makes the surface visible and append-only-with-review.
//
// Two contexts:
//   SQL identifier  —  "${expr}"  (the SQLite double-quoted-identifier form): the
//     interpolated expr must be a validated identifier (facetMeta/isValidColumn/a
//     known constant) or wrapped in quoteIdent(). A raw unvalidated expr here is
//     SQL injection.
//   HTML/SVG value  —  ${expr} inside a template literal containing markup: the
//     expr must be escapeXml()'d (or a number/styling constant). A raw value here
//     is XSS.
//
// Usage:  node scripts/injection-lint.mjs            # report
//         node scripts/injection-lint.mjs --check    # ratchet (exit 1 on a new site)
//         node scripts/injection-lint.mjs --update-baseline
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIRS = ["entities", "shared", "src"];
const BASELINE = join(ROOT, "scripts", "injection-baseline.json");
const rel = (p) => p.replace(ROOT + "/", "");

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !p.includes("__tests__")) acc.push(p);
  }
  return acc;
}
const files = SRC_DIRS.flatMap((d) => walk(join(ROOT, d)));

// An interpolation expr is SAFE-by-construction if it routes through a recognized
// guard or is structurally inert.
const SAFE_SQL = /^(quoteIdent\(|[A-Z][A-Z0-9_]*$)/;            // quoteIdent() or an ALL_CAPS constant
const SAFE_HTML = /(^|[^.\w])(escapeXml|escapeAttr)\(|\.toFixed\(|^[A-Z][A-Z0-9_]*$|^-?\d/; // escaped, numeric, or a styling const
const INTERP = /\$\{([^{}]+)\}/g;       // non-nested ${...}
const HTML_TAG = /<\/?[a-zA-Z!]/;        // a markup tag on the line → HTML context

const findings = []; // { context, file, expr, line }
for (const f of files) {
  const txt = readFileSync(f, "utf8");
  const lines = txt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue; // comments

    // SQL identifier interpolation: "${expr}"
    for (const m of line.matchAll(/"\$\{([^{}]+)\}"/g)) {
      const expr = m[1].trim();
      if (SAFE_SQL.test(expr)) continue;
      findings.push({ context: "sql-ident", file: rel(f), expr, line: i + 1 });
    }

    // HTML/SVG value interpolation: ${expr} on a line that carries markup.
    if (HTML_TAG.test(line)) {
      for (const m of line.matchAll(INTERP)) {
        const expr = m[1].trim();
        // Skip the SQL-ident form already handled, and safe HTML exprs.
        if (line.includes(`"\${${m[1]}}"`)) continue;
        if (SAFE_HTML.test(expr)) continue;
        findings.push({ context: "html-value", file: rel(f), expr, line: i + 1 });
      }
    }
  }
}

// Key by context|file|expr so moving a line doesn't churn but a new expr/site does.
const keyOf = (x) => `${x.context}|${x.file}|${x.expr}`;
const current = new Map();
for (const x of findings) if (!current.has(keyOf(x))) current.set(keyOf(x), x);

const mode = process.argv[2];
if (mode === "--update-baseline") {
  const base = [...current.keys()].sort();
  writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n");
  console.log(`Pinned ${base.length} reviewed interpolation site(s) to ${rel(BASELINE)}`);
  process.exit(0);
}

const bySql = [...current.values()].filter((x) => x.context === "sql-ident");
const byHtml = [...current.values()].filter((x) => x.context === "html-value");
console.log("\n  INJECTION-SURFACE LINT — raw interpolation into SQL-identifier / HTML contexts\n");
console.log(`  SQL identifier interpolations ("\${expr}"):  ${bySql.length}`);
console.log(`  HTML value interpolations (\${expr} in markup): ${byHtml.length}`);
console.log(`  Total reviewed surface: ${current.size}`);
console.log(`  Each must be a validated identifier / escapeXml'd value. The ratchet (--check)`);
console.log(`  fails on a NEW site, so a forgotten escape/validation can't ship silently.\n`);

if (mode === "--check") {
  if (!existsSync(BASELINE)) { console.error("  --check: no baseline. Run --update-baseline first."); process.exit(2); }
  const base = new Set(JSON.parse(readFileSync(BASELINE, "utf8")));
  const novel = [...current.values()].filter((x) => !base.has(keyOf(x)));
  if (novel.length) {
    console.error(`  ✗ injection ratchet FAILED — ${novel.length} new raw interpolation site(s):`);
    for (const x of novel) console.error(`    - [${x.context}] ${x.file}:${x.line}  \${${x.expr}}`);
    console.error("\n  Make it safe (validated identifier / quoteIdent / escapeXml), or — if reviewed");
    console.error("  and safe — re-pin with --update-baseline.\n");
    process.exit(1);
  }
  console.log("  ✓ injection ratchet held — no new raw interpolation sites.\n");
}
