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

export type CardField = { label: string; value: string };
export type Card = { header?: string; fields: CardField[]; meta?: string };
export type CardsView = {
  kind: "cards";
  title?: string;
  cards: Card[];
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

function renderCards(root: HTMLElement, v: CardsView): void {
  const frag = document.createDocumentFragment();
  if (v.title) frag.appendChild(el("div", "title", v.title));
  if (!v.cards || v.cards.length === 0) {
    frag.appendChild(el("div", "msg", v.emptyText || "Nothing to show."));
    root.replaceChildren(frag);
    return;
  }
  const wrap = el("div", "cards");
  v.cards.forEach((c) => {
    const card = el("div", "card");
    if (c.header) card.appendChild(el("div", "card-h", c.header));
    c.fields.forEach((f) => {
      if (f.value == null || f.value === "") return; // skip blank facets
      const row = el("div", "field");
      row.appendChild(el("span", "k", f.label));
      row.appendChild(el("span", "v", f.value));
      card.appendChild(row);
    });
    if (c.meta) card.appendChild(el("div", "card-m", c.meta));
    wrap.appendChild(card);
  });
  frag.appendChild(wrap);
  root.replaceChildren(frag);
}

export function render(root: HTMLElement, data: any): void {
  if (!data || typeof data !== "object") return;
  if (data.kind === "table") {
    renderTable(root, data as TableView);
    return;
  }
  if (data.kind === "cards") {
    renderCards(root, data as CardsView);
    return;
  }
  // Unknown kind — show the raw payload so new views are at least legible.
  root.replaceChildren(el("pre", "msg", JSON.stringify(data, null, 2)));
}
