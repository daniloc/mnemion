// Client bundle for the ui://mnemion/render MCP Apps fragment.
//
// Built by vite.fragment.ts into a self-contained IIFE (.client.txt) and inlined
// into the resource HTML by session.ts. Imports the *with-deps* ext-apps build so
// it carries its own MCP SDK — independent of the worker's pinned SDK version.
//
// The single `render` tool returns structuredContent tagged with a `kind`; this
// generic renderer dispatches on it. New rich views = a new `kind` branch here +
// `render` learning to produce that data — no new tool, no new resource.
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

type Column = { label: string; align?: "left" | "right" };
type TableView = { kind: "table"; title?: string; columns: Column[]; rows: (string | number)[][]; emptyText?: string };

const root = document.getElementById("root")!;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderTable(v: TableView) {
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
    row.forEach((cell, i) => tr.appendChild(el("td", v.columns[i]?.align === "right" ? "r" : undefined, String(cell))));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  frag.appendChild(table);
  root.replaceChildren(frag);
}

function render(data: any) {
  if (!data || typeof data !== "object") return;
  if (data.kind === "table") {
    renderTable(data as TableView);
    return;
  }
  // Unknown kind — show the raw payload so new views are at least legible.
  root.replaceChildren(el("pre", "msg", JSON.stringify(data, null, 2)));
}

const app = new App({ name: "Mnemion", version: "0.1.0" });
// Must be set before connect() so the initial tool result isn't missed.
app.ontoolresult = (params: any) =>
  render(params?.structuredContent ?? params?.result?.structuredContent ?? params);
app.connect();
