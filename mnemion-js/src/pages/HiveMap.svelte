<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from './env.js';

  interface Facet {
    name: string;
    type: string;
    required: boolean;
    default?: string | number | boolean | null;
    links?: string | null;
  }

  interface Pattern {
    name: string;
    description: string;
    facets: Facet[];
    entry_count: number;
    latest_activity?: string;
  }

  interface Props {
    patterns: Pattern[];
    onselect: (pattern: Pattern) => void;
  }

  let { patterns, onselect }: Props = $props();

  /* ── Force simulation types ── */

  interface Node {
    pattern: Pattern;
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    vibrancy: number;   // 0..1 — drives color saturation + glow
    phase: number;       // offset for breathing animation
    isKernel: boolean;
  }

  interface Link {
    source: Node;
    target: Node;
  }

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let animationId: number;
  let width = 0;
  let height = 0;
  let nodes: Node[] = [];
  let links: Link[] = [];
  let hoveredNode: Node | null = null;
  let dpr = 1;

  /* ── Sizing ── */

  function calcRadius(count: number): number {
    if (count === 0) return 18;
    return Math.max(22, Math.min(72, 18 + Math.sqrt(count) * 5));
  }

  function calcVibrancy(pattern: Pattern): number {
    if (!pattern.latest_activity) {
      // No timestamp — use entry count as rough proxy
      return pattern.entry_count > 0 ? 0.45 : 0.15;
    }
    const age = Date.now() - new Date(pattern.latest_activity).getTime();
    const hours = age / (1000 * 60 * 60);
    return Math.max(0.12, Math.min(1.0, 1.0 - (hours / 720) * 0.85));
  }

  /* ── Build graph ── */

  function buildGraph() {
    const cx = width / 2;
    const cy = height / 2;

    // Place nodes in a rough circle to start
    const userPatterns = patterns.filter(p => !p.name.startsWith('_'));
    const kernelPatterns = patterns.filter(p => p.name.startsWith('_'));
    const all = [...userPatterns, ...kernelPatterns];

    nodes = all.map((p, i) => {
      const angle = (i / all.length) * Math.PI * 2 + Math.random() * 0.3;
      const spread = Math.min(width, height) * 0.28;
      return {
        pattern: p,
        x: cx + Math.cos(angle) * spread * (0.6 + Math.random() * 0.4),
        y: cy + Math.sin(angle) * spread * (0.6 + Math.random() * 0.4),
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: calcRadius(p.entry_count),
        vibrancy: calcVibrancy(p),
        phase: Math.random() * Math.PI * 2,
        isKernel: p.name.startsWith('_'),
      };
    });

    // Build links from facet.links references
    const nodeMap = new Map(nodes.map(n => [n.pattern.name, n]));
    links = [];
    for (const node of nodes) {
      for (const facet of node.pattern.facets) {
        if (facet.links) {
          const target = nodeMap.get(facet.links);
          if (target && target !== node) {
            // Avoid duplicate links
            const exists = links.some(
              l => (l.source === node && l.target === target) ||
                   (l.source === target && l.target === node)
            );
            if (!exists) links.push({ source: node, target: target });
          }
        }
      }
    }
  }

  /* ── Physics ── */

  let time = 0;

  function tick() {
    time += 0.003;
    const cx = width / 2;
    const cy = height / 2;

    for (const node of nodes) {
      // Gentle drift — perlin-like via overlapping sinusoids
      const drift = 0.025;
      node.vx += Math.sin(time * 0.7 + node.phase * 3.1) * drift;
      node.vy += Math.cos(time * 0.6 + node.phase * 2.7) * drift;

      // Center gravity — soft pull toward center
      const dx = cx - node.x;
      const dy = cy - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const gravity = 0.0004;
      node.vx += dx * gravity;
      node.vy += dy * gravity;

      // Boundary repulsion — soft push from edges
      const margin = node.radius + 20;
      if (node.x < margin) node.vx += (margin - node.x) * 0.01;
      if (node.x > width - margin) node.vx -= (node.x - (width - margin)) * 0.01;
      if (node.y < margin) node.vy += (margin - node.y) * 0.01;
      if (node.y > height - margin) node.vy -= (node.y - (height - margin)) * 0.01;
    }

    // Node repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = a.radius + b.radius + 30;
        if (dist < minDist) {
          const force = (minDist - dist) * 0.008;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    // Link springs — gently pull linked nodes together
    for (const link of links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const idealDist = link.source.radius + link.target.radius + 80;
      const force = (dist - idealDist) * 0.0008;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      link.source.vx += fx;
      link.source.vy += fy;
      link.target.vx -= fx;
      link.target.vy -= fy;
    }

    // Apply velocity with damping
    for (const node of nodes) {
      node.vx *= 0.96;
      node.vy *= 0.96;
      // Clamp velocity
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > 0.5) {
        node.vx = (node.vx / speed) * 0.5;
        node.vy = (node.vy / speed) * 0.5;
      }
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  /* ── Rendering ── */

  function draw() {
    ctx.clearRect(0, 0, width * dpr, height * dpr);
    ctx.save();
    ctx.scale(dpr, dpr);

    const breath = Math.sin(time * 1.5) * 0.01 + 1;

    // Sort once for consistent draw order
    const sorted = [...nodes].sort((a, b) => {
      if (a.isKernel !== b.isKernel) return a.isKernel ? -1 : 1;
      return a.vibrancy - b.vibrancy;
    });

    // Layer 1: links (behind everything)
    for (const link of links) {
      const alpha = Math.min(link.source.vibrancy, link.target.vibrancy) * 0.25;
      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.strokeStyle = `rgba(232, 200, 114, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Layer 2: glows (behind solid fills, can overlap links)
    for (const node of sorted) {
      const r = node.radius * (breath + Math.sin(time * 2 + node.phase) * 0.005);
      const v = node.vibrancy;
      const glowR = r * 1.6;
      const glow = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
      if (node.isKernel) {
        glow.addColorStop(0, `rgba(140, 140, 160, ${v * 0.06})`);
        glow.addColorStop(1, 'rgba(140, 140, 160, 0)');
      } else {
        glow.addColorStop(0, `rgba(232, 200, 114, ${v * 0.08})`);
        glow.addColorStop(1, 'rgba(232, 200, 114, 0)');
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    // Layer 3: solid fills, edges, labels (fully opaque over links)
    for (const node of sorted) {
      const r = node.radius * (breath + Math.sin(time * 2 + node.phase) * 0.005);
      const isHovered = hoveredNode === node;
      const v = node.vibrancy;

      // Flat fill
      const alpha = isHovered ? v * 0.7 + 0.3 : v * 0.5 + 0.08;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = node.isKernel
        ? `rgba(140, 140, 160, ${alpha})`
        : `rgba(232, 200, 114, ${alpha})`;
      ctx.fill();

      // Edge
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = node.isKernel
        ? `rgba(140, 140, 160, ${v * 0.15 + (isHovered ? 0.15 : 0)})`
        : `rgba(232, 200, 114, ${v * 0.2 + (isHovered ? 0.15 : 0)})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Label
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelName = node.pattern.name.replace(/^_/, '');
      const labelAlpha = isHovered ? 1 : Math.max(0.35, v * 0.85);

      // Entry count — high contrast
      if (node.pattern.entry_count > 0 && r > 28) {
        ctx.font = `600 ${r > 40 ? 12 : 10}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = node.isKernel
          ? `rgba(220, 220, 230, ${labelAlpha})`
          : `rgba(255, 245, 220, ${labelAlpha})`;
        ctx.fillText(String(node.pattern.entry_count), node.x, node.y - 5);
      }

      // Name
      ctx.font = `600 ${r > 35 ? 11 : 9}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = node.isKernel
        ? `rgba(200, 200, 210, ${labelAlpha})`
        : `rgba(255, 245, 220, ${labelAlpha})`;
      ctx.fillText(labelName, node.x, node.y + (r > 28 ? 9 : 2));
    }

    ctx.restore();
  }

  /* ── Animation loop ── */

  function loop() {
    tick();
    draw();
    animationId = requestAnimationFrame(loop);
  }

  /* ── Interaction ── */

  function hitTest(e: MouseEvent): Node | null {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Check in reverse draw order (front nodes first)
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = mx - n.x;
      const dy = my - n.y;
      if (dx * dx + dy * dy < n.radius * n.radius) return n;
    }
    return null;
  }

  function handleMove(e: MouseEvent) {
    const hit = hitTest(e);
    hoveredNode = hit;
    canvas.style.cursor = hit ? 'pointer' : 'default';
  }

  function handleClick(e: MouseEvent) {
    const hit = hitTest(e);
    if (hit) onselect(hit.pattern);
  }

  /* ── Resize ── */

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    width = parent.clientWidth;
    height = parent.clientHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }

  /* ── Lifecycle ── */

  onMount(() => {
    if (!browser) return;
    ctx = canvas.getContext('2d')!;
    resize();
    buildGraph();
    loop();

    const ro = new ResizeObserver(() => {
      resize();
      // Re-clamp nodes to new bounds
      for (const n of nodes) {
        n.x = Math.max(n.radius, Math.min(width - n.radius, n.x));
        n.y = Math.max(n.radius, Math.min(height - n.radius, n.y));
      }
    });
    ro.observe(canvas.parentElement!);

    return () => {
      ro.disconnect();
      if (animationId) cancelAnimationFrame(animationId);
    };
  });

  onDestroy(() => {
    if (browser && animationId) cancelAnimationFrame(animationId);
  });
</script>

<div class="hive-map">
  <canvas
    bind:this={canvas}
    onmousemove={handleMove}
    onclick={handleClick}
    onmouseleave={() => { hoveredNode = null; }}
  ></canvas>
</div>

<style>
  .hive-map {
    width: 100%;
    height: 100%;
    position: relative;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
