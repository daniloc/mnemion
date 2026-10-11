import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// @posthog/coherence 1.7.1's browser bundle calls languagesReadLine without
// including it. Scope loads its state, then fails while rendering Structure and
// stays on "Connecting to the warm server". Remove this patch when upstream
// includes the helper in the browser bundle.
const packageFile = fileURLToPath(new URL("../node_modules/@posthog/coherence/package.json", import.meta.url));
const browserFile = fileURLToPath(new URL("../node_modules/@posthog/coherence/dist/readings/scope/structure-flow.browser.js", import.meta.url));

let pkg;
try {
  pkg = JSON.parse(await readFile(packageFile, "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") process.exit(0); // production install omits dev dependencies
  throw error;
}

const source = await readFile(browserFile, "utf8");
if (source.includes("function languagesReadLine(")) process.exit(0);
if (pkg.version !== "1.7.1") {
  throw new Error(`Review the Scope patch for @posthog/coherence ${pkg.version}`);
}

const anchor = "export function unreadLanguagesText(model";
if (!source.includes(anchor) || !source.includes("const line = languagesReadLine(model.languages);")) {
  throw new Error("Coherence Scope browser source changed; review the patch");
}

const helper = `function languagesReadLine(languages) {
  if (languages === undefined) return undefined;
  if (languages.declared.length <= 1 && languages.unread.length === 0) return undefined;
  const read = languages.read.length === 0 ? "none" : languages.read.join(" and ");
  if (languages.unread.length === 0) return \`languages read: \${read}, each through its own files\`;
  return \`languages read: \${read}; NOT READ: \${languages.unread.map((u) => \`\${u.language} (\${u.because})\`).join("; ")}\`;
}

`;
await writeFile(browserFile, source.replace(anchor, helper + anchor));
console.log("Patched @posthog/coherence 1.7.1 Scope browser bundle");
