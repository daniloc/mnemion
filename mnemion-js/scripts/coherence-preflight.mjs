// Preflight: catch a stale node_modules after a coherence version bump.
//
// The dev tool is pinned in package.json as "@danilocampos/coherence" (an exact
// npm version; historically a git tag pin like "github:daniloc/coherence#v0.5.3").
// A developer who pulls a version bump but forgets `npm install` ends up with an
// OLD coherence binary installed, which silently emits misleading "stale docs" /
// "no CLAUDE.md" errors from the coherence:docs / coherence:docs:check scripts.
// This guard compares the PINNED version against the INSTALLED version and fails
// loudly with the remedy. It degrades gracefully (exit 0) whenever it can't make
// a confident comparison — a fresh checkout before install, or an unexpected pin
// format — so it only ever blocks on a real mismatch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_NAME = "@danilocampos/coherence";

const here = dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = join(here, "..", "package.json");
const installedPkgJsonPath = join(
  here,
  "..",
  "node_modules",
  PKG_NAME,
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
  pkg.devDependencies?.[PKG_NAME] ?? pkg.dependencies?.[PKG_NAME];
if (!depString) {
  console.error(
    `[coherence-preflight] no ${PKG_NAME} dependency found; skipping.`,
  );
  process.exit(0);
}

// Extract the pinned version. Handles an exact npm pin ("0.35.0") and the old
// git ref form ("github:daniloc/coherence#v0.5.3"). Range pins (^/~) are not
// exact, so they skip rather than block.
const hashIndex = depString.indexOf("#");
const ref = hashIndex >= 0 ? depString.slice(hashIndex + 1) : depString;
const pinMatch = ref.match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
if (!pinMatch) {
  console.error(
    `[coherence-preflight] could not parse an exact pinned version from "${depString}"; skipping.`,
  );
  process.exit(0);
}
const pinned = pinMatch[1];

const installedPkg = readJson(installedPkgJsonPath);
if (!installedPkg?.version) {
  console.error(
    `[coherence-preflight] ${PKG_NAME} is not installed; skipping (run \`cd mnemion-js && npm install\`).`,
  );
  process.exit(0);
}
const installed = String(installedPkg.version);

if (installed !== pinned) {
  console.error("");
  console.error(
    `  ✗ ${PKG_NAME} version mismatch — your node_modules is STALE.`,
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

console.log(`[coherence-preflight] ok — ${PKG_NAME} ${installed}`);
process.exit(0);
