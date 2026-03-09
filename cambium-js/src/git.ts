// git.ts — Minimal git smart HTTP for read-only marketplace serving
//
// Synthesizes a virtual git repo from a file tree (path → content).
// Implements just enough of the git smart HTTP protocol for `git clone`.
// No actual git repo on disk. No push support. No delta compression.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

// === Types ===

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

interface GitObject {
  type: number;
  data: Uint8Array;
  sha: string;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

interface DirNode {
  files: Map<string, string>; // filename → blob sha
  dirs: Map<string, DirNode>;
}

export interface FileTree {
  [path: string]: string; // path → content
}

// === Git object creation ===

function gitHash(type: string, data: Uint8Array): string {
  const header = enc(`${type} ${data.length}\0`);
  return createHash("sha1")
    .update(header)
    .update(data)
    .digest("hex");
}

function createBlob(content: string): GitObject {
  const data = enc(content);
  return { type: OBJ_BLOB, data, sha: gitHash("blob", data) };
}

function createTree(entries: TreeEntry[]): GitObject {
  // Git requires sorted entries
  const sorted = [...entries].sort((a, b) => {
    // Git sorts trees with trailing / for comparison
    const aKey = a.mode.startsWith("40") ? a.name + "/" : a.name;
    const bKey = b.mode.startsWith("40") ? b.name + "/" : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    parts.push(enc(`${entry.mode} ${entry.name}\0`));
    parts.push(hexToBytes(entry.sha));
  }

  const data = concat(parts);
  return { type: OBJ_TREE, data, sha: gitHash("tree", data) };
}

function createCommit(treeSha: string, message: string): GitObject {
  // Fixed timestamp for deterministic SHAs (same content = same hash)
  const ts = "1700000000 +0000";
  const text = `tree ${treeSha}\nauthor Cambium <cambium@localhost> ${ts}\ncommitter Cambium <cambium@localhost> ${ts}\n\n${message}\n`;
  const data = enc(text);
  return { type: OBJ_COMMIT, data, sha: gitHash("commit", data) };
}

// === File tree → git objects ===

export function synthesizeRepo(files: FileTree): {
  objects: GitObject[];
  headSha: string;
} {
  const objects: GitObject[] = [];
  const blobShas = new Map<string, string>();

  // Create blobs
  for (const [path, content] of Object.entries(files)) {
    const blob = createBlob(content);
    objects.push(blob);
    blobShas.set(path, blob.sha);
  }

  // Build directory tree
  const root: DirNode = { files: new Map(), dirs: new Map() };

  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    const filename = parts.pop()!;
    let node = root;
    for (const dir of parts) {
      if (!node.dirs.has(dir)) {
        node.dirs.set(dir, { files: new Map(), dirs: new Map() });
      }
      node = node.dirs.get(dir)!;
    }
    node.files.set(filename, blobShas.get(path)!);
  }

  // Build tree objects bottom-up
  function buildTree(node: DirNode): string {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) {
      entries.push({ mode: "100644", name, sha });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: "40000", name, sha: buildTree(child) });
    }
    const tree = createTree(entries);
    objects.push(tree);
    return tree.sha;
  }

  const rootSha = buildTree(root);
  const commit = createCommit(rootSha, "Cambium marketplace");
  objects.push(commit);

  return { objects, headSha: commit.sha };
}

// === Packfile ===

function buildPackfile(objects: GitObject[]): Uint8Array {
  const parts: Uint8Array[] = [];

  // Header: PACK + version 2 + object count
  const header = new Uint8Array(12);
  header.set(enc("PACK"));
  u32be(header, 4, 2);
  u32be(header, 8, objects.length);
  parts.push(header);

  // Objects
  for (const obj of objects) {
    parts.push(encodeObjHeader(obj.type, obj.data.length));
    parts.push(new Uint8Array(deflateSync(obj.data)));
  }

  // SHA1 checksum of everything before it
  const body = concat(parts);
  const checksum = createHash("sha1").update(body).digest();
  return concat([body, new Uint8Array(checksum)]);
}

function encodeObjHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

// === Pkt-line encoding ===

function pktLine(data: string): string {
  const len = data.length + 4;
  return len.toString(16).padStart(4, "0") + data;
}

function pktLineBin(data: Uint8Array): Uint8Array {
  const len = data.length + 4;
  const prefix = enc(len.toString(16).padStart(4, "0"));
  return concat([prefix, data]);
}

function sideBandChunks(band: number, data: Uint8Array): Uint8Array[] {
  const MAX_CHUNK = 65515; // 65520 - 4 (length) - 1 (band)
  const chunks: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.length) {
    const slice = data.subarray(offset, offset + MAX_CHUNK);
    const len = slice.length + 5;
    const line = new Uint8Array(len);
    line.set(enc(len.toString(16).padStart(4, "0")));
    line[4] = band;
    line.set(slice, 5);
    chunks.push(line);
    offset += slice.length;
  }

  return chunks;
}

// === HTTP handlers ===

export function handleInfoRefs(headSha: string): Response {
  const caps = "side-band-64k shallow symref=HEAD:refs/heads/main";
  let body = "";
  body += pktLine("# service=git-upload-pack\n");
  body += "0000";
  body += pktLine(`${headSha} HEAD\0${caps}\n`);
  body += pktLine(`${headSha} refs/heads/main\n`);
  body += "0000";

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-git-upload-pack-advertisement",
      "Cache-Control": "no-cache",
    },
  });
}

export async function handleUploadPack(
  request: Request,
  objects: GitObject[],
  headSha: string
): Promise<Response> {
  const body = await request.text();
  const isShallow = body.includes("deepen");
  const isDone = body.includes("done");

  const parts: Uint8Array[] = [];

  // Shallow section (sent in both phases)
  if (isShallow) {
    parts.push(enc(pktLine(`shallow ${headSha}\n`)));
    parts.push(enc("0000"));
  }

  if (isDone) {
    // Phase 2: client sent "done" — send NAK + packfile
    parts.push(enc(pktLine("NAK\n")));
    parts.push(...sideBandChunks(1, buildPackfile(objects)));
    parts.push(enc("0000"));
  }
  // Phase 1 (no "done"): just the shallow section above, nothing else

  return new Response(concat(parts), {
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}

// === Marketplace file tree builder ===

export interface MarketplacePlugin {
  name: string;
  description: string;
  version: string;
  skills: MarketplaceSkill[];
  claude_md?: string;
  mcp_json?: string;
  settings_json?: string;
}

export interface MarketplaceSkill {
  name: string;
  description?: string;
  argument_hint?: string;
  skill_md: string;
}

export function buildMarketplaceFiles(
  plugins: MarketplacePlugin[],
  ownerName: string = "Cambium"
): FileTree {
  const files: FileTree = {};

  // .claude-plugin/marketplace.json
  files[".claude-plugin/marketplace.json"] = JSON.stringify(
    {
      name: "cambium-marketplace",
      owner: { name: ownerName },
      plugins: plugins.map((p) => ({
        name: p.name,
        source: `./plugins/${p.name}`,
        description: p.description,
        version: p.version,
      })),
    },
    null,
    2
  );

  for (const plugin of plugins) {
    const pfx = `plugins/${plugin.name}`;

    // .claude-plugin/plugin.json
    files[`${pfx}/.claude-plugin/plugin.json`] = JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
      },
      null,
      2
    );

    // Skills
    for (const skill of plugin.skills) {
      const fm = ["---", `name: ${skill.name}`];
      if (skill.description) fm.push(`description: ${skill.description}`);
      if (skill.argument_hint)
        fm.push(`argument-hint: "${skill.argument_hint}"`);
      fm.push("---", "");
      files[`${pfx}/skills/${skill.name}/SKILL.md`] =
        fm.join("\n") + skill.skill_md;
    }

    // Optional plugin-level files
    if (plugin.claude_md) files[`${pfx}/CLAUDE.md`] = plugin.claude_md;
    if (plugin.mcp_json) files[`${pfx}/.mcp.json`] = plugin.mcp_json;
    if (plugin.settings_json)
      files[`${pfx}/settings.json`] = plugin.settings_json;
  }

  return files;
}

// === Repo cache ===

let cachedContentHash: string | null = null;
let cachedRepo: { objects: GitObject[]; headSha: string } | null = null;
let cachedFiles: FileTree | null = null;

function getCachedRepo(files: FileTree): { objects: GitObject[]; headSha: string } {
  // Hash the file tree content to detect changes
  const contentHash = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");

  if (contentHash === cachedContentHash && cachedRepo) {
    return cachedRepo;
  }

  // Cache miss — recompute
  cachedRepo = synthesizeRepo(files);
  cachedContentHash = contentHash;
  cachedFiles = files;
  return cachedRepo;
}

// === Main entry point ===

export async function handleMarketplaceGit(
  request: Request,
  path: string,
  plugins: MarketplacePlugin[]
): Promise<Response> {
  const files = buildMarketplaceFiles(plugins);

  // Git smart HTTP endpoints
  if (request.method === "GET" && path.endsWith("/info/refs")) {
    const url = new URL(request.url);
    if (url.searchParams.get("service") !== "git-upload-pack") {
      return new Response("Unsupported service", { status: 403 });
    }
    const { headSha } = getCachedRepo(files);
    return handleInfoRefs(headSha);
  }

  if (request.method === "POST" && path.endsWith("/git-upload-pack")) {
    const { objects, headSha } = getCachedRepo(files);
    return handleUploadPack(request, objects, headSha);
  }

  // Plain HTTP file serving — Claude Code fetches files directly
  if (request.method === "GET") {
    // Normalize: strip leading slash, handle empty path
    let filePath = path.replace(/^\//, "");

    // Root request → serve marketplace.json
    if (filePath === "" || filePath === "/") {
      filePath = ".claude-plugin/marketplace.json";
    }

    const content = files[filePath];
    if (content !== undefined) {
      const ct = filePath.endsWith(".json") || filePath.endsWith(".mcp.json")
        ? "application/json"
        : "text/plain";
      return new Response(content, {
        headers: { "Content-Type": ct, "Cache-Control": "no-cache" },
      });
    }
  }

  return new Response("Not found", { status: 404 });
}

// === Utilities ===

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function concat(arrays: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const result = new Uint8Array(len);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function u32be(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}
