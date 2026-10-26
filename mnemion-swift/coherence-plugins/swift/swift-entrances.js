/**
 * Swift's entrance rules and the syntax they read by: the @main type the
 * system starts, an AppIntent or AppShortcutsProvider the system runs, the
 * principal class an extension's manifest names, and a main.swift
 * (entrance-candidates.ts reads them through the entrances slot).
 */

import { posix } from "node:path";
import { throughOf } from "@posthog/coherence/plugin";
import { codeOnly, declarationsIn, uncommented } from "./swift-source.js";

const INTENT_CONFORMANCE = /\b(AppIntent|AppShortcutsProvider|AppEntity|EntityQuery)\b/;

/** The line of a `main.swift`, which runs top-level code: its first line of code. */
function firstCodeLine(text) {
  const lines = codeOnly(text).split("\n");
  const at = lines.findIndex((l) => l.trim() !== "" && !/^\s*import\s/.test(l));
  return at === -1 ? 1 : at + 1;
}

function swiftCandidates(file, original, wrappers) {
  const out = [];
  const text = uncommented(original);
  const add = (c, span) => {
    const through = throughOf(span, text, wrappers, SWIFT_ENTRANCES);
    out.push(through === undefined ? c : { ...c, through });
  };
  const lines = original.split("\n");
  for (const d of declarationsIn(original)) {
    if (!/^(?:struct|class|actor|enum)$/.test(d.keyword)) continue;
    const declarationLine = lines[d.line - 1] ?? "";
    if (/(^|\s)@main\b/.test(d.attributes)) {
      add({ file, line: d.line, symbol: d.name, rule: "app", why: `${d.name} carries @main: the system starts it` }, declarationLine);
      continue;
    }
    if (INTENT_CONFORMANCE.test(declarationLine.slice(declarationLine.indexOf(":") + 1)) && declarationLine.includes(":")) {
      const kind = /\bAppShortcutsProvider\b/.test(declarationLine) ? "AppShortcutsProvider" : "AppIntent";
      add({ file, line: d.line, symbol: d.name, rule: "app intent", why: `${d.name} conforms to ${kind}: Siri, Shortcuts, Spotlight and the Action button run it` }, declarationLine);
    }
  }
  if (posix.basename(file) === "main.swift") {
    add({ file, line: firstCodeLine(original), symbol: "", rule: "main file", why: `${file} is a main.swift: its top-level code runs when its executable starts` }, "");
  }
  return out;
}

/** The principal class each extension manifest names: `NSExtensionPrincipalClass` in an Info.plist, or in a project.yml's `info.properties`. */
function principalClasses(read, files) {
  const named = [];
  for (const file of files) {
    const base = posix.basename(file);
    if (base !== "Info.plist" && base !== "project.yml") continue;
    const text = read(file);
    if (text === undefined) continue;
    const re = base === "Info.plist"
      ? /<key>NSExtensionPrincipalClass<\/key>\s*<string>([^<]+)<\/string>/g
      : /NSExtensionPrincipalClass:\s*["']?([^"'\s]+)/g;
    for (const m of text.matchAll(re)) {
      const value = m[1].trim();
      const name = value.slice(value.lastIndexOf(".") + 1).replace(/^\$\(PRODUCT_MODULE_NAME\)/, "");
      if (name !== "") named.push({ name, manifest: file });
    }
  }
  return named;
}

export const SWIFT_ENTRANCES = {
  isCode: (file) => file.endsWith(".swift") && !file.endsWith("Package.swift"),
  // A definition's attributes stand on the lines above it (`@main` above `struct App`): the definition is the first line that names a keyword.
  definitionAt(lines, start) {
    let at = start;
    while (at < lines.length - 1 && /^\s*@/.test(lines[at] ?? "") && !/\b(?:func|struct|class|actor|enum|protocol|let|var)\b/.test(lines[at] ?? "")) at += 1;
    return at;
  },
  continues: (text) => /^\s*[.)\]}]/.test(text) || /^\s*(?:&&|\|\||\?\?|:)/.test(text),
  // A bare name in a Swift file is bound module-wide: another file of the module may declare it, so one file's text cannot rule it out.
  binds: () => true,
  decorates: false,
  candidates: (file, text, wrappers) => swiftCandidates(file, text, wrappers),
  manifestCandidates(read, exists, files) {
    const out = [];
    const swiftFiles = files.filter((f) => f.endsWith(".swift"));
    for (const { name, manifest } of principalClasses(read, files)) {
      for (const file of swiftFiles) {
        const text = read(file);
        if (text === undefined) continue;
        const declared = declarationsIn(text).find((d) => d.name === name && (d.keyword === "class" || d.keyword === "struct"));
        if (declared === undefined) continue;
        out.push({ file, line: declared.line, symbol: name, rule: "extension principal class", why: `${manifest} names ${name} as NSExtensionPrincipalClass: the host app loads it`, registered: true });
      }
    }
    return out;
  },
  script: () => undefined,
  importedAmong: () => new Set(),
};
