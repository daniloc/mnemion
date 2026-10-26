/**
 * The Swift adapter: the language server protocol over stdio to
 * sourcekit-lsp, found through `xcrun --find sourcekit-lsp` (macOS) or on
 * the PATH (COHERENCE_SOURCEKIT_LSP names one explicitly).
 *
 * Names resolve through workspace/symbol, kept to the project's own files,
 * or the hinted file's document symbols (`seal in Sources/Store/Secrets.swift`).
 * References come from textDocument/references, which sourcekit-lsp answers
 * from the SwiftPM index it builds in the background (a package that has
 * never been built has none, and every chokepoint then reads not run with
 * the reason, never pass).
 *
 * Visibility is Swift's access control, read from the declaration's own
 * text: a private or fileprivate declaration is refused by the compiler from
 * any other file, so it is visibility-choked; internal, package, public and
 * open are reachable from other files and reference-choked, with Coherence's
 * check as the enforcer.
 *
 * The refutation stages an unsaved document beside the protected thing that
 * references it. sourcekit-lsp answers references from its index, and reports
 * an open document's sites only once the index knows the file; the adapter
 * reports honestly what the server saw, so a server that cannot see the
 * probe makes the check vacuous (not run), never a pass.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  JsonRpcClient,
  hintedFiles,
  isTestPath,
  keepProjectFiles,
  outsideOfFolder,
  parseName,
  rangeContains,
  spawnSync,
  walkBounds,
  walkedProjectFiles,
} from "@posthog/coherence/plugin";
import manifest from "./plugin.json" with { type: "json" };
import { declarationsIn } from "./swift-source.js";

const LADDER = manifest.ladder;
const INSTRUMENT = "sourcekit-lsp";
const OPEN_LIMIT = 2000;

/** Where sourcekit-lsp is, with every place looked. */
export function locateSourcekit(env = process.env) {
  const looked = [];
  const explicit = env["COHERENCE_SOURCEKIT_LSP"];
  if (explicit !== undefined && explicit !== "") {
    if (existsSync(explicit)) return { found: true, command: explicit, looked: [...looked, `COHERENCE_SOURCEKIT_LSP (${explicit})`] };
    looked.push(`COHERENCE_SOURCEKIT_LSP (${explicit}): no such file`);
  } else looked.push("COHERENCE_SOURCEKIT_LSP: unset");
  for (const dir of (env["PATH"] ?? "").split(delimiter).filter((d) => d !== "")) {
    const candidate = join(dir, "sourcekit-lsp");
    if (existsSync(candidate)) return { found: true, command: candidate, looked: [...looked, `sourcekit-lsp on PATH (${candidate})`] };
  }
  looked.push("sourcekit-lsp on PATH: none");
  const xcrun = spawnSync("xcrun", ["--find", "sourcekit-lsp"], { encoding: "utf8", timeout: 30_000 });
  const found = xcrun.status === 0 ? String(xcrun.stdout).trim() : "";
  if (found !== "" && existsSync(found)) return { found: true, command: found, looked: [...looked, `xcrun --find (${found})`] };
  looked.push(xcrun.status === 0 ? "xcrun --find: nothing" : "xcrun: not available (not macOS, or no Xcode)");
  return { found: false, looked };
}

function flatten(symbols, prefix = []) {
  const out = [];
  for (const symbol of symbols) {
    const path = [...prefix, symbol.name];
    out.push({ path, symbol });
    if (symbol.children !== undefined) out.push(...flatten(symbol.children, path));
  }
  return out;
}

/** One candidate: the only one, else the only one outside test folders, else the only one under the component. */
function choose(candidates, hint) {
  if (candidates.length === 1) return candidates[0];
  const nonTest = candidates.filter((c) => !isTestPath(c.file, hint.testFolders));
  if (nonTest.length === 1) return nonTest[0];
  const pool = nonTest.length > 0 ? nonTest : candidates;
  const prefix = hint.component === "." ? "" : hint.component + "/";
  const under = pool.filter((c) => c.file.startsWith(prefix));
  return under.length === 1 ? under[0] : undefined;
}

export class SwiftAdapter {
  language = "swift";
  ladder = LADDER;
  root;
  client;
  starting;
  opened = new Set();
  documents = new Map();
  versions = new Map();
  symbolCache = new Map();
  touched = new Set();
  probes = new Set();
  walked;

  constructor(root) {
    this.root = resolve(root);
  }

  serverPid() {
    return this.client?.pid;
  }

  ready() {
    this.starting ??= this.start();
    return this.starting;
  }

  async start() {
    const where = locateSourcekit();
    if (!where.found) return { ok: false, reason: `sourcekit-lsp was not found (looked: ${where.looked.join("; ")}); install Xcode or a Swift toolchain, or set COHERENCE_SOURCEKIT_LSP` };
    const client = JsonRpcClient.spawn(where.command, ["--bypass-workspace-trust"], this.root);
    this.client = client;
    // sourcekit-lsp indexes the package in the background and reports it as
    // work-done progress; references are answered from that index, so the
    // adapter watches the progress to know when the index has settled.
    this.indexing = new Map();
    client.onRequest = (method) => (method === "workspace/configuration" ? [null] : null);
    client.onNotification = (method, params) => {
      if (method !== "$/progress" || params == null || typeof params !== "object") return;
      const { token, value } = params;
      if (value == null || typeof value !== "object") return;
      if (value.kind === "begin") this.indexing.set(String(token), { title: String(value.title ?? ""), at: Date.now() });
      else if (value.kind === "end") this.indexing.delete(String(token));
      else if (value.kind === "report" && this.indexing.has(String(token))) this.indexing.get(String(token)).at = Date.now();
      this.lastProgress = Date.now();
    };
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "project" }],
        capabilities: {
          textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, diagnostic: { dynamicRegistration: false } },
          workspace: { symbol: {}, workspaceFolders: true },
          window: { workDoneProgress: true },
        },
      }, 60_000);
      client.notify("initialized", {});
      const seed = this.files()[0];
      if (seed !== undefined) this.open(seed);
      return { ok: true };
    } catch (error) {
      client.kill();
      this.client = undefined;
      return { ok: false, reason: `${INSTRUMENT} (${where.command}) failed to start or initialize: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async live() {
    const state = await this.ready();
    if (!state.ok) throw new Error(state.reason);
    if (this.client === undefined || !this.client.alive) {
      this.starting = undefined;
      this.opened.clear();
      this.versions.clear();
      this.documents.clear();
      const again = await this.ready();
      if (!again.ok) throw new Error(again.reason);
    }
    return this.client;
  }

  /** The project's Swift files, as the walk reads them. */
  files() {
    return (this.walked ??= walkedProjectFiles(walkBounds(this.root, [])).files.filter((f) => f.endsWith(".swift")));
  }

  uri(file) { return pathToFileURL(join(this.root, file)).href; }

  relative(uri) {
    const path = fileURLToPath(uri);
    for (const base of [this.root, realRoot(this.root)]) {
      const rel = relative(base, path).split(sep).join("/");
      if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    return relative(this.root, path).split(sep).join("/");
  }

  open(file, text, identity) {
    if (this.opened.has(file)) return;
    const content = text ?? readFileSync(join(this.root, file), "utf8");
    this.client.notify("textDocument/didOpen", { textDocument: { uri: this.uri(file), languageId: "swift", version: 1, text: content } });
    this.opened.add(file);
    this.versions.set(file, 1);
    this.documents.set(file, { identity: identity ?? fileIdentityOf(join(this.root, file)), hash: digest(content) });
  }

  change(file, text, identity) {
    const version = (this.versions.get(file) ?? 1) + 1;
    this.versions.set(file, version);
    this.client.notify("textDocument/didChange", { textDocument: { uri: this.uri(file), version }, contentChanges: [{ text }] });
    this.documents.set(file, { identity, hash: digest(text) });
  }

  closeDocument(file) {
    if (!this.opened.has(file)) return;
    this.client.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
    this.opened.delete(file);
    this.documents.delete(file);
  }

  async documentSymbols(file) {
    const cached = this.symbolCache.get(file);
    if (cached !== undefined) return cached;
    if (!this.probes.has(file) && !existsSync(join(this.root, file))) {
      this.symbolCache.set(file, []);
      return [];
    }
    const client = await this.live();
    if (!this.probes.has(file)) this.open(file);
    const result = await client.request("textDocument/documentSymbol", { textDocument: { uri: this.uri(file) } }, 60_000);
    const symbols = (result ?? []).map((s) => ("location" in s ? { name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range } : s));
    this.symbolCache.set(file, symbols);
    return symbols;
  }

  /** The server's top-level symbols of a file, for `plugin calibrate` and the server-agrees duty: a function's labels (`seal(_:)`) are not part of its name. */
  async topLevelSymbols(file) {
    return (await this.documentSymbols(file)).map((s) => ({ name: s.name.replace(/\(.*$/, ""), line: s.selectionRange.start.line + 1, kind: s.kind }));
  }

  /**
   * Wait for sourcekit-lsp's background index to settle, so references are
   * answered from an index that holds every file: indexing starts shortly
   * after the workspace loads and reports itself as work-done progress, so
   * the wait is for a moment when no progress has begun and none has been
   * reported for a short while, within a bound.
   */
  async settled(client, boundMs = 180_000) {
    const started = Date.now();
    const quiet = 1_500;
    for (;;) {
      const now = Date.now();
      const busy = this.indexing.size > 0;
      const recent = this.lastProgress !== undefined && now - this.lastProgress < quiet;
      const young = now - started < quiet * 2; // indexing may not have begun yet
      if (!busy && !recent && !young) return;
      if (now - started > boundMs || !client.alive) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async forget(files = []) {
    this.walked = undefined;
    if (this.client === undefined) { this.symbolCache.clear(); return; }
    const named = keepProjectFiles(this.root, files.filter((f) => f.endsWith(".swift")));
    const forced = new Set(files.filter((file) => named.has(file)));
    const refresh = new Set([...this.touched, ...forced, ...this.opened]);
    this.touched.clear();
    let last;
    const unchanged = new Set();
    for (const file of refresh) {
      const identity = fileIdentityOf(join(this.root, file));
      if (identity === undefined) { this.closeDocument(file); continue; }
      if (!forced.has(file) && this.documents.get(file)?.identity === identity) { unchanged.add(file); continue; }
      const text = readFileSync(join(this.root, file), "utf8");
      if (!forced.has(file) && this.documents.get(file)?.hash === digest(text)) {
        this.documents.set(file, { identity, hash: this.documents.get(file).hash });
        unchanged.add(file);
        continue;
      }
      last = file;
      if (this.opened.has(file)) this.change(file, text, identity); else this.open(file, text, identity);
    }
    for (const file of [...this.symbolCache.keys()]) if (!unchanged.has(file)) this.symbolCache.delete(file);
    if (last !== undefined) await this.documentSymbols(last);
  }

  async resolve(name, hint) {
    const parsed = parseName(name);
    if (parsed.form === "prose") return { ok: false, reason: `"${name}" is prose, not a symbol or a module; write the symbol, the symbol in its file (\`name in file.swift\`), or the module path` };
    if (parsed.form === "module") {
      const path = join(this.root, parsed.path);
      if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, reason: `module ${parsed.path} is not a file under the project` };
      if (!parsed.path.endsWith(".swift")) return { ok: false, reason: `module ${parsed.path} is not a Swift file` };
      if (!keepProjectFiles(this.root, [parsed.path]).has(parsed.path)) return { ok: false, reason: `module ${parsed.path} is not one of the project's files (ignored, or inside a nested checkout)` };
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const first = (await this.documentSymbols(parsed.path))[0];
      return {
        ok: true,
        definition: {
          name, kind: "module", file: parsed.path,
          range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: (lines[lines.length - 1] ?? "").length } },
          selection: first?.selectionRange.start ?? { line: 0, character: 0 },
        },
      };
    }
    const candidates = parsed.fileHint === undefined ? await this.searchWorkspace(parsed.name) : await this.searchFiles(parsed.name, parsed.fileHint);
    if (candidates.length === 0) {
      return { ok: false, reason: parsed.fileHint === undefined ? `${INSTRUMENT} knows no symbol named ${parsed.name} in the project` : `no symbol named ${parsed.name} in a Swift file ending with ${parsed.fileHint}` };
    }
    const chosen = choose(candidates, hint);
    if (chosen === undefined) {
      return { ok: false, reason: `${parsed.name} is declared in ${candidates.length} places; write \`${parsed.name} in <file>\``, candidates: candidates.map((c) => `${c.file}:${c.symbol.selectionRange.start.line + 1}`) };
    }
    return { ok: true, definition: { name, kind: "symbol", file: chosen.file, range: chosen.symbol.range, selection: chosen.symbol.selectionRange.start } };
  }

  async searchWorkspace(name) {
    const client = await this.live();
    let found = [];
    try { found = (await client.request("workspace/symbol", { query: name }, 60_000)) ?? []; } catch { found = []; }
    const files = new Set();
    for (const info of found) {
      if (info.name !== name && info.name !== `${name}()` && !info.name.startsWith(`${name}(`)) continue;
      const file = this.relative(info.location.uri);
      if (!file.startsWith("..") && file.endsWith(".swift")) files.add(file);
    }
    const own = keepProjectFiles(this.root, [...files]);
    const candidates = [];
    for (const file of [...files].filter((f) => own.has(f)).sort()) candidates.push(...(await this.declarationsIn(file, name)));
    if (candidates.length > 0) return candidates;
    // The index may not hold every file yet: the files whose text declares the name are asked for their document symbols.
    for (const file of this.files()) {
      let text;
      try { text = readFileSync(join(this.root, file), "utf8"); } catch { continue; }
      if (declarationsIn(text).some((d) => d.name === name)) candidates.push(...(await this.declarationsIn(file, name)));
    }
    return candidates;
  }

  async searchFiles(name, fileHint) {
    const candidates = [];
    for (const file of hintedFiles(this.files(), fileHint)) candidates.push(...(await this.declarationsIn(file, name)));
    return candidates;
  }

  /** Top-level declarations named `name` in a file; sourcekit-lsp names a function with its labels (`seal(_:)`), so the bare name matches those too. */
  async declarationsIn(file, name) {
    return (await this.documentSymbols(file)).filter((s) => s.name === name || s.name.startsWith(`${name}(`)).map((symbol) => ({ file, symbol }));
  }

  async references(definition) {
    const client = await this.live();
    this.open(definition.file);
    this.touched.add(definition.file);
    for (const file of this.files().slice(0, OPEN_LIMIT)) this.open(file);
    await this.settled(client);
    const starts = definition.kind === "module" ? (await this.documentSymbols(definition.file)).map((s) => s.selectionRange.start) : [definition.selection];
    const reported = [];
    for (const position of starts) {
      const locations = await client.request("textDocument/references", { textDocument: { uri: this.uri(definition.file) }, position, context: { includeDeclaration: false } }, 120_000);
      reported.push(...(locations ?? []));
    }
    const own = keepProjectFiles(this.root, reported.map((l) => this.relative(l.uri)));
    const seen = new Set();
    const sites = [];
    for (const location of reported) {
      const file = this.relative(location.uri);
      if (!own.has(file) && !this.probes.has(file)) continue;
      const start = location.range.start;
      if (file === definition.file && starts.some((s) => rangeContains({ start: s, end: s }, start))) continue;
      const key = `${file}:${start.line}:${start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!this.probes.has(file)) this.touched.add(file);
      const site = { file, line: start.line + 1, character: start.character, symbol: await this.enclosingSymbol(file, start) };
      if (/^\s*(?:@\w+\s+)*import\b/.test(this.lineOf(file, start.line))) site.form = "import";
      sites.push(site);
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
    return sites;
  }

  lineOf(file, line) {
    try { return readFileSync(join(this.root, file), "utf8").split(/\r?\n/)[line] ?? ""; } catch { return ""; }
  }

  async enclosingSymbol(file, position) {
    let symbols;
    try { symbols = await this.documentSymbols(file); } catch { return undefined; }
    let best;
    for (const entry of flatten(symbols)) {
      if (!rangeContains(entry.symbol.range, position)) continue;
      if (best === undefined || entry.path.length > best.path.length) best = entry;
    }
    return best?.path.join(".");
  }

  /** Swift's access control, read from the declaration line (attributes on the lines above passed over). */
  async visibility(definition) {
    const text = this.lineOf(definition.file, definition.selection.line);
    const modifiers = text.slice(0, Math.max(0, text.indexOf(definition.name.replace(/\(.*$/, ""))));
    const hidden = /\b(?:private|fileprivate)\b(?!\(set\))/.test(modifiers);
    if (hidden) {
      return {
        enforced: true, visible: false,
        evidence: `${definition.file}:${definition.selection.line + 1} declares it ${/\bfileprivate\b/.test(modifiers) ? "fileprivate" : "private"}, which the compiler refuses from any other file`,
        rung: { ...LADDER.rungs[0] },
      };
    }
    const level = /\b(?:public|open|package)\b/.exec(modifiers)?.[0] ?? "internal";
    return {
      enforced: false, visible: true,
      evidence: `${definition.file}:${definition.selection.line + 1} declares it ${level}: reachable from ${level === "internal" ? "every file of its module" : "any module that imports it"}`,
      rung: { ...LADDER.rungs[1] },
    };
  }

  testFilter(via) { return via; }

  async stagedName(definition) {
    const symbols = await this.documentSymbols(definition.file);
    if (definition.kind === "module") return symbols[0]?.name.replace(/\(.*$/, "");
    const at = symbols.find((s) => s.selectionRange.start.line === definition.selection.line && s.selectionRange.start.character === definition.selection.character)?.name;
    if (at !== undefined) return at.replace(/\(.*$/, "");
    const parsed = parseName(definition.name);
    return parsed.form === "symbol" ? parsed.name : undefined;
  }

  /**
   * The refutation. sourcekit-lsp answers references from its index and never
   * from an unsaved document, so a staged use has to be a file on disk: the
   * project is copied to a throwaway folder outside it (its Swift files and
   * manifests, never .build), the probe is written there, a second server
   * indexes the copy, and what it reports is mapped back to the project's
   * paths. The project's own files are never touched. A copy costs an index
   * (seconds for a package), so at an edit the refutation is deferred to the
   * run, which then reads not run at the edit, never pass.
   */
  async refute(protectedThing, _outsideOf, exempt, occasion = "run") {
    const name = await this.stagedName(protectedThing);
    if (name === undefined) return { seen: false, staged: [], account: `${INSTRUMENT} reports no symbol at ${protectedThing.file}:${protectedThing.selection.line + 1}, so nothing could be staged` };
    const folder = exempt === undefined ? (dirname(protectedThing.file) === "." ? "" : `${dirname(protectedThing.file)}/`) : outsideOfFolder(exempt);
    if (folder === undefined) return { seen: false, staged: [], account: `the chokepoint exempts the project root, so there is no outside to stage a reference from` };
    if (occasion === "edit") return { seen: false, staged: [], account: `deferred to the run: ${INSTRUMENT} answers only from its index, and staging a use means indexing a copy of the project` };
    const probe = `${folder}CoherenceRefutation${randomBytes(4).toString("hex")}.swift`;
    const hidden = (await this.visibility(protectedThing)).enforced;
    const text = `import Foundation\n\nfunc coherenceRefutation() -> Any {\n    return ${name}\n}\n`;
    const what = `a use of ${name} in ${probe}, a file staged in a copy of the project${hidden ? ", which the compiler must refuse" : ""}`;
    const copy = mkdtempSync(join(tmpdir(), "coherence-swift-refute-"));
    const twin = new SwiftAdapter(copy);
    try {
      this.copyProject(copy);
      writeFileSync(join(copy, probe), text);
      const state = await twin.ready();
      if (!state.ok) return { seen: false, staged: [{ what }], account: state.reason };
      const resolved = await twin.resolve(`${name} in ${protectedThing.file}`, { component: ".", testFolders: [] });
      if (!resolved.ok) return { seen: false, staged: [{ what }], account: `in the copy, ${resolved.reason}` };
      if (hidden) {
        // The compiler's refusal is the refutation: pulled from the probe's diagnostics.
        const client = await twin.live();
        twin.open(probe);
        await twin.settled(client);
        let diagnostics = [];
        try {
          const report = await client.request("textDocument/diagnostic", { textDocument: { uri: twin.uri(probe) } }, 120_000);
          diagnostics = report?.items ?? [];
        } catch { diagnostics = []; }
        const refusal = diagnostics.find((d) => /inaccessible|private|fileprivate|cannot find/.test(String(d.message)));
        if (refusal === undefined) return { seen: false, staged: [{ what }], account: `${INSTRUMENT} gave no refusal for ${what} (${diagnostics.length} diagnostics); the compiler's enforcement was not shown` };
        return { seen: true, staged: [], refused: String(refusal.message), account: `the compiler refused ${what}: ${refusal.message}` };
      }
      const sites = await twin.references(resolved.definition);
      const hit = sites.find((s) => s.file === probe);
      if (hit === undefined) return { seen: false, staged: [{ what }], account: `${INSTRUMENT} did not report ${what} among ${sites.length} references in the copy; the check is vacuous` };
      return { seen: true, staged: [{ what, site: hit }], account: `${INSTRUMENT} reported ${what}, in a copy of the project it indexed` };
    } finally {
      await twin.close();
      rmSync(copy, { recursive: true, force: true });
    }
  }

  /** The project's Swift files and the manifests that place them, copied into `copy`; never .build or a nested checkout. */
  copyProject(copy) {
    const listing = walkedProjectFiles(walkBounds(this.root, [])).files;
    const wanted = listing.filter((f) => f.endsWith(".swift") || /(?:^|\/)(?:Package\.swift|Package\.resolved|project\.yml|Info\.plist)$/.test(f) || f.endsWith(".entitlements"));
    for (const file of wanted) {
      const target = join(copy, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(this.root, file), target);
    }
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    if (client === undefined) return;
    try {
      await client.request("shutdown", null, 3_000);
      client.notify("exit", null);
    } catch { /* going down either way */ }
    setTimeout(() => client.kill(), 500).unref();
  }
}

function digest(text) { return createHash("sha256").update(text).digest("hex"); }

function fileIdentityOf(path) {
  try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return undefined; }
}

/** The root as the server may report it: on macOS /var and /tmp are links into /private. */
function realRoot(root) {
  try { return realpathSync(root); } catch { return root; }
}
