import { hydrate } from 'svelte';
import Canvas from './Canvas.svelte';

const app = document.getElementById('app');
if (app) {
  hydrate(Canvas, { target: app, props: {} });
}
