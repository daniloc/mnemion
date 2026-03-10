import { hydrate } from 'svelte';
import SchemaViewer from './SchemaViewer.svelte';

const propsEl = document.getElementById('__PROPS__');
if (propsEl) {
  const props = JSON.parse(propsEl.textContent!);
  hydrate(SchemaViewer, { target: document.getElementById('app')!, props });
}
