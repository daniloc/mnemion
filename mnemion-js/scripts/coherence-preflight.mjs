// Preflight: catch a stale node_modules after a coherence-harness version bump.
//
// The dev tool is pinned as a git dep in package.json
// (e.g. "coherence-harness": "github:daniloc/coherence#v0.5.3"). A developer who
// pulls a version bump but forgets `npm install` ends up with an OLD coherence
// binary installed, which silently emits misleading "stale docs" / "no CLAUDE.md"
// errors from the coherence:docs / coherence:docs:check scripts. This guard
// compares the PINNED version against the INSTALLED version and fails loudly with
// the remedy. It degrades gracefully (exit 0) whenever it can't make a confident
// comparison — a fresh checkout before install, or an unexpected pin format —
// so it only ever blocks on a real mismatch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = join(here, "..", "package.json");
const installedPkgJsonPath = join(
  here,
  "..",
  "node_modules",
  "coherence-harness",
  "package.json",
);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const pkg = readJson(pkgJsonPath);
if (!pkg) {
  console.error("[coherence-preflight] could not read package.json; skipping.");
  process.exit(0);
}

const depString =
  pkg.devDependencies?.["coherence-harness"] ??
  pkg.dependencies?.["coherence-harness"];
if (!depString) {
  console.error(
    "[coherence-preflight] no coherence-harness dependency found; skipping.",
  );
  process.exit(0);
}

// Extract the pinned version from a git ref, e.g.
// "github:daniloc/coherence#v0.5.3" -> "0.5.3". Strip a leading "v".
const hashIndex = depString.indexOf("#");
const ref = hashIndex >= 0 ? depString.slice(hashIndex + 1) : "";
const pinMatch = ref.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
if (!pinMatch) {
  console.error(
    `[coherence-preflight] could not parse a pinned version from "${depString}"; skipping.`,
  );
  process.exit(0);
}
const pinned = pinMatch[1];

const installedPkg = readJson(installedPkgJsonPath);
if (!installedPkg?.version) {
  console.error(
    "[coherence-preflight] coherence-harness is not installed; skipping (run `cd mnemion-js && npm install`).",
  );
  process.exit(0);
}
const installed = String(installedPkg.version);

if (installed !== pinned) {
  console.error("");
  console.error(
    "  ✗ coherence-harness version mismatch — your node_modules is STALE.",
  );
  console.error("");
  console.error(`      pinned in package.json : ${pinned}`);
  console.error(`      installed in node_modules: ${installed}`);
  console.error("");
  console.error(
    "  The installed coherence binary is out of date with the pin, so its",
  );
  console.error(
    "  docs/freshness checks will report misleading errors. Reinstall:",
  );
  console.error("");
  console.error("      cd mnemion-js && npm install");
  console.error("");
  process.exit(1);
}

console.log(`[coherence-preflight] ok — coherence-harness ${installed}`);
process.exit(0);
