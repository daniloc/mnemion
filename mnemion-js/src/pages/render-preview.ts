// Local preview harness for the MCP Apps render fragment.
//
// Run with `npm run preview:render`, then design in the browser with HMR: edit
// render-view.ts / render-styles.ts and it reloads instantly. No deploy, no MCP,
// no Claude reconnect. This drives the SAME render() that ships in the fragment,
// with mock structuredContent payloads that mirror what the `render` tool emits.
import { render } from "./render-view";
import { FRAGMENT_CSS } from "./render-styles";

// Apply the real fragment styles so the preview matches production.
const style = document.createElement("style");
style.textContent = FRAGMENT_CSS;
document.head.appendChild(style);

const root = document.getElementById("root")!;

// Sample payloads — one per shape the `render` tool produces. Add a case here
// (and a `kind` branch in render-view.ts) to design a new view before wiring the
// server. Long prose mirrors the tool's ~100-char truncation.
const SAMPLES: Record<string, unknown> = {
  "patterns (overview)": {
    kind: "table",
    title: "Patterns",
    columns: [{ label: "Pattern" }, { label: "Entries", align: "right" }],
    rows: [
      ["axioms", 28], ["frame-primitives", 23], ["viral-tweets", 201],
      ["tasks", 29], ["_members", 2], ["future-vision", 2],
    ],
    emptyText: "No patterns yet.",
  },
  "entries (prose, wide)": {
    kind: "table",
    title: "future-vision (2)",
    columns: [
      { label: "id", align: "right" }, { label: "title" }, { label: "vision" },
      { label: "failure-mode" }, { label: "updated" },
    ],
    rows: [
      [2, "Escape velocity, not orbit", "In 2008 I was building toward independence — a self-taught developer creating his own career fro…", "Getting caught again. Someone offers a VP title or head-of-AI role at an interesting company. The…", "2026-03-13"],
      [1, "Escape velocity, not orbit", "By the time the PostHog vest completes (~mid 2028), the advisory practice is not a plan. It's a b…", "Getting caught. Getting absorbed. Someone offers a great role and the salary is good and the equi…", "2026-03-13"],
    ],
  },
  "entries (empty)": {
    kind: "table",
    title: "tasks (0)",
    columns: [{ label: "id", align: "right" }, { label: "task" }, { label: "status" }],
    rows: [],
    emptyText: "No entries in tasks.",
  },
  "unknown kind (fallback)": {
    kind: "timeline",
    note: "renderer doesn't know this kind yet — falls back to raw JSON",
    items: [{ at: "2026-06-16", what: "shipped render(view=entries)" }],
  },
};

const bar = document.getElementById("bar")!;
const buttons: HTMLButtonElement[] = [];
function show(name: string): void {
  render(root, SAMPLES[name]);
  buttons.forEach((b) => b.classList.toggle("active", b.textContent === name));
}
for (const name of Object.keys(SAMPLES)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => show(name);
  bar.appendChild(b);
  buttons.push(b);
}
show(Object.keys(SAMPLES)[0]);
