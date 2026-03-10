<script lang="ts">
  import { browser } from './env.js';
  import { onMount } from 'svelte';
  import HiveMap from './HiveMap.svelte';
  import LinkMap from './LinkMap.svelte';

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
    latest_activity?: string | null;
  }

  interface Props {
    patterns: Pattern[];
    conventions: string[];
    guidance: string;
  }

  let { patterns, conventions, guidance }: Props = $props();

  let selected: Pattern | null = $state(null);
  let filter = $state('');
  let entries: Record<string, unknown>[] = $state([]);
  let loadingEntries = $state(false);
  let selectedEntry: Record<string, unknown> | null = $state(null);
  let landingView: 'patterns' | 'links' = $state('patterns');

  let visible = $derived(
    patterns.filter(p =>
      p.name.toLowerCase().includes(filter.toLowerCase())
    )
  );

  let kernel = $derived(visible.filter(p => p.name.startsWith('_')));
  let user = $derived(visible.filter(p => !p.name.startsWith('_')));

  // Determine which facet to use as the "name" for list cells
  function entryLabel(entry: Record<string, unknown>): string {
    if (!selected) return String(entry.id);
    // Try 'name', 'title', then first text facet
    for (const key of ['name', 'title']) {
      if (entry[key] && typeof entry[key] === 'string') return entry[key] as string;
    }
    const firstText = selected.facets.find(f => f.type === 'text');
    if (firstText && entry[firstText.name]) return String(entry[firstText.name]);
    return `${selected.name} #${entry.id}`;
  }

  function formatDate(val: unknown): string {
    if (!val) return '';
    const d = new Date(String(val));
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function pushHash(patternName?: string, entryId?: unknown) {
    if (!browser) return;
    const hash = patternName
      ? entryId != null ? `#${patternName}/${entryId}` : `#${patternName}`
      : '';
    history.replaceState(null, '', hash || location.pathname);
  }

  async function selectPattern(pattern: Pattern, restoreEntryId?: string) {
    selected = pattern;
    entries = [];
    selectedEntry = null;
    if (!restoreEntryId) pushHash(pattern.name);
    if (!browser) return;
    loadingEntries = true;
    try {
      const res = await fetch(`/api/query/${pattern.name}`);
      const data = await res.json();
      entries = data.entries || [];
      if (restoreEntryId) {
        const match = entries.find(e => String(e.id) === restoreEntryId);
        if (match) {
          selectedEntry = match;
          pushHash(pattern.name, match.id);
        } else {
          pushHash(pattern.name);
        }
      }
    } catch {
      entries = [];
    }
    loadingEntries = false;
  }

  function selectEntry(entry: Record<string, unknown>) {
    selectedEntry = entry;
    if (selected) pushHash(selected.name, entry.id);
  }

  function deselectEntry() {
    selectedEntry = null;
    if (selected) pushHash(selected.name);
  }

  function showMap() {
    selected = null;
    entries = [];
    selectedEntry = null;
    pushHash();
  }

  function parseHash(): { patternName?: string; entryId?: string } {
    if (!browser) return {};
    const hash = location.hash.slice(1);
    if (!hash) return {};
    const [patternName, entryId] = hash.split('/');
    return { patternName, entryId };
  }

  // Restore from URL on mount
  onMount(() => {
    const { patternName, entryId } = parseHash();
    if (patternName) {
      const match = patterns.find(p => p.name === patternName);
      if (match) selectPattern(match, entryId);
    }
  });

  // All facets + kernel columns for detail view
  let detailFields = $derived.by(() => {
    if (!selected || !selectedEntry) return [];
    const kernelFields = ['id', 'created_at', 'updated_at', 'archived_at'];
    const facetNames = selected.facets.map(f => f.name);
    return [...kernelFields, ...facetNames];
  });
</script>

<div class="hive">
  <header>
    <button class="hive-title" onclick={showMap}><h1>hive</h1></button>
    <p class="guidance">{guidance}</p>
  </header>

  <div class="layout">
    <nav>
      <input
        class="filter"
        type="text"
        placeholder="filter patterns…"
        bind:value={filter}
      />

      {#if user.length > 0}
        <section>
          <h2>patterns</h2>
          {#each user as pattern (pattern.name)}
            <button
              class="pattern-item"
              class:active={selected?.name === pattern.name}
              onclick={() => selectPattern(pattern)}
            >
              <span class="name">{pattern.name}</span>
              <span class="count">{pattern.entry_count}</span>
            </button>
          {/each}
        </section>
      {/if}

      {#if kernel.length > 0}
        <section>
          <h2>kernel</h2>
          {#each kernel as pattern (pattern.name)}
            <button
              class="pattern-item kernel"
              class:active={selected?.name === pattern.name}
              onclick={() => selectPattern(pattern)}
            >
              <span class="name">{pattern.name}</span>
              <span class="count">{pattern.entry_count}</span>
            </button>
          {/each}
        </section>
      {/if}

      {#if conventions.length > 0}
        <section>
          <h2>conventions</h2>
          {#each conventions as c}
            <p class="convention">{c}</p>
          {/each}
        </section>
      {/if}
    </nav>

    <main>
      {#if selected}
        <div class="split">
          <div class="entry-list">
            <div class="list-header">
              <h2>{selected.name}</h2>
              <span class="entry-count">{selected.entry_count} {selected.entry_count === 1 ? 'entry' : 'entries'}</span>
            </div>

            {#if loadingEntries}
              <p class="status">loading…</p>
            {:else if entries.length === 0}
              <p class="status">no entries</p>
            {:else}
              <div class="list-scroll">
                {#each entries as entry (entry.id)}
                  <button
                    class="entry-item"
                    class:active={selectedEntry?.id === entry.id}
                    onclick={() => selectEntry(entry)}
                  >
                    <span class="entry-label">{entryLabel(entry)}</span>
                    <span class="entry-meta">{entry.id} · {formatDate(entry.updated_at)}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="entry-detail">
            {#if selectedEntry}
              <button class="back-to-schema" onclick={() => deselectEntry()}>← schema</button>
              <div class="detail-scroll">
                {#each detailFields as field}
                  {@const val = selectedEntry[field]}
                  {#if val != null}
                    <div class="field-row">
                      <span class="field-name">{field}</span>
                      <span class="field-value" class:long={String(val).length > 120}>{String(val)}</span>
                    </div>
                  {/if}
                {/each}
              </div>
            {:else}
              <div class="schema-pane">
                <div class="schema-header">
                  <h3>schema</h3>
                  <p class="description">{selected.description}</p>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>facet</th>
                      <th>type</th>
                      <th>req</th>
                      <th>default</th>
                      <th>link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each selected.facets as f (f.name)}
                      <tr>
                        <td class="facet-name">{f.name}</td>
                        <td class="facet-type">{f.type}</td>
                        <td class="facet-req">{f.required ? '●' : ''}</td>
                        <td class="facet-default">{f.default ?? ''}</td>
                        <td class="facet-link">{f.links ?? ''}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="hive-landing">
          <div class="landing-toggle">
            <button class:active={landingView === 'patterns'} onclick={() => { landingView = 'patterns'; }}>patterns</button>
            <button class:active={landingView === 'links'} onclick={() => { landingView = 'links'; }}>links</button>
          </div>
          {#if landingView === 'links'}
            <LinkMap {patterns} onselect={(pn, eid) => { const p = patterns.find(x => x.name === pn); if (p) selectPattern(p, eid); }} />
          {:else}
            <HiveMap {patterns} onselect={(p) => selectPattern(p)} />
          {/if}
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;500;700&display=swap');

  :global(*) { margin: 0; padding: 0; box-sizing: border-box; }
  :global(body) {
    font-family: 'DM Sans', system-ui, sans-serif;
    background: #0a0a0c;
    color: #c8c8d0;
    -webkit-font-smoothing: antialiased;
  }

  .hive {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    padding: 2rem 2.5rem 1.5rem;
    border-bottom: 1px solid #1a1a22;
  }

  .hive-title {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  h1 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #e8c872;
    transition: opacity 0.15s;
  }
  .hive-title:hover h1 { opacity: 0.7; }

  .guidance {
    margin-top: 0.4rem;
    font-size: 0.85rem;
    color: #6a6a78;
    font-style: italic;
  }

  .layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    flex: 1;
    min-height: 0;
  }

  nav {
    border-right: 1px solid #1a1a22;
    padding: 1rem 0;
    overflow-y: auto;
    max-height: calc(100vh - 90px);
  }

  .filter {
    display: block;
    width: calc(100% - 2rem);
    margin: 0 1rem 1rem;
    padding: 0.5rem 0.75rem;
    background: #12121a;
    border: 1px solid #1a1a22;
    border-radius: 6px;
    color: #c8c8d0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    outline: none;
    transition: border-color 0.15s;
  }
  .filter:focus { border-color: #e8c872; }
  .filter::placeholder { color: #3a3a48; }

  section { margin-bottom: 1.5rem; }

  h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #4a4a58;
    padding: 0 1rem;
    margin-bottom: 0.5rem;
  }

  .pattern-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 0.5rem 1rem;
    border: none;
    background: none;
    color: #c8c8d0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }
  .pattern-item:hover { background: #14141e; }
  .pattern-item.active {
    background: #1a1a28;
    color: #e8c872;
  }
  .pattern-item.kernel .name { color: #6a6a78; }
  .pattern-item.kernel.active .name { color: #e8c872; }

  .count {
    font-size: 0.7rem;
    color: #3a3a48;
    min-width: 2rem;
    text-align: right;
  }
  .active .count { color: #a89044; }

  .convention {
    padding: 0.35rem 1rem;
    font-size: 0.78rem;
    color: #5a5a68;
    line-height: 1.4;
  }

  main {
    min-height: 0;
    max-height: calc(100vh - 90px);
  }

  .hive-landing {
    height: calc(100vh - 90px);
    width: 100%;
    display: flex;
    flex-direction: column;
  }

  .landing-toggle {
    display: flex;
    gap: 0;
    border-bottom: 1px solid #1a1a22;
    flex-shrink: 0;
  }

  .landing-toggle button {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.6rem 1.2rem;
    border: none;
    background: none;
    color: #4a4a58;
    cursor: pointer;
    transition: color 0.1s;
  }
  .landing-toggle button:hover { color: #c8c8d0; }
  .landing-toggle button.active {
    color: #e8c872;
    box-shadow: inset 0 -2px 0 #e8c872;
  }

  /* Split view */
  .split {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 90px);
  }

  .entry-list {
    height: 33.33%;
    border-bottom: 1px solid #1a1a22;
    display: flex;
    flex-direction: column;
  }

  .list-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 1.25rem 2rem 0.75rem;
    flex-shrink: 0;
  }

  .list-header h2 {
    font-size: 0.85rem;
    color: #e8c872;
    padding: 0;
    text-transform: none;
    letter-spacing: 0.05em;
  }

  .entry-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: #4a4a58;
  }

  .list-scroll {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .entry-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.6rem 2rem;
    border: none;
    background: none;
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
    gap: 0.15rem;
  }
  .entry-item:hover { background: #14141e; }
  .entry-item.active { background: #1a1a28; }

  .entry-label {
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 0.88rem;
    font-weight: 500;
    color: #c8c8d0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-item.active .entry-label { color: #e8c872; }

  .entry-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: #4a4a58;
  }

  .status {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: #3a3a48;
    padding: 1rem 2rem;
  }

  /* Entry detail */
  .entry-detail {
    height: 66.67%;
    min-height: 0;
  }

  .back-to-schema {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: #6a6a78;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.75rem 2rem 0;
    display: block;
    transition: color 0.1s;
  }
  .back-to-schema:hover { color: #e8c872; }

  .detail-scroll {
    overflow-y: auto;
    height: calc(100% - 2rem);
    padding: 0.75rem 2rem 1.5rem;
  }

  .schema-pane {
    overflow-y: auto;
    height: 100%;
    padding: 1.5rem 2rem;
  }

  .schema-header {
    margin-bottom: 1.25rem;
  }

  .schema-header h3 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #4a4a58;
    margin-bottom: 0.4rem;
  }

  .description {
    font-size: 0.85rem;
    color: #6a6a78;
    line-height: 1.5;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #4a4a58;
    text-align: left;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid #1a1a22;
    white-space: nowrap;
  }

  td {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid #111118;
  }

  .facet-name { color: #c8c8d0; }
  .facet-type { color: #6a8a9a; }
  .facet-req { color: #e8c872; text-align: center; width: 3rem; }
  th:nth-child(3) { text-align: center; width: 3rem; }
  .facet-default { color: #5a5a68; }
  .facet-link { color: #7a6a9a; }

  tr:hover td { background: #0e0e14; }

  .field-row {
    display: flex;
    gap: 1.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #111118;
    align-items: baseline;
  }

  .field-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    font-weight: 600;
    color: #6a6a78;
    min-width: 140px;
    flex-shrink: 0;
  }

  .field-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    color: #c8c8d0;
    word-break: break-word;
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .field-value.long {
    font-size: 0.78rem;
    color: #9a9aa8;
  }
</style>
