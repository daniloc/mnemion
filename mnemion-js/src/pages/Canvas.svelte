<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { browser } from './env.js';
  import EntryDetail from './EntryDetail.svelte';

  // === Types ===

  interface Facet {
    name: string;
    type: string;
    required: boolean;
    links?: string | null;
  }

  interface Pattern {
    name: string;
    description: string;
    facets: Facet[];
    entry_count: number;
  }

  interface CanvasEntry {
    id: number;
    name: string;
    folder: string | null;
    snapshot: string;
    updated_at: string;
  }

  // Shape data model — stored in snapshot
  interface CanvasShape {
    id: string;
    type: 'note' | 'entry' | 'link' | 'group';
    x: number;
    y: number;
    w: number;
    h: number;
    data: Record<string, unknown>;
  }

  interface CanvasConnection {
    id: string;
    from: string;
    to: string;
  }

  interface CanvasSnapshot {
    shapes: CanvasShape[];
    connections: CanvasConnection[];
    camera: { x: number; y: number; zoom: number };
  }

  // === State ===

  let canvases: CanvasEntry[] = $state([]);
  let activeCanvas: CanvasEntry | null = $state(null);
  let shapes: CanvasShape[] = $state([]);
  let connections: CanvasConnection[] = $state([]);
  let camera = $state({ x: 0, y: 0, zoom: 1 });

  let patterns: Pattern[] = $state([]);
  let expandedPattern: string | null = $state(null);
  let patternEntries: Record<string, unknown>[] = $state([]);
  let loadingEntries = $state(false);

  let creating = $state(false);
  let newName = $state('');
  let addingNote = $state(false);
  let linkUrl = $state('');

  // Drag state
  let dragging: string | null = $state(null);
  let dragOffset = { x: 0, y: 0 };

  // Group drawing + resize
  let drawingGroup = $state(false);
  let resizing: { id: string; corner: string; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null = $state(null);
  let groupDrawStart: { x: number; y: number } | null = $state(null);
  let groupDrawEnd: { x: number; y: number } | null = $state(null);
  let namingGroup: string | null = $state(null);
  let groupName = $state('');

  // Connection drawing
  let connecting: string | null = $state(null);
  let connectEnd = $state({ x: 0, y: 0 });

  // Selection
  let selected: string | null = $state(null);

  // Note editing
  let editingNote: string | null = $state(null);
  let editText = $state('');

  // Entry editor overlay (uses shared EntryDetail component)
  let overlayEntry: { patternName: string; facets: Facet[]; entry: Record<string, unknown>; shapeId: string } | null = $state(null);

  // Link content viewer
  let viewingLink: { url: string; title: string; content: string } | null = $state(null);

  // Link input state (in toolbar)
  let showLinkInput = $state(false);

  // Canvas element refs
  let canvasEl: HTMLDivElement;
  let stageEl: HTMLDivElement;

  // Save timer
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // === Canvas CRUD ===

  async function loadCanvases() {
    try {
      const res = await fetch('/api/canvases');
      const data = await res.json();
      canvases = data.entries || [];
    } catch {}
  }

  async function createCanvas() {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'create', data: { name: newName.trim() } }),
      });
      const result = await res.json();
      if (result.entry) {
        canvases = [result.entry, ...canvases];
        selectCanvas(result.entry);
        newName = '';
        creating = false;
      }
    } catch {}
  }

  async function selectCanvas(canvas: CanvasEntry) {
    // Save current before switching
    if (activeCanvas) await saveSnapshot();
    activeCanvas = canvas;
    selected = null;
    editingNote = null;

    // Load full canvas data
    try {
      const res = await fetch(`/api/canvases?id=${canvas.id}`);
      const data = await res.json();
      const entry = data.entries?.[0];
      if (entry?.snapshot && entry.snapshot !== '{}') {
        const snap: CanvasSnapshot = JSON.parse(entry.snapshot);
        shapes = snap.shapes || [];
        connections = snap.connections || [];
        camera = snap.camera || { x: 0, y: 0, zoom: 1 };
      } else {
        shapes = [];
        connections = [];
        camera = { x: 0, y: 0, zoom: 1 };
      }
    } catch {
      shapes = [];
      connections = [];
      camera = { x: 0, y: 0, zoom: 1 };
    }
    if (browser) history.replaceState(null, '', `#${canvas.id}`);
  }

  function buildSnapshot(): string {
    const snap: CanvasSnapshot = { shapes, connections, camera };
    return JSON.stringify(snap);
  }

  async function saveSnapshot() {
    if (!activeCanvas) return;
    try {
      await fetch('/api/canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'update',
          data: { id: activeCanvas.id, snapshot: buildSnapshot() },
        }),
      });
    } catch {}
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSnapshot, 2000);
  }

  // === Shape operations ===

  function genId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  function addNote() {
    const cx = (-camera.x + (stageEl?.clientWidth ?? 800) / 2) / camera.zoom;
    const cy = (-camera.y + (stageEl?.clientHeight ?? 600) / 2) / camera.zoom;
    const shape: CanvasShape = {
      id: genId(),
      type: 'note',
      x: cx - 100,
      y: cy - 50,
      w: 200,
      h: 100,
      data: { text: '', color: '#e8c872' },
    };
    shapes = [...shapes, shape];
    selected = shape.id;
    editingNote = shape.id;
    editText = '';
    scheduleSave();
  }

  function addEntryShape(pattern: Pattern, entry: Record<string, unknown>) {
    const cx = (-camera.x + (stageEl?.clientWidth ?? 800) / 2) / camera.zoom;
    const cy = (-camera.y + (stageEl?.clientHeight ?? 600) / 2) / camera.zoom;
    const label = entryLabel(entry, pattern);
    const facets: Record<string, unknown> = {};
    for (const f of pattern.facets.slice(0, 4)) {
      if (entry[f.name] != null) facets[f.name] = entry[f.name];
    }
    const shape: CanvasShape = {
      id: genId(),
      type: 'entry',
      x: cx - 120 + Math.random() * 40,
      y: cy - 60 + Math.random() * 40,
      w: 240,
      h: 120,
      data: { pattern: pattern.name, entryId: entry.id, label, facets },
    };
    shapes = [...shapes, shape];
    selected = shape.id;
    scheduleSave();
  }

  function addLinkShape() {
    if (!linkUrl.trim()) return;
    const url = linkUrl.trim();
    const cx = (-camera.x + (stageEl?.clientWidth ?? 800) / 2) / camera.zoom;
    const cy = (-camera.y + (stageEl?.clientHeight ?? 600) / 2) / camera.zoom;
    const shapeId = genId();
    const shape: CanvasShape = {
      id: shapeId,
      type: 'link',
      x: cx - 130,
      y: cy - 50,
      w: 260,
      h: 100,
      data: { url, title: url, description: '' },
    };
    shapes = [...shapes, shape];
    selected = shapeId;
    linkUrl = '';
    scheduleSave();

    // Resolve link content in background (updates shape when done)
    resolveLink(url).then(({ title, description }) => {
      shapes = shapes.map(s =>
        s.id === shapeId ? { ...s, data: { ...s.data, title, description } } : s
      );
      scheduleSave();
    });
  }

  function deleteSelected() {
    if (!selected) return;
    shapes = shapes.filter(s => s.id !== selected);
    connections = connections.filter(c => c.from !== selected && c.to !== selected);
    selected = null;
    editingNote = null;
    scheduleSave();
  }

  // === Pan & zoom ===

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.99 : 1.01;
    const newZoom = Math.max(0.1, Math.min(5, camera.zoom * factor));
    // Zoom toward cursor
    const rect = stageEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    camera = {
      x: mx - (mx - camera.x) * (newZoom / camera.zoom),
      y: my - (my - camera.y) * (newZoom / camera.zoom),
      zoom: newZoom,
    };
    scheduleSave();
  }

  // Stage panning (middle-click or space+drag handled via background mousedown)
  let panning = false;
  let panStart = { x: 0, y: 0 };

  function handleStageDown(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.canvas-shape')) return;

    // Group drawing mode: start rect
    if (drawingGroup && e.button === 0) {
      const rect = stageEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - camera.x) / camera.zoom;
      const wy = (e.clientY - rect.top - camera.y) / camera.zoom;
      groupDrawStart = { x: wx, y: wy };
      groupDrawEnd = { x: wx, y: wy };
      e.preventDefault();
      return;
    }

    if (e.button === 1 || e.button === 0) {
      selected = null;
      editingNote = null;
      // Pan on any background click (not just middle-click/alt)
      panning = true;
      panStart = { x: e.clientX - camera.x, y: e.clientY - camera.y };
      e.preventDefault();
    }
  }

  function handleStageMove(e: MouseEvent) {
    if (panning) {
      camera = { ...camera, x: e.clientX - panStart.x, y: e.clientY - panStart.y };
      return;
    }
    if (groupDrawStart) {
      const rect = stageEl.getBoundingClientRect();
      groupDrawEnd = {
        x: (e.clientX - rect.left - camera.x) / camera.zoom,
        y: (e.clientY - rect.top - camera.y) / camera.zoom,
      };
      return;
    }
    if (resizing) {
      const rect = stageEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - camera.x) / camera.zoom;
      const wy = (e.clientY - rect.top - camera.y) / camera.zoom;
      const dx = wx - resizing.startX;
      const dy = wy - resizing.startY;
      shapes = shapes.map(s => {
        if (s.id !== resizing!.id) return s;
        let { origX, origY, origW, origH } = resizing!;
        const c = resizing!.corner;
        let nx = origX, ny = origY, nw = origW, nh = origH;
        if (c.includes('e')) nw = Math.max(40, origW + dx);
        if (c.includes('w')) { nx = origX + dx; nw = Math.max(40, origW - dx); }
        if (c.includes('s')) nh = Math.max(40, origH + dy);
        if (c.includes('n')) { ny = origY + dy; nh = Math.max(40, origH - dy); }
        return { ...s, x: nx, y: ny, w: nw, h: nh };
      });
      return;
    }
    if (dragging) {
      const rect = stageEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - camera.x) / camera.zoom;
      const wy = (e.clientY - rect.top - camera.y) / camera.zoom;
      shapes = shapes.map(s =>
        s.id === dragging ? { ...s, x: wx - dragOffset.x, y: wy - dragOffset.y } : s
      );
    }
    if (connecting) {
      const rect = stageEl.getBoundingClientRect();
      connectEnd = {
        x: (e.clientX - rect.left - camera.x) / camera.zoom,
        y: (e.clientY - rect.top - camera.y) / camera.zoom,
      };
    }
  }

  function handleStageUp(e: MouseEvent) {
    if (panning) { panning = false; scheduleSave(); return; }
    if (resizing) { resizing = null; scheduleSave(); return; }
    if (groupDrawStart && groupDrawEnd) {
      const x = Math.min(groupDrawStart.x, groupDrawEnd.x);
      const y = Math.min(groupDrawStart.y, groupDrawEnd.y);
      const w = Math.abs(groupDrawEnd.x - groupDrawStart.x);
      const h = Math.abs(groupDrawEnd.y - groupDrawStart.y);
      if (w > 20 && h > 20) {
        const id = genId();
        shapes = [...shapes, {
          id, type: 'group', x, y, w, h,
          data: { name: '', color: '#e8c872' },
        }];
        namingGroup = id;
        groupName = '';
        selected = id;
      }
      groupDrawStart = null;
      groupDrawEnd = null;
      drawingGroup = false;
      scheduleSave();
      return;
    }
    if (dragging) { dragging = null; scheduleSave(); return; }
    if (connecting) {
      // Find shape under cursor
      const rect = stageEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - camera.x) / camera.zoom;
      const wy = (e.clientY - rect.top - camera.y) / camera.zoom;
      const target = shapes.find(s =>
        s.id !== connecting && wx >= s.x && wx <= s.x + s.w && wy >= s.y && wy <= s.y + s.h
      );
      if (target) {
        const exists = connections.some(
          c => (c.from === connecting && c.to === target.id) || (c.from === target.id && c.to === connecting)
        );
        if (!exists) {
          connections = [...connections, { id: genId(), from: connecting!, to: target.id }];
          scheduleSave();
        }
      }
      connecting = null;
    }
  }

  // === Shape drag ===

  function handleShapeDown(e: MouseEvent, shape: CanvasShape) {
    e.stopPropagation();
    selected = shape.id;

    if (e.shiftKey) {
      // Start connection
      connecting = shape.id;
      connectEnd = { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
      return;
    }

    dragging = shape.id;
    const rect = stageEl.getBoundingClientRect();
    const wx = (e.clientX - rect.left - camera.x) / camera.zoom;
    const wy = (e.clientY - rect.top - camera.y) / camera.zoom;
    dragOffset = { x: wx - shape.x, y: wy - shape.y };
  }

  // === Note editing ===

  function startEditNote(id: string, currentText: string) {
    editingNote = id;
    editText = currentText;
  }

  function finishEditNote() {
    if (editingNote) {
      shapes = shapes.map(s =>
        s.id === editingNote ? { ...s, data: { ...s.data, text: editText } } : s
      );
      editingNote = null;
      scheduleSave();
    }
  }

  // === Group naming ===

  function finishGroupName() {
    if (namingGroup) {
      shapes = shapes.map(s =>
        s.id === namingGroup ? { ...s, data: { ...s.data, name: groupName } } : s
      );
      namingGroup = null;
      scheduleSave();
    }
  }

  // === Entry overlay ===

  async function openEntryOverlay(shape: CanvasShape) {
    if (shape.type !== 'entry') return;
    const patternName = shape.data.pattern as string;
    const entryId = shape.data.entryId as number;
    const pat = patterns.find(p => p.name === patternName);
    if (!pat) return;
    try {
      const res = await fetch(`/api/query/${patternName}`);
      const data = await res.json();
      const entry = (data.entries || []).find((e: any) => e.id === entryId);
      if (!entry) return;
      overlayEntry = { patternName, facets: pat.facets, entry, shapeId: shape.id };
    } catch {}
  }

  function handleEntrySaved(updated: Record<string, unknown>) {
    if (!overlayEntry) return;
    const shapeId = overlayEntry.shapeId;
    const pat = patterns.find(p => p.name === overlayEntry!.patternName);
    if (pat) {
      const label = entryLabel(updated, pat);
      const newFacets: Record<string, unknown> = {};
      for (const f of pat.facets.slice(0, 4)) {
        if (updated[f.name] != null) newFacets[f.name] = updated[f.name];
      }
      shapes = shapes.map(s =>
        s.id === shapeId
          ? { ...s, data: { ...s.data, label, facets: newFacets } }
          : s
      );
      scheduleSave();
    }
    // Update the overlay's entry data without reassigning the object
    // (reassigning would unmount/remount EntryDetail)
    overlayEntry.entry = updated;
  }

  // === Link resolve + viewer ===

  async function resolveLink(url: string): Promise<{ title: string; description: string }> {
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: url }),
      });
      const data = await res.json();
      if (data.metadata?.title) {
        return { title: data.metadata.title, description: data.content?.slice(0, 200) || '' };
      }
      return { title: url, description: '' };
    } catch {
      return { title: url, description: '' };
    }
  }

  async function openLinkViewer(shape: CanvasShape) {
    if (shape.type !== 'link') return;
    const url = shape.data.url as string;
    viewingLink = { url, title: shape.data.title as string || url, content: 'loading\u2026' };
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: url }),
      });
      const data = await res.json();
      viewingLink = {
        url,
        title: data.metadata?.title || shape.data.title as string || url,
        content: data.content || 'No content available.',
      };
    } catch {
      viewingLink = { url, title: url, content: 'Failed to load content.' };
    }
  }

  // === Pattern palette ===

  async function togglePattern(name: string) {
    if (expandedPattern === name) {
      expandedPattern = null;
      patternEntries = [];
      return;
    }
    expandedPattern = name;
    loadingEntries = true;
    try {
      const res = await fetch(`/api/query/${name}`);
      const data = await res.json();
      patternEntries = data.entries || [];
    } catch { patternEntries = []; }
    loadingEntries = false;
  }

  function entryLabel(entry: Record<string, unknown>, pattern: Pattern): string {
    for (const key of ['name', 'title', 'label', 'key']) {
      if (entry[key] && typeof entry[key] === 'string') return entry[key] as string;
    }
    const firstText = pattern.facets.find(f => f.type === 'text');
    if (firstText && entry[firstText.name]) {
      const val = String(entry[firstText.name]);
      return val.length > 40 ? val.slice(0, 39) + '\u2026' : val;
    }
    return `#${entry.id}`;
  }

  // === Connection geometry ===

  function shapeCenter(id: string): { x: number; y: number } {
    const s = shapes.find(sh => sh.id === id);
    if (!s) return { x: 0, y: 0 };
    return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  }

  // === Keyboard ===

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editingNote) return; // don't delete while editing text
      deleteSelected();
    }
    if (e.key === 'Escape') {
      selected = null;
      connecting = null;
      editingNote = null;
      drawingGroup = false;
      groupDrawStart = null;
      groupDrawEnd = null;
      namingGroup = null;
    }
  }

  // === Format helpers ===

  function formatDate(d: string): string {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function hostname(url: string): string {
    if (url.startsWith('mnemion://')) return url.replace('mnemion://', '').split('/')[0] || 'mnemion';
    try { return new URL(url).hostname; } catch { return url; }
  }

  // === Lifecycle ===

  onMount(async () => {
    if (!browser) return;
    await loadCanvases();

    // Load patterns for palette
    try {
      const res = await fetch('/api/index');
      const data = await res.json();
      patterns = ((data.patterns || []) as Pattern[]).filter(p => !p.name.startsWith('_'));
    } catch {}

    // Restore from hash
    const hash = location.hash.slice(1);
    if (hash) {
      const id = parseInt(hash, 10);
      const match = canvases.find(c => c.id === id);
      if (match) selectCanvas(match);
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    if (browser && saveTimer) clearTimeout(saveTimer);
  });
</script>

<div class="canvas-app">
  <!-- Left panel: canvas list -->
  <nav class="canvas-list-panel">
    <div class="panel-header">
      <h2>canvases</h2>
      <button class="create-btn" onclick={() => { creating = !creating; }} title="New canvas">+</button>
    </div>

    {#if creating}
      <div class="create-form">
        <input
          autofocus
          placeholder="canvas name\u2026"
          bind:value={newName}
          onkeydown={(e) => {
            if (e.key === 'Enter') createCanvas();
            if (e.key === 'Escape') { creating = false; newName = ''; }
          }}
        />
      </div>
    {/if}

    <div class="canvas-items">
      {#each canvases as c (c.id)}
        <button
          class="canvas-item"
          class:active={activeCanvas?.id === c.id}
          onclick={() => selectCanvas(c)}
        >
          <span class="canvas-name">{c.name}</span>
          <span class="canvas-date">{formatDate(c.updated_at)}</span>
        </button>
      {/each}
      {#if canvases.length === 0 && !creating}
        <p class="empty">no canvases yet</p>
      {/if}
    </div>
  </nav>

  <!-- Center: canvas stage -->
  <div class="canvas-center">
    {#if activeCanvas}
      <div class="canvas-toolbar">
        <span class="canvas-title">{activeCanvas.name}</span>
        <div class="toolbar-actions">
          <button class="tool-btn" onclick={addNote} title="Add note">+ note</button>
          <button class="tool-btn" onclick={() => { showLinkInput = !showLinkInput; }} title="Add link">+ link</button>
          <button class="tool-btn" class:active={drawingGroup} onclick={() => { drawingGroup = !drawingGroup; }} title="Draw group">+ group</button>
          {#if showLinkInput}
            <div class="toolbar-link-input">
              <input
                autofocus
                placeholder="https://\u2026"
                bind:value={linkUrl}
                onkeydown={(e) => {
                  if (e.key === 'Enter') { addLinkShape(); showLinkInput = false; }
                  if (e.key === 'Escape') { showLinkInput = false; linkUrl = ''; }
                }}
              />
            </div>
          {/if}
          <span class="toolbar-hint">shift+click to connect &middot; drag background to pan &middot; scroll to zoom</span>
        </div>
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="stage"
        class:drawing={drawingGroup}
        bind:this={stageEl}
        onmousedown={handleStageDown}
        onmousemove={handleStageMove}
        onmouseup={handleStageUp}
        onwheel={handleWheel}
      >
        <svg class="canvas-svg" style="transform: translate({camera.x}px, {camera.y}px) scale({camera.zoom});">
          <!-- Dot grid -->
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <circle cx="20" cy="20" r="0.8" fill="#1a1a24" />
            </pattern>
          </defs>
          <rect x="-10000" y="-10000" width="20000" height="20000" fill="url(#grid)" />

          <!-- Connections -->
          {#each connections as conn (conn.id)}
            {@const from = shapeCenter(conn.from)}
            {@const to = shapeCenter(conn.to)}
            <line
              x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="#a89044" stroke-width={1.5} opacity={0.5}
              marker-end="url(#arrowhead)"
            />
          {/each}

          <!-- Connection in progress -->
          {#if connecting}
            {@const from = shapeCenter(connecting)}
            <line
              x1={from.x} y1={from.y} x2={connectEnd.x} y2={connectEnd.y}
              stroke="#e8c872" stroke-width={1.5} stroke-dasharray="6 4" opacity={0.6}
            />
          {/if}

          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#a89044" opacity="0.5" />
            </marker>
          </defs>

          <!-- Group draw preview -->
          {#if groupDrawStart && groupDrawEnd}
            {@const gx = Math.min(groupDrawStart.x, groupDrawEnd.x)}
            {@const gy = Math.min(groupDrawStart.y, groupDrawEnd.y)}
            {@const gw = Math.abs(groupDrawEnd.x - groupDrawStart.x)}
            {@const gh = Math.abs(groupDrawEnd.y - groupDrawStart.y)}
            <rect
              x={gx} y={gy} width={gw} height={gh}
              rx={12} ry={12}
              fill="rgba(232, 200, 114, 0.04)"
              stroke="#e8c872" stroke-width={1.5} stroke-dasharray="2 4" stroke-linecap="round"
              opacity={0.6}
            />
          {/if}

          <!-- Groups (rendered behind other shapes) -->
          {#each shapes.filter(s => s.type === 'group') as shape (shape.id)}
            <rect
              x={shape.x} y={shape.y} width={shape.w} height={shape.h}
              rx={12} ry={12}
              fill="rgba(232, 200, 114, 0.03)"
              stroke={selected === shape.id ? '#e8c872' : '#3a3a48'}
              stroke-width={selected === shape.id ? 2 : 1}
              stroke-dasharray="2 4"
              stroke-linecap="round"
              class="group-rect"
              onmousedown={(e) => { e.stopPropagation(); handleShapeDown(e, shape); }}
            />
            <!-- Label outside, above the group -->
            {#if namingGroup === shape.id}
              <foreignObject x={shape.x} y={shape.y - 24} width={shape.w} height={22}>
                <input
                  class="group-name-input"
                  autofocus
                  placeholder="group name\u2026"
                  bind:value={groupName}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') finishGroupName();
                    if (e.key === 'Escape') { namingGroup = null; }
                  }}
                  onblur={finishGroupName}
                />
              </foreignObject>
            {:else}
              <text
                x={shape.x} y={shape.y - 8}
                class="group-name-label"
                ondblclick={() => { namingGroup = shape.id; groupName = (shape.data.name as string) || ''; }}
              >{(shape.data.name as string) || 'unnamed group'}</text>
            {/if}
            <!-- Resize handles (visible when selected) -->
            {#if selected === shape.id}
              {#each [
                { corner: 'nw', cx: shape.x, cy: shape.y },
                { corner: 'ne', cx: shape.x + shape.w, cy: shape.y },
                { corner: 'sw', cx: shape.x, cy: shape.y + shape.h },
                { corner: 'se', cx: shape.x + shape.w, cy: shape.y + shape.h },
              ] as handle}
                <rect
                  x={handle.cx - 5} y={handle.cy - 5} width={10} height={10}
                  rx={2} ry={2}
                  fill="#e8c872" opacity={0.8}
                  class="resize-handle resize-{handle.corner}"
                  onmousedown={(e) => {
                    e.stopPropagation();
                    const rect = stageEl.getBoundingClientRect();
                    resizing = {
                      id: shape.id,
                      corner: handle.corner,
                      startX: (e.clientX - rect.left - camera.x) / camera.zoom,
                      startY: (e.clientY - rect.top - camera.y) / camera.zoom,
                      origX: shape.x, origY: shape.y, origW: shape.w, origH: shape.h,
                    };
                  }}
                />
              {/each}
            {/if}
          {/each}

          <!-- Shapes (notes, entries, links) -->
          {#each shapes.filter(s => s.type !== 'group') as shape (shape.id)}
            <foreignObject
              x={shape.x}
              y={shape.y}
              width={shape.w}
              height={shape.h}
            >
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="canvas-shape shape-{shape.type}"
                class:selected={selected === shape.id}
                onmousedown={(e) => handleShapeDown(e, shape)}
                ondblclick={() => {
                  if (shape.type === 'note') startEditNote(shape.id, (shape.data.text as string) || '');
                  if (shape.type === 'entry') openEntryOverlay(shape);
                  if (shape.type === 'link') openLinkViewer(shape);
                }}
              >
                {#if shape.type === 'note'}
                  <div class="note-accent" style="background: {shape.data.color || '#e8c872'};"></div>
                  {#if editingNote === shape.id}
                    <textarea
                      class="note-editor"
                      bind:value={editText}
                      onblur={finishEditNote}
                      onkeydown={(e) => { if (e.key === 'Escape') finishEditNote(); }}
                      autofocus
                    ></textarea>
                  {:else}
                    <div class="note-text">{(shape.data.text as string) || 'double-click to edit'}</div>
                  {/if}

                {:else if shape.type === 'entry'}
                  <div class="entry-label">{shape.data.label || ''}</div>
                  {#if shape.data.facets && typeof shape.data.facets === 'object'}
                    <div class="entry-facets">
                      {#each Object.entries(shape.data.facets as Record<string, unknown>).slice(0, 3) as [key, val]}
                        <div class="facet-row"><span class="facet-key">{key}:</span> {String(val ?? '')}</div>
                      {/each}
                    </div>
                  {/if}

                {:else if shape.type === 'link'}
                  <div class="link-host">{hostname(shape.data.url as string)}</div>
                  <div class="link-title">{shape.data.title || shape.data.url}</div>
                  {#if shape.data.description}
                    <div class="link-desc">{shape.data.description}</div>
                  {/if}
                {/if}
              </div>
            </foreignObject>
            <!-- Pattern label beneath entry shapes -->
            {#if shape.type === 'entry'}
              <text
                x={shape.x + shape.w}
                y={shape.y + shape.h + 14}
                text-anchor="end"
                class="shape-label-below"
              >{shape.data.pattern} #{shape.data.entryId}</text>
            {/if}
          {/each}
        </svg>
      </div>
    {:else}
      <div class="canvas-empty">
        <p>select or create a canvas</p>
      </div>
    {/if}
  </div>

  <!-- Right panel: object palette -->
  <aside class="object-palette">
    <div class="panel-header">
      <h2>objects</h2>
    </div>

    <div class="palette-section patterns-section">
      <div class="section-label">patterns</div>
      {#each patterns as p (p.name)}
        <div class="pattern-group">
          <button
            class="pattern-toggle"
            class:expanded={expandedPattern === p.name}
            onclick={() => togglePattern(p.name)}
          >
            <span class="pattern-name">{p.name}</span>
            <span class="pattern-count">{p.entry_count}</span>
          </button>
          {#if expandedPattern === p.name}
            <div class="pattern-entries">
              {#if loadingEntries}
                <div class="loading">loading\u2026</div>
              {:else if patternEntries.length === 0}
                <div class="loading">no entries</div>
              {:else}
                {#each patternEntries as entry (entry.id)}
                  <button
                    class="entry-drop-btn"
                    onclick={() => addEntryShape(p, entry)}
                    title="Click to add to canvas"
                  >
                    <span class="entry-drop-label">{entryLabel(entry, p)}</span>
                    <span class="entry-drop-id">#{entry.id}</span>
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </aside>

  <!-- Entry editor overlay (shared EntryDetail component) -->
  {#if overlayEntry}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay-backdrop" onclick={() => { overlayEntry = null; }}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="overlay-panel overlay-fullscreen" onclick={(e) => e.stopPropagation()}>
        <div class="overlay-header">
          <span class="overlay-pattern">{overlayEntry.patternName} #{overlayEntry.entry.id}</span>
          <button class="overlay-close" onclick={() => { overlayEntry = null; }}>&times;</button>
        </div>
        <div class="overlay-detail">
          <EntryDetail
            patternName={overlayEntry.patternName}
            facets={overlayEntry.facets}
            entry={overlayEntry.entry}
            onsave={handleEntrySaved}
          />
        </div>
      </div>
    </div>
  {/if}

  <!-- Link content viewer -->
  {#if viewingLink}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay-backdrop" onclick={() => { viewingLink = null; }}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="overlay-panel overlay-fullscreen" onclick={(e) => e.stopPropagation()}>
        <div class="overlay-header">
          <span class="overlay-link-url">{viewingLink.title}</span>
          <button class="overlay-close" onclick={() => { viewingLink = null; }}>&times;</button>
        </div>
        <div class="overlay-link-content">
          <pre>{viewingLink.content}</pre>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;500;700&display=swap');

  :global(*) { margin: 0; padding: 0; box-sizing: border-box; }
  :global(body) {
    font-family: 'DM Sans', system-ui, sans-serif;
    background: #0a0a0c;
    color: #c8c8d0;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    height: 100vh;
  }

  .canvas-app {
    display: grid;
    grid-template-columns: 240px 1fr 280px;
    height: 100vh;
  }

  /* === Left panel === */

  .canvas-list-panel {
    border-right: 1px solid #1a1a22;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1rem 0.75rem;
    flex-shrink: 0;
  }

  .panel-header h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #4a4a58;
  }

  .create-btn {
    width: 24px; height: 24px;
    border: 1px solid #2a2a38; border-radius: 4px;
    background: none; color: #6a6a78;
    font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.1s;
  }
  .create-btn:hover { border-color: #e8c872; color: #e8c872; }

  .create-form { padding: 0 1rem 0.75rem; }
  .create-form input {
    width: 100%; padding: 0.5rem 0.6rem;
    background: #12121a; border: 1px solid #e8c872; border-radius: 4px;
    color: #c8c8d0; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; outline: none;
  }
  .create-form input::placeholder { color: #3a3a48; }

  .canvas-items { flex: 1; overflow-y: auto; }

  .canvas-item {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%; padding: 0.55rem 1rem; border: none; background: none;
    color: #c8c8d0; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
    cursor: pointer; transition: background 0.1s; text-align: left;
  }
  .canvas-item:hover { background: #14141e; }
  .canvas-item.active { background: #1a1a28; color: #e8c872; }

  .canvas-date { font-size: 0.65rem; color: #3a3a48; }
  .canvas-item.active .canvas-date { color: #a89044; }

  .empty {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem; color: #3a3a48; padding: 1rem;
  }

  /* === Center === */

  .canvas-center {
    display: flex; flex-direction: column; overflow: hidden; position: relative;
  }

  .canvas-toolbar {
    padding: 0.5rem 1.25rem;
    border-bottom: 1px solid #1a1a22;
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }

  .canvas-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem; font-weight: 600; color: #e8c872; letter-spacing: 0.05em;
  }

  .toolbar-actions { display: flex; align-items: center; gap: 0.75rem; }

  .tool-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem; font-weight: 600;
    padding: 0.3rem 0.7rem; border: 1px solid #2a2a38; border-radius: 4px;
    background: #12121a; color: #8a8a98; cursor: pointer; transition: all 0.1s;
  }
  .tool-btn:hover { border-color: #e8c872; color: #e8c872; }
  .tool-btn.active { border-color: #e8c872; color: #e8c872; background: #1a1a28; }

  .toolbar-link-input input {
    padding: 0.3rem 0.5rem;
    background: #12121a; border: 1px solid #4a6a8a; border-radius: 4px;
    color: #c8c8d0; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; outline: none;
    width: 220px;
  }
  .toolbar-link-input input::placeholder { color: #3a3a48; }

  .toolbar-hint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem; color: #3a3a48;
  }

  .canvas-empty {
    flex: 1; display: flex; align-items: center; justify-content: center;
  }
  .canvas-empty p {
    font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; color: #3a3a48;
  }

  .stage {
    flex: 1; overflow: hidden; cursor: default; background: #0c0c10; position: relative;
  }
  .stage.drawing { cursor: crosshair; }

  .canvas-svg {
    width: 100%; height: 100%; transform-origin: 0 0; position: absolute; top: 0; left: 0;
    overflow: visible;
  }

  .group-rect { cursor: grab; }
  .group-rect:active { cursor: grabbing; }

  .resize-handle { pointer-events: all; }
  .resize-nw, .resize-se { cursor: nwse-resize; }
  .resize-ne, .resize-sw { cursor: nesw-resize; }

  .group-name-input {
    width: 100%; padding: 2px 4px;
    background: rgba(15, 15, 20, 0.9); border: 1px solid #e8c872; border-radius: 3px;
    color: #e8c872; font-family: 'JetBrains Mono', monospace;
    font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
    text-transform: uppercase; outline: none;
  }
  .group-name-input::placeholder { color: #3a3a48; text-transform: uppercase; }

  .group-name-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase;
    fill: #6a6a78; cursor: text;
    pointer-events: all;
  }

  .shape-label-below {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase;
    fill: #e8c872; opacity: 0.5;
    pointer-events: none;
  }

  /* === Shapes === */

  .canvas-shape {
    width: 100%; height: 100%;
    border-radius: 6px; overflow: hidden;
    font-family: 'JetBrains Mono', monospace;
    cursor: grab; user-select: none;
    transition: box-shadow 0.1s;
  }
  .canvas-shape:active { cursor: grabbing; }
  .canvas-shape.selected { box-shadow: 0 0 0 2px #e8c872; }

  /* Note */
  .shape-note {
    background: rgba(15, 15, 20, 0.92);
    border: 1px solid #2a2a38;
    display: flex; padding: 0;
  }
  .note-accent {
    width: 4px; flex-shrink: 0; border-radius: 6px 0 0 6px;
  }
  .note-text {
    padding: 10px 12px; font-size: 12px; color: #c8c8d0; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; flex: 1;
  }
  .shape-note:not(.selected) .note-text:empty::after,
  .note-text:has(+ .note-editor) { content: ''; }

  .note-editor {
    flex: 1; padding: 10px 12px; font-size: 12px; color: #c8c8d0;
    background: transparent; border: none; outline: none; resize: none;
    font-family: 'JetBrains Mono', monospace; line-height: 1.5;
  }

  /* Entry */
  .shape-entry {
    background: rgba(15, 15, 20, 0.92);
    border: 1px solid #e8c872;
    padding: 10px 12px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .entry-label {
    font-size: 13px; font-weight: 600; color: #e0e0e8;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .entry-facets { display: flex; flex-direction: column; gap: 2px; }
  .facet-row {
    font-size: 10px; color: #8a8a98;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .facet-key { color: #6a6a78; }

  /* Link */
  .shape-link {
    background: rgba(15, 15, 20, 0.92);
    border: 1px solid #4a6a8a;
    padding: 10px 12px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .link-host {
    font-size: 9px; color: #4a6a8a; letter-spacing: 0.05em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .link-title {
    font-size: 13px; font-weight: 600; color: #a0c4e8;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .link-desc {
    font-size: 11px; color: #6a7a8a; line-height: 1.4;
    overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }

  /* === Right panel === */

  .object-palette {
    border-left: 1px solid #1a1a22;
    display: flex; flex-direction: column; overflow: hidden;
  }

  .palette-section {
    padding: 0.5rem 1rem; border-bottom: 1px solid #111118;
  }
  .patterns-section { flex: 1; overflow-y: auto; }

  .section-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem; font-weight: 600; letter-spacing: 0.15em;
    text-transform: uppercase; color: #4a4a58; margin-bottom: 0.5rem;
  }

  .pattern-group { margin-bottom: 2px; }

  .pattern-toggle {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%; padding: 0.4rem 0; border: none; background: none;
    color: #8a8a98; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;
    cursor: pointer; text-align: left;
  }
  .pattern-toggle:hover { color: #c8c8d0; }
  .pattern-toggle.expanded .pattern-name { color: #e8c872; }

  .pattern-count { font-size: 0.65rem; color: #3a3a48; }

  .pattern-entries { padding-left: 0.5rem; margin-bottom: 0.5rem; }

  .loading {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem; color: #3a3a48; padding: 0.3rem 0;
  }

  .entry-drop-btn {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%; padding: 0.3rem 0.4rem; border: none; background: none;
    color: #8a8a98; font-family: 'DM Sans', system-ui, sans-serif; font-size: 0.78rem;
    cursor: pointer; text-align: left; border-radius: 3px; transition: background 0.1s;
  }
  .entry-drop-btn:hover { background: #14141e; color: #c8c8d0; }

  .entry-drop-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
  }
  .entry-drop-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem; color: #3a3a48; flex-shrink: 0; margin-left: 0.5rem;
  }

  /* === Overlays === */

  .overlay-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
  }

  .overlay-panel {
    background: #0e0e14;
    border: 1px solid #1a1a22;
    border-radius: 8px;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }

  .overlay-fullscreen {
    width: calc(100vw - 120px);
    height: calc(100vh - 80px);
    max-width: 900px;
  }

  .overlay-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #1a1a22;
    flex-shrink: 0;
  }

  .overlay-pattern {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: #e8c872;
  }

  .overlay-link-url {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem; font-weight: 600;
    color: #a0c4e8;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1;
  }

  .overlay-close {
    background: none; border: none; color: #6a6a78;
    font-size: 1.4rem; cursor: pointer; padding: 0 0.25rem;
    flex-shrink: 0; margin-left: 1rem;
  }
  .overlay-close:hover { color: #c8c8d0; }

  .overlay-detail {
    flex: 1; min-height: 0; overflow: hidden;
  }

  .overlay-link-content {
    flex: 1; overflow-y: auto; padding: 1.5rem;
  }
  .overlay-link-content pre {
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 0.88rem; line-height: 1.7; color: #b0b0b8;
    white-space: pre-wrap; word-break: break-word;
    margin: 0;
  }
</style>
