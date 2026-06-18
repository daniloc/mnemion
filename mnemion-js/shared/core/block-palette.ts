// The block palette — the declarative vocabulary for composing a page (a _pages
// entry). A page is { blocks: Block[] }; each block is { type, ...config, width? },
// validated against this palette (fail-closed) and rendered against a fixed
// component set in the SPA. The same safe boundary as the view/format palettes,
// one level up: arbitrary COMPOSITION (any blocks, any order, referencing any
// pattern/entry), never arbitrary CODE.
//
// Pure data, zero env-specific imports — bundled into both the worker (validation)
// and the SPA (rendering).

export type BlockRole = "text" | "pattern" | "facet" | "agg" | "id" | "viewtype" | "number";

export interface BlockConfigKey { role: BlockRole; required?: boolean; help: string; }
export interface BlockType { label: string; help: string; config: Record<string, BlockConfigKey>; }

export const BLOCK_PALETTE = {
  heading: { label: "Heading", help: "A section heading.", config: {
    text: { role: "text", required: true, help: "the heading text" },
  } },
  text: { label: "Text", help: "A prose paragraph.", config: {
    text: { role: "text", required: true, help: "the prose" },
  } },
  metric: { label: "Metric", help: "A single aggregate number from a pattern (e.g. total engagement).", config: {
    pattern: { role: "pattern", required: true, help: "pattern to aggregate" },
    metric: { role: "facet", help: "numeric facet to aggregate (omit to count rows)" },
    agg: { role: "agg", help: "count | sum | avg | min | max (default: sum when a metric is set, else count)" },
    label: { role: "text", help: "caption shown under the number" },
  } },
  chart: { label: "Chart", help: "A bar/line/area chart of an aggregate grouped by a facet.", config: {
    pattern: { role: "pattern", required: true, help: "pattern to chart" },
    mark: { role: "text", help: "bar | line | area (default: bar)" },
    x: { role: "facet", help: "facet for the x-axis (alias: group_by)" },
    y: { role: "facet", help: "numeric facet for the y-axis (alias: metric; omit to count rows)" },
    group_by: { role: "facet", help: "alias for x" },
    metric: { role: "facet", help: "alias for y" },
    agg: { role: "agg", help: "aggregate function (default: sum when y is set, else count)" },
    title: { role: "text", help: "chart title" },
    caption: { role: "text", help: "caption below the chart" },
  } },
  view: { label: "View", help: "Embed a pattern rendered as one of its views (board, table, document…). Extra keys (group_by, columns, sort…) pass through as the view's config.", config: {
    pattern: { role: "pattern", required: true, help: "pattern to embed" },
    view_type: { role: "viewtype", help: "board | table | list | cards | document | chart (default: cards)" },
  } },
  entry: { label: "Entry", help: "Embed one specific entry's facets.", config: {
    pattern: { role: "pattern", required: true, help: "the entry's pattern" },
    id: { role: "id", required: true, help: "the entry id" },
  } },
  list: { label: "List", help: "A filtered slice of a pattern's entries.", config: {
    pattern: { role: "pattern", required: true, help: "pattern to list" },
    filter: { role: "text", help: "a filter expression, e.g. status=todo" },
    limit: { role: "number", help: "max rows (default 10)" },
    view_type: { role: "viewtype", help: "how to render the slice (default: list)" },
  } },
} satisfies Record<string, BlockType>;

export type BlockTypeId = keyof typeof BLOCK_PALETTE;
export const BLOCK_TYPES = Object.keys(BLOCK_PALETTE) as BlockTypeId[];
export function isBlockType(s: string): s is BlockTypeId {
  return Object.prototype.hasOwnProperty.call(BLOCK_PALETTE, s);
}

const WIDTHS = new Set(["full", "half", "third"]);
const AGGS = new Set(["count", "sum", "avg", "min", "max"]);

export interface BlockValidationCtx {
  patternExists: (pattern: string) => boolean;
  hasFacet: (pattern: string, facet: string) => boolean;
}

// Validate a page's `blocks` JSON against the palette + the hive (pattern/facet
// references). Returns [] when valid. Empty/absent blocks = a valid (empty) page.
export function validateBlocks(blocksRaw: string | null | undefined, ctx: BlockValidationCtx): string[] {
  if (blocksRaw == null || blocksRaw === "") return [];
  let blocks: unknown;
  try { blocks = JSON.parse(blocksRaw); } catch { return ["blocks must be valid JSON."]; }
  if (!Array.isArray(blocks)) return ["blocks must be a JSON array."];

  const errors: string[] = [];
  blocks.forEach((b, i) => {
    const at = `block ${i + 1}`;
    if (typeof b !== "object" || b === null || Array.isArray(b)) { errors.push(`${at} must be an object.`); return; }
    const block = b as Record<string, unknown>;
    const type = block.type;
    if (typeof type !== "string" || !isBlockType(type)) {
      errors.push(`${at}: type "${String(type)}" is not a block type. Use: ${BLOCK_TYPES.join(", ")}.`);
      return;
    }
    if (block.width !== undefined && (typeof block.width !== "string" || !WIDTHS.has(block.width))) {
      errors.push(`${at}.width must be one of: full, half, third.`);
    }
    const bt: BlockType = BLOCK_PALETTE[type];
    const pattern = typeof block.pattern === "string" ? block.pattern : undefined;
    if (bt.config.pattern && pattern && !ctx.patternExists(pattern)) {
      errors.push(`${at} references pattern "${pattern}", which does not exist.`);
    }
    for (const [key, ks] of Object.entries(bt.config)) {
      const v = block[key];
      if (v === undefined || v === null || v === "") { if (ks.required) errors.push(`${at}.${key} is required (${ks.help}).`); continue; }
      switch (ks.role) {
        case "text":
        case "pattern":
        case "viewtype":
          if (typeof v !== "string") errors.push(`${at}.${key} must be a string.`);
          break;
        case "facet":
          if (typeof v !== "string") { errors.push(`${at}.${key} must be a facet name.`); break; }
          if (pattern && ctx.patternExists(pattern) && !ctx.hasFacet(pattern, v)) errors.push(`${at}.${key} references facet "${v}" not on "${pattern}".`);
          break;
        case "agg":
          if (typeof v !== "string" || !AGGS.has(v)) errors.push(`${at}.${key} must be one of: ${[...AGGS].join(", ")}.`);
          break;
        case "id":
        case "number":
          if (typeof v !== "number" && !(typeof v === "string" && /^\d+$/.test(v))) errors.push(`${at}.${key} must be a number.`);
          break;
      }
    }
  });
  return errors;
}

export function describeBlockPalette(): string {
  const lines = BLOCK_TYPES.map((id) => {
    const b = BLOCK_PALETTE[id];
    const keys = Object.entries(b.config).map(([k, c]) => `${k}${c.required ? "*" : ""} (${c.help})`).join(", ");
    return `- ${id}: ${b.help} config: ${keys || "(none)"}`;
  });
  return `A page (_pages entry) has blocks: an array of { type, ...config, width? } where width is full|half|third. Blocks (type → config; * = required):\n${lines.join("\n")}`;
}
