// Pure DOM renderer for the MCP Apps fragment. Dispatches on the
// structuredContent `kind`. Imported by render-client.ts (the live ext-apps
// bridge) AND render-preview.ts (local mock-data preview) — it has no MCP/
// ext-apps dependency, so the visual iterates in a plain browser with HMR.
//
// New rich views = a new `kind` branch here. Add a sample in render-preview.ts
// and you can design it locally before touching the server/tool.

export type Column = { label: string; align?: "left" | "right" };
export type TableView = {
  kind: "table";
  title?: string;
  columns: Column[];
  rows: (string | number)[][];
  emptyText?: string;
};

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderTable(root: HTMLElement, v: TableView): void {
  const frag = document.createDocumentFragment();
  if (v.title) frag.appendChild(el("div", "title", v.title));
  if (!v.rows || v.rows.length === 0) {
    frag.appendChild(el("div", "msg", v.emptyText || "Nothing to show."));
    root.replaceChildren(frag);
    return;
  }
  const table = el("table");
  const thead = el("thead");
  const htr = el("tr");
  v.columns.forEach((c) => htr.appendChild(el("th", c.align === "right" ? "r" : undefined, c.label)));
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el("tbody");
  v.rows.forEach((row) => {
    const tr = el("tr");
    row.forEach((cell, i) =>
      tr.appendChild(el("td", v.columns[i]?.align === "right" ? "r" : undefined, String(cell)))
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  frag.appendChild(table);
  root.replaceChildren(frag);
}

export function render(root: HTMLElement, data: any): void {
  if (!data || typeof data !== "object") return;
  if (data.kind === "table") {
    renderTable(root, data as TableView);
    return;
  }
  // Unknown kind — show the raw payload so new views are at least legible.
  root.replaceChildren(el("pre", "msg", JSON.stringify(data, null, 2)));
}
