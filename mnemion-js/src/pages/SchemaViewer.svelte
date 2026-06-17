<script lang="ts">
  import { browser } from './env.js';
  import { onMount } from 'svelte';

  interface Facet {
    name: string;
    type: string;
    required: boolean;
    options?: string[];
  }
  interface Pattern {
    name: string;
    description: string;
    doctrine: string;
    facets: Facet[];
    entry_count: number;
    latest_activity?: string | null;
  }
  interface Props {
    patterns: Pattern[];
    charter: Record<string, string>;
    guidance: string;
  }

  let { patterns = [], charter = {}, guidance = '' }: Props = $props();

  let selected: Pattern | null = $state(null);
  let entries: Record<string, unknown>[] = $state([]);
  let loading = $state(false);
  let menuOpen = $state(false);

  // Index already arrives sorted by latest_activity (most recent first). Split
  // user patterns from the kernel/system patterns, which sink to the bottom.
  let userPatterns = $derived(patterns.filter(p => !p.name.startsWith('_')));
  let kernelPatterns = $derived(patterns.filter(p => p.name.startsWith('_')));

  // --- time ---
  function relativeTime(val: unknown): string {
    if (!val) return '';
    const d = new Date(String(val).replace(' ', 'T') + (String(val).includes('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fullTime(val: unknown): string {
    if (!val) return '';
    const d = new Date(String(val).replace(' ', 'T') + (String(val).includes('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  // --- entry rendering: every populated facet, the entry in its entirety ---
  const KERNEL_COLS = new Set(['id', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'updated_by']);

  function fields(entry: Record<string, unknown>): { name: string; value: string; lead: boolean; long: boolean }[] {
    if (!selected) return [];
    const out: { name: string; value: string; lead: boolean; long: boolean }[] = [];
    let leadTaken = false;
    for (const f of selected.facets) {
      if (KERNEL_COLS.has(f.name)) continue;
      const raw = entry[f.name];
      if (raw === null || raw === undefined || raw === '') continue;
      let value = f.type === 'datetime' ? fullTime(raw)
        : f.type === 'boolean' ? (raw ? 'yes' : 'no')
        : String(raw);
      const long = value.length > 88 || value.includes('\n');
      const lead = !leadTaken && f.type === 'text';
      if (lead) leadTaken = true;
      out.push({ name: f.name, value, lead, long });
    }
    return out;
  }

  // --- navigation / data ---
  function pushHash(name?: string) {
    if (!browser) return;
    history.replaceState(null, '', name ? `#${name}` : location.pathname);
  }

  async function selectPattern(p: Pattern) {
    selected = p;
    entries = [];
    menuOpen = false;
    pushHash(p.name);
    if (!browser) return;
    loading = true;
    try {
      const res = await fetch(`/api/query/${p.name}`);
      const data = await res.json();
      entries = data.entries || [];
    } catch { entries = []; }
    loading = false;
  }

  function goCover() {
    selected = null;
    entries = [];
    menuOpen = false;
    pushHash();
  }

  // --- live updates ---
  let ws: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout>;
  function connectLive() {
    if (!browser) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'changed') return;
        const changed: string[] = msg.patterns || [];
        if (changed.includes('_schema')) { location.reload(); return; }
        try {
          const idx = await (await fetch('/api/index')).json();
          patterns = idx.patterns;
          charter = idx.charter ?? {};
          if (selected) selected = patterns.find(p => p.name === selected!.name) ?? selected;
        } catch {}
        if (selected && changed.includes(selected.name)) selectPattern(selected);
      } catch {}
    };
    ws.onclose = () => { ws = null; reconnect = setTimeout(connectLive, 3000); };
    ws.onerror = () => ws?.close();
  }

  onMount(() => {
    const name = location.hash.slice(1);
    if (name) { const m = patterns.find(p => p.name === name); if (m) selectPattern(m); }
    connectLive();
    return () => { clearTimeout(reconnect); ws?.close(); };
  });

  const charterEntries = $derived(Object.entries(charter).filter(([, v]) => v && String(v).trim()));
</script>

<svelte:head>
  <title>mnemion</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
  <link
    href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500;600&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<div class="shell" class:menu-open={menuOpen}>
  <!-- mobile top bar -->
  <header class="topbar">
    <button class="menu-btn" onclick={() => (menuOpen = !menuOpen)} aria-label="patterns">
      <span></span><span></span><span></span>
    </button>
    <button class="wordmark mobile-word" onclick={goCover}>mnemion</button>
    <span class="topbar-current">{selected ? selected.name : ''}</span>
  </header>

  <!-- sidebar -->
  <aside class="sidebar">
    <button class="wordmark" onclick={goCover}>
      mnemion
      <span class="wordmark-sub">a notebook</span>
    </button>

    <nav class="patterns">
      {#each userPatterns as p (p.name)}
        <button class="pat" class:active={selected?.name === p.name} onclick={() => selectPattern(p)}>
          <span class="pat-name">{p.name}</span>
          <span class="pat-meta">
            <span class="pat-count">{p.entry_count}</span>
            {#if p.latest_activity}<span class="pat-time">{relativeTime(p.latest_activity)}</span>{/if}
          </span>
        </button>
      {/each}
    </nav>

    {#if kernelPatterns.length}
      <div class="group-label">system</div>
      <nav class="patterns kernel">
        {#each kernelPatterns as p (p.name)}
          <button class="pat pat-sys" class:active={selected?.name === p.name} onclick={() => selectPattern(p)}>
            <span class="pat-name">{p.name}</span>
            <span class="pat-count">{p.entry_count}</span>
          </button>
        {/each}
      </nav>
    {/if}
  </aside>

  <!-- scrim for mobile menu -->
  <button class="scrim" aria-label="close menu" onclick={() => (menuOpen = false)}></button>

  <!-- main -->
  <main class="main">
    {#if !selected}
      <!-- cover page: the notebook's identity -->
      <section class="cover">
        <div class="cover-mark">mnemion</div>
        {#if guidance}<p class="cover-lede">{guidance}</p>{/if}
        <div class="cover-charter">
          {#each charterEntries as [key, value]}
            <div class="charter-row">
              <div class="charter-key">{key.replace(/_/g, ' ')}</div>
              <p class="charter-val">{value}</p>
            </div>
          {/each}
        </div>
        {#if !charterEntries.length}
          <p class="cover-empty">Select a pattern to begin.</p>
        {/if}
      </section>
    {:else}
      <section class="pattern-view">
        <header class="pattern-head">
          <h1>{selected.name}</h1>
          <div class="pattern-sub">
            <span class="ct">{selected.entry_count} {selected.entry_count === 1 ? 'entry' : 'entries'}</span>
            {#if selected.description}<span class="desc">{selected.description}</span>{/if}
          </div>
        </header>

        {#if loading}
          <div class="status">loading…</div>
        {:else if entries.length === 0}
          <div class="status">No entries yet.</div>
        {:else}
          <div class="stack">
            {#each entries as entry, i (entry.id)}
              <article class="block" style="--i:{Math.min(i, 12)}">
                <div class="block-fields">
                  {#each fields(entry) as field}
                    <div class="field" class:lead={field.lead} class:long={field.long}>
                      <div class="field-name">{field.name}</div>
                      <div class="field-value">{field.value}</div>
                    </div>
                  {/each}
                </div>
                <footer class="block-meta">
                  <span class="id">#{entry.id}</span>
                  {#if entry.updated_at}<span title={fullTime(entry.updated_at)}>{relativeTime(entry.updated_at)}</span>{/if}
                  {#if entry.created_by}<span class="author">{entry.created_by}</span>{/if}
                </footer>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  :global(:root) {
    --paper: #f1efe8;
    --paper-2: #e9e6dd;
    --card: #fbfaf6;
    --ink: #1b1a16;
    --ink-2: #514d45;
    --ink-3: #8b867b;
    --line: #dcd8cd;
    --line-strong: #cbc6b8;
    --accent: #cf4a1a;
    --accent-tint: #f6e3d8;
    --sans: 'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif;
    --mono: 'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  }

  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; }
  :global(::selection) { background: var(--accent-tint); color: var(--ink); }

  .shell {
    display: grid;
    grid-template-columns: 304px 1fr;
    min-height: 100vh;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
    /* faint paper grain */
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.025'/%3E%3C/svg%3E");
  }

  /* ---------- sidebar ---------- */
  .sidebar {
    grid-column: 1;
    border-right: 1px solid var(--line-strong);
    padding: 26px 14px 40px;
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    overflow-y: auto;
    background: var(--paper);
    display: flex;
    flex-direction: column;
  }

  .wordmark {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 17px;
    letter-spacing: -0.02em;
    color: var(--ink);
    background: none;
    border: 0;
    padding: 6px 10px;
    margin-bottom: 22px;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .wordmark-sub {
    font-family: var(--sans);
    font-weight: 500;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .patterns { display: flex; flex-direction: column; gap: 2px; }

  /* the big thick pattern button */
  .pat {
    display: flex;
    flex-direction: column;
    gap: 7px;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-left: 3px solid transparent;
    padding: 14px 13px;
    border-radius: 3px;
    cursor: pointer;
    font-family: var(--mono);
    color: var(--ink-2);
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .pat:hover { background: var(--paper-2); color: var(--ink); }
  .pat.active {
    background: var(--card);
    border-left-color: var(--accent);
    color: var(--ink);
    box-shadow: 0 1px 0 var(--line) inset, 0 -1px 0 var(--line) inset;
  }
  .pat-name {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .pat.active .pat-name { font-weight: 600; }
  .pat-meta { display: flex; align-items: baseline; gap: 10px; }
  .pat-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .pat.active .pat-count { color: var(--accent); }
  .pat-time {
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .group-label {
    font-family: var(--sans);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ink-3);
    padding: 0 13px;
    margin: 26px 0 8px;
    border-top: 1px solid var(--line);
    padding-top: 20px;
  }
  .kernel .pat-sys {
    padding: 10px 13px;
    flex-direction: row;
    justify-content: space-between;
    align-items: baseline;
  }
  .kernel .pat-name { font-size: 12.5px; font-weight: 400; color: var(--ink-3); }
  .kernel .pat-sys:hover .pat-name,
  .kernel .pat-sys.active .pat-name { color: var(--ink); }

  /* ---------- main ---------- */
  .main {
    grid-column: 2;
    padding: 0;
    min-width: 0;
  }

  /* cover page */
  .cover { max-width: 720px; padding: 96px 56px 120px; }
  .cover-mark {
    font-family: var(--mono);
    font-weight: 600;
    font-size: clamp(40px, 8vw, 76px);
    letter-spacing: -0.04em;
    line-height: 0.95;
    margin-bottom: 28px;
  }
  .cover-lede {
    font-size: 18px;
    line-height: 1.6;
    color: var(--ink-2);
    max-width: 56ch;
    margin: 0 0 56px;
  }
  .cover-charter { display: flex; flex-direction: column; gap: 30px; }
  .charter-row {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 22px;
    padding-top: 22px;
    border-top: 1px solid var(--line);
  }
  .charter-key {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: lowercase;
    color: var(--accent);
    padding-top: 3px;
  }
  .charter-val {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.62;
    color: var(--ink-2);
    white-space: pre-wrap;
  }
  .cover-empty { color: var(--ink-3); font-family: var(--mono); font-size: 13px; }

  /* pattern view */
  .pattern-view { max-width: 760px; padding: 64px 56px 140px; }
  .pattern-head { margin-bottom: 40px; }
  .pattern-head h1 {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 32px;
    letter-spacing: -0.03em;
    margin: 0 0 12px;
  }
  .pattern-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; }
  .pattern-sub .ct {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .pattern-sub .desc { font-size: 14px; line-height: 1.5; color: var(--ink-2); max-width: 60ch; }

  .status {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink-3);
    padding: 8px 0;
  }

  /* the entry stack */
  .stack { display: flex; flex-direction: column; gap: 16px; }
  .block {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 24px 26px 16px;
    animation: rise 440ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
    animation-delay: calc(var(--i) * 32ms);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) { .block { animation: none; } }

  .block-fields { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-name {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .field-value {
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* the lead facet reads as the entry's headline */
  .field.lead .field-value {
    font-size: 18px;
    line-height: 1.5;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  .field.lead .field-name { display: none; }
  .field:not(.long):not(.lead) {
    flex-direction: row;
    align-items: baseline;
    gap: 14px;
  }
  .field:not(.long):not(.lead) .field-name { padding-top: 1px; min-width: 96px; }

  .block-meta {
    display: flex;
    gap: 16px;
    align-items: baseline;
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.03em;
    color: var(--ink-3);
  }
  .block-meta .id { color: var(--ink-2); }
  .block-meta .author { margin-left: auto; }

  /* ---------- mobile ---------- */
  .topbar { display: none; }
  .scrim { display: none; }

  @media (max-width: 820px) {
    .shell { grid-template-columns: 1fr; }
    .topbar {
      grid-column: 1;
      display: flex;
      align-items: center;
      gap: 14px;
      height: 56px;
      padding: 0 16px;
      position: sticky;
      top: 0;
      z-index: 30;
      background: var(--paper);
      border-bottom: 1px solid var(--line-strong);
    }
    .menu-btn {
      width: 34px; height: 34px; border: 0; background: none; cursor: pointer;
      display: flex; flex-direction: column; justify-content: center; gap: 4px; padding: 6px;
    }
    .menu-btn span { display: block; height: 1.5px; background: var(--ink); border-radius: 2px; }
    .mobile-word { margin: 0; padding: 0; font-size: 16px; }
    .topbar-current {
      margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--ink-3);
    }
    .sidebar {
      position: fixed;
      top: 0; left: 0; bottom: 0;
      width: 290px;
      z-index: 40;
      transform: translateX(-102%);
      transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: 0 0 0 1px var(--line-strong);
    }
    .menu-open .sidebar { transform: none; }
    .menu-open .scrim {
      display: block;
      position: fixed; inset: 0; z-index: 35;
      background: rgba(20, 18, 14, 0.28);
      border: 0; cursor: pointer;
    }
    .main { grid-column: 1; }
    .cover { padding: 48px 22px 80px; }
    .pattern-view { padding: 32px 20px 100px; }
    .charter-row { grid-template-columns: 1fr; gap: 8px; }
    .pattern-head h1 { font-size: 26px; }
    .block { padding: 20px 18px 14px; }
  }

  @media (min-width: 821px) { .topbar { display: none; } }
</style>
