// Live MCP Apps bridge for the ui://mnemion/render fragment.
//
// Built by vite.fragment.ts into a self-contained IIFE (.client.txt) and inlined
// into the resource HTML by session.ts. Uses the *with-deps* ext-apps build so it
// carries its own MCP SDK — independent of the worker's pinned SDK version.
//
// The actual rendering lives in render-view.ts (shared with the local preview so
// visuals can be iterated in a browser without a deploy). This file is only the
// thin host bridge: receive the tool result, hand its structuredContent to render.
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { render } from "./render-view";

const root = document.getElementById("root")!;

const app = new App({ name: "Mnemion", version: "0.5.0" });
// Must be set before connect() so the initial tool result isn't missed.
app.ontoolresult = (params: any) =>
  render(root, params?.structuredContent ?? params?.result?.structuredContent ?? params);
app.connect();
