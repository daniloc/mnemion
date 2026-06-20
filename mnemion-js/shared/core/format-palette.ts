// The format palette — the single declarative home for how a facet's VALUE is
// rendered (its presentation), distinct from the view palette (which governs
// layout) and from config roles (which govern a facet's job in a layout).
//
// A facet's effective format is resolved from three sources, most specific first:
//   1. the view's per-facet override   (config.formats[facet] — desk choice)
//   2. the facet's intrinsic format    (_fields.format — the data's nature)
//   3. a default derived from its type  (datetime → date, etc.)
//
// Like view-palette.ts: pure data, ZERO imports, bundled into BOTH the worker
// (schema enum + validation) and the SPA (a Record<FormatId,…> renderer registry
// whose compile-time totality binds the two).

export interface FormatType {
  label: string;
  /** Agent-facing: what this format does / when to use it. */
  help: string;
}

// Add a format here and the enum, the agent contract, and validation pick it up;
// the SPA won't compile until it has a matching renderer (Record<FormatId,…>).
export const FORMAT_PALETTE = {
  text: { label: "Text", help: "Plain text (the default for text facets)." },
  link: { label: "Link", help: "Render the value as a clickable link (href = the value)." },
  tags: { label: "Tags", help: "Split a comma-separated value into chips." },
  date: { label: "Date", help: "Render a timestamp as a friendly relative date." },
  boolean: { label: "Boolean", help: "Render a truthy/falsy value as ✓ / ✗." },
  select: { label: "Select", help: "An interactive dropdown that changes the value inline (options: the facet's declared options, else the values already in use)." },
  number: { label: "Number", help: "Format with thousands separators; right-aligned and sorted numerically (not lexically) in tables. The default for integer/number facets." },
  reference: { label: "Reference", help: "A navigable link to another entry — shows that entry's label, click to open it. Auto-applied to facets that declare a foreign key (links)." },
} satisfies Record<string, FormatType>;

export type FormatId = keyof typeof FORMAT_PALETTE;

export const FORMAT_IDS = Object.keys(FORMAT_PALETTE) as FormatId[];

export function isFormat(s: string): s is FormatId {
  return Object.prototype.hasOwnProperty.call(FORMAT_PALETTE, s);
}

// The default rendering for a facet that carries no explicit format — derived
// from its declared type, so a datetime is friendly and a boolean is a check
// without anyone having to say so. Truth (the type) drives presentation.
export function defaultFormatForType(type: string | undefined): FormatId {
  switch (type) {
    case "datetime": return "date";
    case "boolean": return "boolean";
    case "integer":
    case "number": return "number";
    default: return "text";
  }
}

// The resolve chain: view override ?? facet intrinsic ?? foreign-key reference ??
// type default. A declared foreign key (hasLink) wins over the type default — an
// FK facet is a reference by nature — but an explicit format still overrides it.
// Unknown ids fall through (a stale format never crashes a render — it degrades
// to the next source), so the resolver always returns a real FormatId.
export function resolveFormat(
  viewFormat: string | null | undefined,
  facetFormat: string | null | undefined,
  facetType: string | undefined,
  hasLink?: boolean,
): FormatId {
  if (viewFormat && isFormat(viewFormat)) return viewFormat;
  if (facetFormat && isFormat(facetFormat)) return facetFormat;
  if (hasLink) return "reference";
  return defaultFormatForType(facetType);
}

// Validate a view's per-facet `formats` override map: an object of
// facet-name → format-id. `hasFacet` null = pattern unknown → skip the
// facet-existence check (format-id checks still run). Returns [] when valid.
export function validateFormatsMap(formats: unknown, hasFacet: ((name: string) => boolean) | null): string[] {
  if (typeof formats !== "object" || formats === null || Array.isArray(formats)) {
    return ["config.formats must be a JSON object mapping facet names to formats."];
  }
  const errors: string[] = [];
  for (const [facet, fmt] of Object.entries(formats as Record<string, unknown>)) {
    if (typeof fmt !== "string" || !isFormat(fmt)) {
      errors.push(`config.formats."${facet}" must be one of: ${FORMAT_IDS.join(", ")}.`);
      continue;
    }
    if (hasFacet && !hasFacet(facet)) {
      errors.push(`config.formats references facet "${facet}" which the pattern does not have.`);
    }
  }
  return errors;
}

// Agent-facing prose, generated from the palette so the contract can't drift
// from what's enforced. Embedded in the _views + set_facet_format docs.
export function describeFormatPalette(): string {
  const lines = FORMAT_IDS.map((id) => `- ${id}: ${FORMAT_PALETTE[id].help}`);
  return `Value formats (how a facet's value renders):\n${lines.join("\n")}`;
}
