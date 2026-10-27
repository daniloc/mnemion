/**
 * Swift's module layout, and the one regular-expression reading of Swift
 * text the plugin still keeps for the readings no parse answers.
 *
 * A module is a SwiftPM target or an XcodeGen target, a folder of files: read
 * off every Package.swift (`.target(name:path:)`, default Sources/<name>;
 * `.testTarget`, default Tests/<name>) and project.yml (`targets: <name>:
 * sources: - path: <folder>`) under the root. swift-resolve.js resolves an
 * import to one of them; swift.js opens one file of each so sourcekit-lsp
 * loads every workspace before it is asked.
 *
 * Declarations and imports are read through the parser (the manifest's
 * treeSitter and swift.scm). The reader below (SwiftReader, declarationsIn)
 * is a second, line-based reading kept for two readings outside the parse:
 * entrance detection (swift-entrances.js, which needs a declaration's
 * attributes and the lines around it) and the adapter's candidate search
 * (swift.js, which narrows the files it asks the server about). It can
 * disagree with the parser where the grammar fails; the parser's answer is
 * the one the readings count.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";

/* ------------------------------------------------------------------ code */

/**
 * One line with its comments blanked to spaces, every offset kept, and
 * `literals` set the contents of its string literals too; `state` carries a
 * block comment (nested, as Swift nests them) or a multi-line string across
 * lines.
 */
function blankLine(line, state, literals) {
  const out = line.split("");
  const blank = (from, to, keep) => {
    if (keep) return;
    for (let k = from; k < to; k++) out[k] = " ";
  };
  let i = 0;
  while (i < line.length) {
    if (state.block > 0) {
      if (line.startsWith("/*", i)) { state.block += 1; blank(i, i + 2, false); i += 2; continue; }
      if (line.startsWith("*/", i)) { state.block -= 1; blank(i, i + 2, false); i += 2; continue; }
      blank(i, i + 1, false);
      i += 1;
      continue;
    }
    if (state.multi) {
      const end = line.indexOf('"""', i);
      const stop = end < 0 ? line.length : end + 3;
      blank(i, stop, !literals);
      i = stop;
      if (end >= 0) state.multi = false;
      continue;
    }
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") { blank(i, line.length, false); break; }
    if (c === "/" && line[i + 1] === "*") { state.block = 1; blank(i, i + 2, false); i += 2; continue; }
    if (line.startsWith('"""', i)) { state.multi = true; blank(i, i + 3, !literals); i += 3; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, line.length);
      blank(i, stop, !literals);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function fresh() { return { block: 0, multi: false }; }

/** The text with its comments blanked, every offset kept; literals kept whole, so a plist key or an identifier in a string is still read. */
export function uncommented(text) {
  const state = fresh();
  return text.split("\n").map((line) => blankLine(line, state, false)).join("\n");
}

/** The text with its comments and the contents of its literals blanked: only code is left. */
export function codeOnly(text) {
  const state = fresh();
  return text.split("\n").map((line) => blankLine(line, state, true)).join("\n");
}

/* ----------------------------------------------------------- declarations */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
/** Attributes before a declaration: @main, @MainActor, @Observable, @available(...), @Test, @Suite(.serialized). */
const ATTRIBUTES = `(?:@${IDENT}(?:\\([^)]*\\))?\\s+)*`;
const MODIFIERS = "(?:(?:public|open|internal|package|private|fileprivate|final|static|indirect|dynamic|lazy|weak|unowned|nonisolated|override|convenience|required|mutating|nonmutating|prefix|postfix|infix)(?:\\([^)]*\\))?\\s+)*";
const KEYWORDS = "(?:func|struct|class|actor|enum|protocol|typealias|extension|let|var|macro|associatedtype|operator)";
const DECLARATION = new RegExp(`^${ATTRIBUTES}(${MODIFIERS})(${KEYWORDS})\\s+(?:(?:prefix|postfix|infix)\\s+)?(${IDENT}|[-+*/%<>=!&|^~?.]+)`);

/** Whether the modifiers hide the declaration from other files of its module. */
function hiddenFromOtherFiles(modifiers) {
  return /\b(?:private|fileprivate)\b/.test(modifiers);
}

/** A top-level declaration, read the one way every Swift reading reads one. */
function declarationFrom(code) {
  const m = DECLARATION.exec(code);
  if (m === null) return undefined;
  const [, modifiers, keyword, name] = m;
  if (keyword === "extension") return undefined; // reopens a type; declares no new top-level name
  let value = "";
  if (keyword === "let" || keyword === "var") value = (/=\s*(.*)$/.exec(code.slice(m[0].length))?.[1] ?? "").trim();
  return { name, keyword, exported: !hiddenFromOtherFiles(modifiers), value, attributes: m[0].slice(0, m[0].indexOf(modifiers + keyword)).trim() };
}

/** The net count of opening brackets over closing ones in a code-only line. */
function depthChange(code) {
  let depth = 0;
  for (const c of code) {
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
  }
  return depth;
}

/**
 * Reads a file's lines in order and says what each declares at the top
 * level: a declaration at bracket depth zero, its attributes on the same
 * line or the lines just above (`@main` above `struct App`). What a line
 * alone cannot say it carries: a block comment or multi-line string opened
 * above, and the bracket depth.
 */
export class SwiftReader {
  lexical = fresh();
  depth = 0;
  pendingAttributes = [];

  /** What the line declares, or undefined. */
  feed(raw) {
    const line = raw.replace(/\r$/, "");
    const inside = this.lexical.block > 0 || this.lexical.multi;
    const code = blankLine(line, this.lexical, true);
    if (inside) { this.depth += depthChange(code); return undefined; }
    const trimmed = code.trim();
    if (this.depth === 0 && /^@[A-Za-z_]/.test(trimmed) && !/\b(?:func|struct|class|actor|enum|protocol|typealias|extension|let|var)\b/.test(trimmed)) {
      this.pendingAttributes.push(trimmed);
      this.depth += depthChange(code);
      return undefined;
    }
    let declared;
    if (this.depth === 0 && /^[A-Za-z_@]/.test(code)) {
      declared = declarationFrom(trimmed);
      if (declared !== undefined && this.pendingAttributes.length > 0) declared.attributes = [...this.pendingAttributes, declared.attributes].filter(Boolean).join(" ");
    }
    this.pendingAttributes = [];
    this.depth += depthChange(code);
    if (this.depth < 0) this.depth = 0;
    return declared;
  }
}

/** Every top-level declaration of a file's text, with its one-based line. */
export function declarationsIn(text) {
  const reader = new SwiftReader();
  const found = [];
  text.split("\n").forEach((line, i) => {
    const declared = reader.feed(line);
    if (declared !== undefined) found.push({ ...declared, line: i + 1 });
  });
  return found;
}




/* ---------------------------------------------------------------- modules */

function textOf(path) {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function stamp(path) {
  try { return statSync(path).mtimeMs; } catch { return -1; }
}

/** The targets a Package.swift declares: name and folder (project-relative), by its `.target(name:)` / `.testTarget(name:)` / `.executableTarget(name:)` calls; the call's arguments are read to their balanced closing parenthesis, so a `dependencies: [.product(...)]` before `path:` hides nothing. */
export function packageTargets(text, packageFolder) {
  const targets = [];
  const code = uncommented(text);
  const re = /\.(target|testTarget|executableTarget|macro|plugin)\s*\(\s*name:\s*"([^"]+)"/g;
  for (const m of code.matchAll(re)) {
    const kind = m[1];
    const name = m[2];
    let depth = 1;
    let end = m.index + m[0].length;
    while (end < code.length && depth > 0) {
      const c = code[end];
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      end += 1;
    }
    const args = code.slice(m.index + m[0].length, end);
    const path = /\bpath:\s*"([^"]+)"/.exec(args)?.[1];
    const folder = path !== undefined ? posix.normalize(path) : `${kind === "testTarget" ? "Tests" : "Sources"}/${name}`;
    targets.push({ name, folder: posix.join(packageFolder, folder).replace(/^\.\//, "").replace(/^\.$/, ""), test: kind === "testTarget" });
  }
  return targets;
}

/** The targets an XcodeGen project.yml declares: name and its source folders. */
export function projectTargets(text, projectFolder) {
  const targets = [];
  const lines = text.split("\n");
  let inTargets = false;
  let current;
  let sourcesIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\S/.test(line)) { inTargets = /^targets:\s*$/.test(line); current = undefined; continue; }
    if (!inTargets) continue;
    const target = /^  ([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (target !== null) { current = { name: target[1], folders: [] }; targets.push(current); sourcesIndent = -1; continue; }
    if (current === undefined) continue;
    const sources = /^(\s+)sources:\s*$/.exec(line);
    if (sources !== null) { sourcesIndent = sources[1].length; continue; }
    if (sourcesIndent >= 0) {
      const item = /^(\s+)-\s*(?:path:\s*)?(\S+)\s*$/.exec(line);
      if (item !== null && item[1].length > sourcesIndent) { current.folders.push(posix.join(projectFolder, item[2]).replace(/^\.$/, "")); continue; }
      if (/^\s+-\s*$/.test(line)) continue;
      if (/^(\s+)path:\s*(\S+)/.test(line)) { const p = /^(\s+)path:\s*(\S+)/.exec(line); current.folders.push(posix.join(projectFolder, p[2]).replace(/^\.$/, "")); continue; }
      if (item === null && !/^\s{3,}/.test(line)) sourcesIndent = -1;
    }
  }
  // A path with an extension is a file (an Info.plist named under `info:`), not a folder of sources.
  return targets.map((t) => ({ name: t.name, folders: t.folders.filter((f) => !/\.[A-Za-z0-9]+$/.test(f)), test: /Tests$/.test(t.name) }));
}

const MANIFESTS = new Map();

/** Every module the project declares, from every Package.swift and project.yml under the root, each with its manifest and folders; cached by the manifests' mtimes. */
export function modulesOf(root) {
  const found = [];
  const walk = (folder, depth) => {
    let entries;
    try { entries = readdirSync(resolve(root, folder), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = folder === "" ? e.name : `${folder}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "DerivedData" || e.name.endsWith(".xcodeproj") || depth > 4) continue;
        walk(rel, depth + 1);
      } else if (e.name === "Package.swift" || e.name === "project.yml") found.push(rel);
    }
  };
  walk("", 0);
  const key = `${resolve(root)}\u0000${found.map((f) => `${f}@${stamp(resolve(root, f))}`).join("|")}`;
  const known = MANIFESTS.get(key);
  if (known !== undefined) return known;
  const modules = [];
  for (const manifest of found) {
    const text = textOf(resolve(root, manifest));
    if (text === undefined) continue;
    const folder = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    if (manifest.endsWith("Package.swift")) {
      for (const t of packageTargets(text, folder)) modules.push({ name: t.name, folders: [t.folder], test: t.test, manifest });
    } else {
      for (const t of projectTargets(text, folder)) modules.push({ name: t.name, folders: t.folders, test: t.test, manifest });
    }
  }
  MANIFESTS.clear();
  MANIFESTS.set(key, modules);
  return modules;
}

/** Whether a file is one of a module's own Swift files. */
export function isModuleFile(file) {
  return file.endsWith(".swift") && !file.endsWith("Package.swift");
}

/** A folder's Swift files, project-relative and sorted, recursively. */
export function swiftFilesUnder(root, folder) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(resolve(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!e.name.startsWith(".")) walk(child); } else if (isModuleFile(child)) out.push(child);
    }
  };
  walk(folder);
  return out.sort();
}

function within(folder, file) {
  return folder === "" || file === folder || file.startsWith(`${folder}/`);
}


/** The module named, with its files (vanished ones kept so importers are found), or undefined for a module the project does not declare. Of several targets of one name (two packages each with a `Core`), the one whose manifest lies nearest above the importing file wins; with none above it, the first declared. */
export function resolveTarget(root, name, vanished, from = "") {
  const named = modulesOf(root).filter((m) => m.name === name);
  if (named.length === 0) return undefined;
  const folderOf = (manifest) => (posix.dirname(manifest) === "." ? "" : posix.dirname(manifest));
  const above = named.filter((m) => within(folderOf(m.manifest), from)).sort((a, b) => folderOf(b.manifest).length - folderOf(a.manifest).length);
  const module = above[0] ?? named[0];
  const present = module.folders.flatMap((f) => swiftFilesUnder(root, f));
  const gone = [...vanished].filter((f) => isModuleFile(f) && module.folders.some((folder) => within(folder, f)) && !present.includes(f));
  return { module: module.folders[0] ?? name, files: [...new Set([...present, ...gone])].sort() };
}
