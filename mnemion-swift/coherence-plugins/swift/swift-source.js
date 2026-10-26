/**
 * Swift's facts for the plain source scan: which names a file declares at
 * its top level, which modules it imports, and where an import leads
 * (source.ts reads them through the source slot).
 *
 * A module is a SwiftPM target or an XcodeGen target, a folder of files:
 * `import MnemionKit` leads to the target of that name, read off the nearest
 * Package.swift above the importing file (`.target(name:path:)`, default
 * Sources/<name>; `.testTarget`, default Tests/<name>) and the project.yml at
 * the root (`targets: <name>: sources: - path: <folder>`). A system or
 * dependency module (Foundation, SwiftUI, a package the manifest fetches)
 * resolves to nothing.
 *
 * Swift's files inside one module see each other with no import at all
 * (internal is module-wide), so every file reads as importing its own
 * module whole: the economy's closure of a change then reaches the module,
 * which is what the compiler reaches. The specifier for it is "." (self).
 *
 * This file is the plugin's one model of Swift text: what code is (comments,
 * nested block comments and string literals set apart, a multi-line string
 * included), what a top-level declaration is and which modifiers hide it
 * from other files, and what an import is. The other files read Swift
 * through it.
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

/** What one line declares when read alone at the top level, for the readings asked of a line. */
export function declarationAt(line) {
  const text = line.replace(/\r$/, "");
  if (/^\s/.test(text)) return undefined;
  return new SwiftReader().feed(text);
}

/** The reader the source slot feeds: declarationsOf hands it every line of one file in order. A file's first line (an import, a comment, a declaration at column zero after a blank) starts it afresh at depth zero. */
let STREAM = new SwiftReader();

/* ----------------------------------------------------------------- imports */

/** An import: `import Foo`, `@testable import Foo`, `import struct Foo.Bar`, `import Foo.Sub`. */
const IMPORT = /^\s*(?:@\w+(?:\([^)]*\)|)\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func|actor)\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_.]*))?/;

/** Every import of the text: the module (the first path element), the member path when one is named, and the line. */
export function importsIn(text) {
  const out = [];
  uncommented(text).split("\n").forEach((line, i) => {
    const m = IMPORT.exec(line);
    if (m !== null) out.push({ module: m[1], member: m[2], line: i + 1 });
  });
  return out;
}

/* ---------------------------------------------------------------- modules */

function textOf(path) {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function stamp(path) {
  try { return statSync(path).mtimeMs; } catch { return -1; }
}

/** The targets a Package.swift declares: name and folder (project-relative), by its `.target(name:)` / `.testTarget(name:)` / `.executableTarget(name:)` calls. */
export function packageTargets(text, packageFolder) {
  const targets = [];
  const code = uncommented(text);
  const re = /\.(target|testTarget|executableTarget|macro|plugin)\s*\(\s*name:\s*"([^"]+)"([^]*?)\)/g;
  for (const m of code.matchAll(re)) {
    const kind = m[1];
    const name = m[2];
    const args = m[3];
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
  return targets.map((t) => ({ name: t.name, folders: t.folders, test: /Tests$/.test(t.name) }));
}

const MANIFESTS = new Map();

/** Every module the project declares, from every Package.swift and project.yml under the root (the root's own first), with its folders; cached by the manifests' mtimes. */
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

/** The module a project file belongs to, or undefined outside every declared target. The deepest folder wins. */
export function moduleOfFile(root, file) {
  let best;
  for (const module of modulesOf(root)) {
    for (const folder of module.folders) {
      if (within(folder, file) && (best === undefined || folder.length > best.folder.length)) best = { module, folder };
    }
  }
  return best?.module;
}

/** The module named, with its files (vanished ones kept so importers are found), or undefined for a module the project does not declare. */
export function resolveTarget(root, name, vanished) {
  const module = modulesOf(root).find((m) => m.name === name);
  if (module === undefined) return undefined;
  const present = module.folders.flatMap((f) => swiftFilesUnder(root, f));
  const gone = [...vanished].filter((f) => isModuleFile(f) && module.folders.some((folder) => within(folder, f)) && !present.includes(f));
  return { module: module.folders[0] ?? name, files: [...new Set([...present, ...gone])].sort() };
}

/** The specifier a file's own module is imported by: its files see each other with no import written. */
export const SELF = ".";

export const SWIFT_SOURCE = {
  declarationOf(line) {
    // A line at column zero that is not a continuation restarts the stream's depth count when it is the
    // first of a file: declarationsOf feeds one file's lines in order, and files start with imports or comments.
    if (/^(?:import\s|\/\/|\/\*)/.test(line) && STREAM.depth !== 0) STREAM = new SwiftReader();
    const declared = STREAM.feed(line);
    if (declared === undefined) return undefined;
    return { name: declared.name, exported: declared.exported };
  },
  resolveModule(root, from, specifier, vanished) {
    if (specifier === SELF) {
      const own = moduleOfFile(root, from);
      return own === undefined ? undefined : resolveTarget(root, own.name, vanished);
    }
    return resolveTarget(root, specifier, vanished);
  },
  importsOf(text, add) {
    const seen = new Set();
    for (const spec of importsIn(text)) {
      if (seen.has(spec.module)) continue;
      seen.add(spec.module);
      add(undefined, spec.module);
    }
    // Every file of a module reaches every other: internal is module-wide.
    add(undefined, SELF);
  },
};
