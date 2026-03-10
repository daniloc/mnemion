import { render } from 'svelte/server';
import SchemaViewer from './SchemaViewer.svelte';

export interface SchemaViewerProps {
  patterns: any[];
  conventions: string[];
  guidance: string;
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
  <script id="__PROPS__" type="application/json">${JSON.stringify(props)}</script>
  <script type="module">${clientScript}</script>
</body>
</html>`;
}
