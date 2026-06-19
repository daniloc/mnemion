// The view palette — the single declarative home for the UI shapes an agent can
// author for a pattern. This is the SSOT the rest of the system derives from:
//   - schema.ts derives the _views `view_type` enum + the agent-facing contract
//     (describeViewPalette) from it
//   - kernel.ts validates every _views write against it (validateViewSpec),
//     fail-closed at the mutate chokepoint
//   - the web SPA dispatches to a component keyed by these same ids, and a
//     compile-time Record<ViewTypeId, …> totality check binds the two
//
// Pure data — bundled into BOTH the worker (server) and the React SPA (client).
// The only import is its sibling format-palette (also pure data, no env deps):
// every view may carry a universal `formats` override map, validated against it.

import { validateFormatsMap, describeFormatPalette } from "./format-palette";

export type ConfigRole = "facet" | "facets" | "values" | "text";
// facet  → value must name one facet of the target pattern
// facets → value must be an array of facet names
// values → value must be an array of arbitrary strings (e.g. board column order)
// text   → value must be a free string

export interface ConfigKey {
  role: ConfigRole;
  required?: boolean;
  help: string;
}

export interface ViewType {
  label: string;
  /** Agent-facing: when to reach for this view. */
  help: string;
  config: Record<string, ConfigKey>;
}

// The palette. Add a view type here and the enum, the agent contract, and the
// validator all pick it up; the client won't compile until it has a matching
// component (Record<ViewTypeId, …>). One table, derive the rest.
export const VIEW_PALETTE = {
  cards: {
    label: "Cards",
    help: "A responsive grid of cards. The default — good for browsable, visual collections.",
    config: {
      title: { role: "facet", help: "facet shown as each card's heading" },
      subtitle: { role: "facet", help: "facet shown under the title" },
      fields: { role: "facets", help: "facets to show as a short list on each card" },
    },
  },
  board: {
    label: "Board",
    help: "Kanban columns grouped by a facet. Good for status/stage workflows; cards drag between columns.",
    config: {
      group_by: { role: "facet", required: true, help: "facet whose distinct values become the columns" },
      title: { role: "facet", help: "facet shown as each card's heading" },
      columns: { role: "values", help: 'explicit column order, e.g. ["todo","doing","done"]' },
    },
  },
  table: {
    label: "Table",
    help: "Dense rows and columns. Good for scanning many entries across the same facets.",
    config: {
      columns: { role: "facets", help: "facets to show as columns, in order (default: all facets)" },
      title: { role: "facet", help: "facet for the first (label) column" },
      sort: { role: "facet", help: "facet to sort rows by" },
    },
  },
  list: {
    label: "List",
    help: "Compact one-line-per-entry rows. Good for long, lightweight reference lists.",
    config: {
      title: { role: "facet", help: "primary text on each row" },
      secondary: { role: "facet", help: "secondary text on each row" },
      meta: { role: "facet", help: "small trailing meta on each row" },
    },
  },
  document: {
    label: "Document",
    help: "Long-form reading: each entry as a document — a title heading, an optional lead paragraph, then its prose facets as headed sections with reading typography. For knowledge and essays, where entries are paragraphs, not records.",
    config: {
      title: { role: "facet", help: "facet rendered as the document heading" },
      lead: { role: "facet", help: "facet rendered as an intro paragraph (no heading) under the title" },
      sections: { role: "facets", help: "facets to render as headed sections, in order (default: all remaining text facets)" },
    },
  },
  chart: {
    label: "Chart",
    help: "A bar/line/area chart of an aggregate — group entries by a facet (x) and measure them (y). For datasets you want to SEE the shape of, not read. Pairs well with a table view of the same pattern.",
    config: {
      mark: { role: "text", help: "bar | line | area | scatter (default: bar). line/area for a value over a numeric/time x (spaced to scale); scatter plots x vs y per entry (no aggregation)." },
      x: { role: "facet", help: "facet for the x-axis / categories; bucket a datetime with facet:unit, e.g. created_at:month" },
      y: { role: "facet", help: "numeric facet for the y-axis (omit to count rows)" },
      group_by: { role: "facet", help: "alias for x" },
      metric: { role: "facet", help: "alias for y" },
      agg: { role: "text", help: "aggregate function: count | sum | avg | min | max (default: sum when y is set, else count)" },
      title: { role: "text", help: "chart title — free text that carries the argument" },
      caption: { role: "text", help: "caption below the chart" },
    },
  },
} satisfies Record<string, ViewType>;

export type ViewTypeId = keyof typeof VIEW_PALETTE;

export const VIEW_TYPES = Object.keys(VIEW_PALETTE) as ViewTypeId[];
export const DEFAULT_VIEW_TYPE: ViewTypeId = "cards";

export function isViewType(s: string): s is ViewTypeId {
  return Object.prototype.hasOwnProperty.call(VIEW_PALETTE, s);
}

// Agent-facing prose, generated from the palette so the contract can never drift
// from what the validator enforces. Embedded in the _views schema description.
export function describeViewPalette(): string {
  const lines = VIEW_TYPES.map((id) => {
    const v = VIEW_PALETTE[id];
    const keys = Object.entries(v.config)
      .map(([k, c]) => `${k}${c.required ? "*" : ""} (${c.help})`)
      .join(", ");
    return `- ${id}: ${v.help} config: ${keys || "(none)"}`;
  });
  return `Views (view_type → config; * = required). config is a JSON object mapping the pattern's facets to roles — never name a facet the pattern lacks.
${lines.join("\n")}

Any view may also carry "formats": { "<facet>": "<format>" } to override how a value renders (a facet's intrinsic format, set via set_facet_format, otherwise applies), and "hide": ["<facet>", ...] to suppress facets (composes with the default ordering — hiding one needn't re-list the rest). ${describeFormatPalette()}`;
}

export interface ValidateOpts {
  /** Enforce required config keys (true on create; false on partial update). */
  enforceRequired?: boolean;
}

// Validate a view spec against the palette and, when the target pattern's facets
// are known, against those facets. `hasFacet` null = pattern unknown (e.g. a
// partial update that doesn't carry the pattern) → facet-existence checks are
// skipped, structural checks still run. Returns [] when valid.
export function validateViewSpec(
  view_type: string | undefined,
  configRaw: string | null | undefined,
  hasFacet: ((name: string) => boolean) | null,
  opts: ValidateOpts = {},
): string[] {
  const errors: string[] = [];

  if (view_type !== undefined && !isViewType(view_type)) {
    errors.push(`view_type "${view_type}" is not a valid view. Choose one of: ${VIEW_TYPES.join(", ")}.`);
    return errors; // without a known type we can't check config keys
  }
  const vt: ViewType | null = view_type ? VIEW_PALETTE[view_type as ViewTypeId] : null;

  let obj: Record<string, unknown> | null = null;
  if (configRaw !== undefined && configRaw !== null && configRaw !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configRaw);
    } catch {
      errors.push("config must be valid JSON.");
      return errors;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push("config must be a JSON object.");
      return errors;
    }
    obj = parsed as Record<string, unknown>;
  }

  if (obj) {
    for (const [key, value] of Object.entries(obj)) {
      // `formats` is a universal override (every view): facet → value-format id.
      if (key === "formats") {
        errors.push(...validateFormatsMap(value, hasFacet));
        continue;
      }
      // `hide` is a universal exclude (every view): facets to suppress. Composes
      // with the default ordering, so "hide one" needn't re-list the rest.
      if (key === "hide") {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          errors.push("config.hide must be an array of facet names.");
        } else if (hasFacet) {
          for (const v of value as string[]) if (!hasFacet(v)) errors.push(`config.hide references facet "${v}" which the pattern does not have.`);
        }
        continue;
      }
      const ks = vt?.config[key];
      if (vt && !ks) {
        const valid = Object.keys(vt.config).join(", ") || "(none)";
        errors.push(`config key "${key}" is not used by the ${view_type} view. Valid keys: ${valid}.`);
        continue;
      }
      if (!ks) continue; // unknown view type → role unknown, skip
      if (ks.role === "facet") {
        if (typeof value !== "string") { errors.push(`config.${key} must be a facet name (string).`); continue; }
        if (hasFacet && !hasFacet(value)) errors.push(`config.${key} references facet "${value}" which the pattern does not have.`);
      } else if (ks.role === "facets") {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) { errors.push(`config.${key} must be an array of facet names.`); continue; }
        if (hasFacet) for (const v of value as string[]) if (!hasFacet(v)) errors.push(`config.${key} references facet "${v}" which the pattern does not have.`);
      } else if (ks.role === "values") {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) errors.push(`config.${key} must be an array of strings.`);
      } else if (ks.role === "text") {
        if (typeof value !== "string") errors.push(`config.${key} must be a string.`);
      }
    }
  }

  if (opts.enforceRequired && vt) {
    for (const [key, ks] of Object.entries(vt.config)) {
      if (ks.required && !(obj && key in obj)) {
        errors.push(`config.${key} is required for the ${view_type} view (${ks.help}).`);
      }
    }
  }

  return errors;
}
