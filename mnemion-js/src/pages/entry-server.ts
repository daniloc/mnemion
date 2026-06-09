import { render } from 'svelte/server';
import SchemaViewer from './SchemaViewer.svelte';

export interface SchemaViewerProps {
  patterns: any[];
  charter: Record<string, string>;
  guidance: string;
}

// Escape a JSON string for safe embedding inside an HTML <script> element.
// JSON.stringify does NOT escape <, >, or &, so a free-text value containing
// "</script>" (or "<!--") would otherwise break out of the JSON block and
// inject markup. Pattern descriptions/doctrine/charter values are agent-written
// free text, so this is the boundary between that content and the owner's
// authenticated origin. The props are consumed via textContent + JSON.parse
// (not a JS string literal), so escaping the HTML-significant characters is
// sufficient; U+2028/U+2029 do not need handling in this context.
function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function renderSchemaViewer(props: SchemaViewerProps, clientScript: string): string {
  const { body, head } = render(SchemaViewer, { props });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hive — schema</title>
  ${head}
</head>
<body>
  <div id="app">${body}</div>
  <script id="__PROPS__" type="application/json">${escapeJsonForScript(JSON.stringify(props))}</script>
  <script type="module">${clientScript}</script>
</body>
</html>`;
}
