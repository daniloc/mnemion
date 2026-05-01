import { render } from 'svelte/server';
import Canvas from './Canvas.svelte';

export function renderCanvasPage(clientScript: string): string {
  const { body, head } = render(Canvas, { props: {} });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hive — canvas</title>
  ${head}
</head>
<body>
  <div id="app">${body}</div>
  <script type="module">${clientScript}</script>
</body>
</html>`;
}
