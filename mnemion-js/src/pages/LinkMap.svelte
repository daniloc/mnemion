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
  }

  interface Props {
    patterns: Pattern[];
    onselect: (patternName: string, entryId: string) => void;
  }

  let { patterns, onselect }: Props = $props();

  /* ── Types ── */

  interface Node {
    id: string;           // "pattern:entryId"
    patternName: string;
    entry: Record<string, unknown>;
    label: string;
    hue: number;          // per-pattern color
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    vibrancy: number;
    inbound: number;      // count of inbound references
    phase: number;
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
  let loading = $state(true);

  /* ── Per-pattern hue ── */

  const patternHues: Map<string, number> = new Map();
  function hueFor(name: string): number {
    if (patternHues.has(name)) return patternHues.get(name)!;
    // Deterministic hue from name hash
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    const hue = h % 360;
    patternHues.set(name, hue);
    return hue;
  }

  function hslColor(hue: number, sat: number, light: number, alpha: number): string {
    return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
  }

  /* ── Label resolution ── */

  function entryLabel(entry: Record<string, unknown>, facets: Facet[]): string {
    for (const key of ['name', 'title']) {
      if (entry[key] && typeof entry[key] === 'string') return entry[key] as string;
    }
    const firstText = facets.find(f => f.type === 'text');
    if (firstText && entry[firstText.name]) {
      const val = String(entry[firstText.name]);
      return val.length > 25 ? val.slice(0, 24) + '…' : val;
    }
    return `#${entry.id}`;
  }

  /* ── Vibrancy from recency ── */

  function calcVibrancy(entry: Record<string, unknown>): number {
    const ts = entry.updated_at as string | undefined;
    if (!ts) return 0.3;
    const age = Date.now() - new Date(ts).getTime();
    const hours = age / (1000 * 60 * 60);
    return Math.max(0.15, Math.min(1.0, 1.0 - (hours / 720) * 0.85));
  }

  /* ── Build graph ── */

  async function loadAndBuild() {
    loading = true;

    // Fetch all pattern entries in parallel
    const allEntries: Map<string, { entries: Record<string, unknown>[]; facets: Facet[] }> = new Map();
    await Promise.all(
      patterns.filter(p => p.entry_count > 0).map(async (p) => {
        try {
          const res = await fetch(`/api/query/${p.name}`);
          const data = await res.json();
          allEntries.set(p.name, { entries: data.entries || [], facets: p.facets });
        } catch { /* skip */ }
      })
    );

    // Build link-facet index: which patterns link to which, and via which facet
    // linkFacet.links = target pattern name, facet value = target entry id
    const linkDefs: { sourcePattern: string; facetName: string; targetPattern: string }[] = [];
    for (const p of patterns) {
      for (const f of p.facets) {
        if (f.links && allEntries.has(f.links)) {
          linkDefs.push({ sourcePattern: p.name, facetName: f.name, targetPattern: f.links });
        }
      }
    }

    // Count inbound references per target entry
    const inboundCount = new Map<string, number>(); // "pattern:id" → count
    const rawLinks: { sourceKey: string; targetKey: string }[] = [];

    for (const ld of linkDefs) {
      const sourceData = allEntries.get(ld.sourcePattern);
      if (!sourceData) continue;
      for (const entry of sourceData.entries) {
        const targetId = entry[ld.facetName];
        if (targetId == null) continue;
        const targetKey = `${ld.targetPattern}:${targetId}`;
        const sourceKey = `${ld.sourcePattern}:${entry.id}`;
        inboundCount.set(targetKey, (inboundCount.get(targetKey) || 0) + 1);
        rawLinks.push({ sourceKey, targetKey });
      }
    }

    // Only include entries that participate in links (have inbound refs or make outbound refs)
    const participantKeys = new Set<string>();
    for (const l of rawLinks) {
      participantKeys.add(l.sourceKey);
      participantKeys.add(l.targetKey);
    }

    // Build nodes
    const cx = width / 2;
    const cy = height / 2;
    const nodeMap = new Map<string, Node>();
    let idx = 0;
    const total = participantKeys.size;

    for (const [patternName, data] of allEntries) {
      const hue = hueFor(patternName);
      for (const entry of data.entries) {
        const key = `${patternName}:${entry.id}`;
        if (!participantKeys.has(key)) continue;
        const inbound = inboundCount.get(key) || 0;
        const angle = (idx / total) * Math.PI * 2 + Math.random() * 0.3;
        const spread = Math.min(width, height) * 0.3;
        nodeMap.set(key, {
          id: key,
          patternName,
          entry,
          label: entryLabel(entry, data.facets),
          hue,
          x: cx + Math.cos(angle) * spread * (0.5 + Math.random() * 0.5),
          y: cy + Math.sin(angle) * spread * (0.5 + Math.random() * 0.5),
          vx: (Math.random() - 0.5) * 0.1,
          vy: (Math.random() - 0.5) * 0.1,
          radius: Math.max(22, Math.min(65, 20 + inbound * 12)),
          vibrancy: calcVibrancy(entry),
          inbound,
          phase: Math.random() * Math.PI * 2,
        });
        idx++;
      }
    }

    nodes = Array.from(nodeMap.values());

    // Build links
    links = [];
    for (const rl of rawLinks) {
      const s = nodeMap.get(rl.sourceKey);
      const t = nodeMap.get(rl.targetKey);
      if (s && t) links.push({ source: s, target: t });
    }

    loading = false;
    if (nodes.length > 0) loop();
  }

  /* ── Physics ── */

  let time = 0;

  function tick() {
    time += 0.003;
    const cx = width / 2;
    const cy = height / 2;

    for (const node of nodes) {
      const drift = 0.02;
      node.vx += Math.sin(time * 0.7 + node.phase * 3.1) * drift;
      node.vy += Math.cos(time * 0.6 + node.phase * 2.7) * drift;

      node.vx += (cx - node.x) * 0.0003;
      node.vy += (cy - node.y) * 0.0003;

      const margin = node.radius + 20;
      if (node.x < margin) node.vx += (margin - node.x) * 0.01;
      if (node.x > width - margin) node.vx -= (node.x - (width - margin)) * 0.01;
      if (node.y < margin) node.vy += (margin - node.y) * 0.01;
      if (node.y > height - margin) node.vy -= (node.y - (height - margin)) * 0.01;
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = a.radius + b.radius + 25;
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

    for (const link of links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const idealDist = link.source.radius + link.target.radius + 70;
      const force = (dist - idealDist) * 0.001;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      link.source.vx += fx;
      link.source.vy += fy;
      link.target.vx -= fx;
      link.target.vy -= fy;
    }

    for (const node of nodes) {
      node.vx *= 0.96;
      node.vy *= 0.96;
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
    const sorted = [...nodes].sort((a, b) => a.inbound - b.inbound);

    // Layer 1: links
    for (const link of links) {
      const alpha = Math.min(link.source.vibrancy, link.target.vibrancy) * 0.2;
      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.strokeStyle = `rgba(200, 200, 210, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Layer 2: glows
    for (const node of sorted) {
      const r = node.radius * (breath + Math.sin(time * 2 + node.phase) * 0.005);
      const v = node.vibrancy;
      const glowR = r * 1.5;
      const glow = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
      glow.addColorStop(0, hslColor(node.hue, 50, 60, v * 0.07));
      glow.addColorStop(1, hslColor(node.hue, 50, 60, 0));
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    // Layer 3: fills, edges, labels
    for (const node of sorted) {
      const r = node.radius * (breath + Math.sin(time * 2 + node.phase) * 0.005);
      const isHovered = hoveredNode === node;
      const v = node.vibrancy;

      const alpha = isHovered ? v * 0.7 + 0.3 : v * 0.5 + 0.08;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hslColor(node.hue, 45, 55, alpha);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = hslColor(node.hue, 45, 55, v * 0.2 + (isHovered ? 0.15 : 0));
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelAlpha = isHovered ? 1 : Math.max(0.35, v * 0.85);

      // Inbound count (if > 0)
      if (node.inbound > 0 && r > 26) {
        ctx.font = `600 ${r > 40 ? 12 : 10}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = hslColor(node.hue, 20, 90, labelAlpha);
        ctx.fillText(String(node.inbound), node.x, node.y - 8);
      }

      // Label — expands in place on hover with backing
      const fontSize = r > 40 ? 10 : r > 30 ? 9 : 7;
      ctx.font = `600 ${fontSize}px 'JetBrains Mono', monospace`;
      const maxChars = Math.floor(r / 3.5);
      const expanded = isHovered && node.label.length > maxChars;
      const displayLabel = !isHovered && node.label.length > maxChars
        ? node.label.slice(0, maxChars - 1) + '…'
        : node.label;
      const labelY = node.y + (node.inbound > 0 && r > 26 ? 6 : 0);

      if (expanded) {
        const tm = ctx.measureText(displayLabel);
        const px = 5;
        const py = 3;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.beginPath();
        ctx.roundRect(node.x - tm.width / 2 - px, labelY - fontSize / 2 - py, tm.width + px * 2, fontSize + py * 2, 3);
        ctx.fill();
      }

      ctx.fillStyle = hslColor(node.hue, 20, 90, labelAlpha);
      ctx.fillText(displayLabel, node.x, labelY);

      // Pattern name — tiny, below
      if (r > 30) {
        ctx.font = `400 ${r > 40 ? 8 : 7}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = hslColor(node.hue, 20, 70, labelAlpha * 0.5);
        ctx.fillText(node.patternName, node.x, node.y + (node.inbound > 0 ? 18 : 12));
      }
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
    if (hit) onselect(hit.patternName, String(hit.entry.id));
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

  /* ── Live updates ── */

  let liveWs: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout>;

  function connectLive() {
    if (!browser) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    liveWs = new WebSocket(`${proto}//${location.host}/ws`);
    liveWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'changed') {
          if (animationId) cancelAnimationFrame(animationId);
          loadAndBuild();
        }
      } catch { /* ignore */ }
    };
    liveWs.onclose = () => { liveWs = null; reconnectTimer = setTimeout(connectLive, 3000); };
    liveWs.onerror = () => { liveWs?.close(); };
  }

  onMount(() => {
    if (!browser) return;
    ctx = canvas.getContext('2d')!;
    resize();
    loadAndBuild();
    connectLive();

    const ro = new ResizeObserver(() => {
      resize();
      for (const n of nodes) {
        n.x = Math.max(n.radius, Math.min(width - n.radius, n.x));
        n.y = Math.max(n.radius, Math.min(height - n.radius, n.y));
      }
    });
    ro.observe(canvas.parentElement!);

    return () => {
      ro.disconnect();
      clearTimeout(reconnectTimer);
      liveWs?.close();
      if (animationId) cancelAnimationFrame(animationId);
    };
  });

  onDestroy(() => {
    if (browser) {
      clearTimeout(reconnectTimer);
      liveWs?.close();
      if (animationId) cancelAnimationFrame(animationId);
    }
  });
</script>

<div class="link-map">
  {#if loading}
    <p class="loading">loading entries…</p>
  {/if}
  <canvas
    bind:this={canvas}
    onmousemove={handleMove}
    onclick={handleClick}
    onmouseleave={() => { hoveredNode = null; }}
  ></canvas>
</div>

<style>
  .link-map {
    width: 100%;
    height: 100%;
    position: relative;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: #3a3a48;
  }
</style>
