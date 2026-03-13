<script lang="ts">
  import { browser } from './env.js';
  import { onMount, tick } from 'svelte';

  function focusOnMount(node: HTMLElement) {
    tick().then(() => node.focus());
  }
  import HiveMap from './HiveMap.svelte';
  import LinkMap from './LinkMap.svelte';

  interface Facet {
    name: string;
    type: string;
    required: boolean;
    default?: string | number | boolean | null;
    links?: string | null;
    readonly?: boolean;
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

  let { patterns, charter, guidance }: Props = $props();

  let selected: Pattern | null = $state(null);
  let filter = $state('');
  let entries: Record<string, unknown>[] = $state([]);
  let loadingEntries = $state(false);
  let selectedEntry: Record<string, unknown> | null = $state(null);
  let landingView: 'patterns' | 'links' | 'tools' = $state('patterns');

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
    editingDoctrine = false;
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

  // Live updates via WebSocket
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout>;

  function connectLive() {
    if (!browser) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'changed') {
          const changed: string[] = msg.patterns;
          // Schema change — reload the whole page to get fresh index
          if (changed.includes('_schema')) {
            location.reload();
            return;
          }
          // Refresh index (entry counts, etc.)
          try {
            const res = await fetch('/api/index');
            const idx = await res.json();
            patterns = idx.patterns;
            charter = idx.charter ?? {};
            // Update selected pattern reference if still viewing one
            if (selected) {
              const fresh = patterns.find(p => p.name === selected!.name);
              if (fresh) selected = fresh;
            }
          } catch { /* index refresh failed, not fatal */ }
          // If we're viewing a pattern that was mutated, re-fetch entries
          if (selected && changed.includes(selected.name)) {
            selectPattern(selected, selectedEntry ? String(selectedEntry.id) : undefined);
          }
        }
      } catch { /* ignore bad messages */ }
    };

    ws.onclose = () => {
      ws = null;
      reconnectTimer = setTimeout(connectLive, 3000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  // Restore from URL on mount + connect live
  onMount(() => {
    const { patternName, entryId } = parseHash();
    if (patternName) {
      const match = patterns.find(p => p.name === patternName);
      if (match) selectPattern(match, entryId);
    }
    connectLive();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  });

  const KERNEL_FIELDS = ['id', 'created_at', 'updated_at', 'archived_at', 'version'];

  // All facets + kernel columns for detail view
  let detailFields = $derived.by(() => {
    if (!selected || !selectedEntry) return [];
    const facetNames = selected.facets.map(f => f.name);
    return [...KERNEL_FIELDS, ...facetNames];
  });

  // Editing state — per-field inline editing
  let editingField: string | null = $state(null);
  let editData: Record<string, unknown> = $state({});
  let saving = $state(false);
  let editError: string | null = $state(null);

  let dirty = $derived.by(() => {
    if (!selectedEntry) return false;
    for (const key of Object.keys(editData)) {
      if (String(editData[key] ?? '') !== String(selectedEntry[key] ?? '')) return true;
    }
    return false;
  });

  function startFieldEdit(field: string) {
    if (!selectedEntry || !selected) return;
    // Seed editData with current values for all facets (only once per edit session)
    if (Object.keys(editData).length === 0) {
      for (const f of selected.facets) {
        editData[f.name] = selectedEntry[f.name] ?? '';
      }
    }
    editError = null;
    editingField = field;
  }

  function cancelEditing() {
    editingField = null;
    editData = {};
    editError = null;
  }

  // Doctrine editing
  let editingDoctrine = $state(false);
  let doctrineText = $state('');
  let savingDoctrine = $state(false);

  function startDoctrineEdit() {
    if (!selected) return;
    doctrineText = selected.doctrine || '';
    editingDoctrine = true;
  }

  async function saveDoctrine() {
    if (!selected || !browser) return;
    savingDoctrine = true;
    try {
      const res = await fetch('/api/evolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: `Set doctrine for ${selected.name}`,
          change: { type: 'set_doctrine', pattern_name: selected.name, doctrine: doctrineText },
        }),
      });
      const result = await res.json();
      if (!result.error) {
        selected.doctrine = doctrineText;
        editingDoctrine = false;
      }
    } catch {}
    savingDoctrine = false;
  }

  async function saveEditing() {
    if (!selectedEntry || !selected || !browser) return;
    saving = true;
    editError = null;
    try {
      const data: Record<string, unknown> = { id: selectedEntry.id };
      for (const f of selected.facets) {
        const val = editData[f.name];
        if (f.type === 'integer') data[f.name] = val === '' ? null : Number(val);
        else if (f.type === 'real') data[f.name] = val === '' ? null : Number(val);
        else if (f.type === 'boolean') data[f.name] = val === 'true' || val === true;
        else data[f.name] = val === '' ? null : val;
      }
      const res = await fetch(`/api/mutate/${selected.name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'update', data }),
      });
      const result = await res.json();
      if (result.error) {
        editError = result.message || 'Update failed';
      } else {
        editingField = null;
        editData = {};
      }
    } catch {
      editError = 'Network error';
    }
    saving = false;
  }

  function facetType(fieldName: string): string {
    if (!selected) return 'text';
    const f = selected.facets.find(f => f.name === fieldName);
    return f?.type ?? 'text';
  }

  function facetOptions(fieldName: string): string[] | undefined {
    if (!selected) return undefined;
    const f = selected.facets.find(f => f.name === fieldName);
    return f?.options;
  }

  function selectEntry(entry: Record<string, unknown>) {
    cancelEditing();
    selectedEntry = entry;
    if (selected) pushHash(selected.name, entry.id);
  }

  function deselectEntry() {
    cancelEditing();
    selectedEntry = null;
    if (selected) pushHash(selected.name);
  }
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

      {#if Object.keys(charter).length > 0}
        <section class="charter-section">
          <h2>charter</h2>
          {#each Object.entries(charter) as [key, value]}
            <div class="charter-entry">
              <div class="charter-key">{key}</div>
              <div class="charter-value">{value}</div>
            </div>
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
              {#if dirty || editError}
                <div class="detail-toolbar">
                  {#if editError}
                    <span class="edit-error">{editError}</span>
                  {:else}
                    <span></span>
                  {/if}
                  <div class="toolbar-actions">
                    <button class="toolbar-btn cancel" onclick={cancelEditing} disabled={saving}>cancel</button>
                    <button class="toolbar-btn save" onclick={saveEditing} disabled={saving}>
                      {saving ? 'saving…' : 'save'}
                    </button>
                  </div>
                </div>
              {/if}
              <div class="detail-scroll">
                {#each detailFields as field}
                  {@const val = selectedEntry[field]}
                  {@const isKernel = KERNEL_FIELDS.includes(field)}
                  {@const isFacetReadonly = selected.facets.some(f => f.name === field && f.readonly)}
                  {@const isReadonly = isKernel || isFacetReadonly}
                  {@const isEditing = editingField === field}
                  {#if facetType(field) === 'boolean' && !isReadonly}
                    <div class="field-row">
                      <span class="field-name">{field}{#if isFacetReadonly}<span class="lock-icon" title="read-only">&#x1f512;</span>{/if}</span>
                      <input
                        type="checkbox"
                        class="field-checkbox"
                        checked={editData[field] != null ? (editData[field] === true || editData[field] === 'true') : (val === 1 || val === true || val === 'true')}
                        onchange={(e) => {
                          if (!selectedEntry || !selected) return;
                          if (Object.keys(editData).length === 0) {
                            for (const f of selected.facets) editData[f.name] = selectedEntry[f.name] ?? '';
                          }
                          editData[field] = e.currentTarget.checked;
                        }}
                      />
                    </div>
                  {:else if facetType(field) === 'select' && !isReadonly}
                    {@const opts = facetOptions(field) ?? []}
                    <div class="field-row">
                      <span class="field-name">{field}</span>
                      <select
                        class="field-select"
                        value={editData[field] != null ? String(editData[field]) : String(val ?? '')}
                        onchange={(e) => {
                          if (!selectedEntry || !selected) return;
                          if (Object.keys(editData).length === 0) {
                            for (const f of selected.facets) editData[f.name] = selectedEntry[f.name] ?? '';
                          }
                          editData[field] = e.currentTarget.value;
                        }}
                      >
                        {#each opts as opt}
                          <option value={opt}>{opt}</option>
                        {/each}
                      </select>
                    </div>
                  {:else if isEditing && !isReadonly}
                    {@const ft = facetType(field)}
                    <div class="field-row">
                      <span class="field-name">{field}</span>
                      {#if ft === 'integer' || ft === 'real'}
                        <input
                          class="field-input"
                          type="number"
                          step={ft === 'real' ? 'any' : '1'}
                          value={editData[field] ?? ''}
                          oninput={(e) => { editData[field] = e.currentTarget.value; }}
                          onblur={() => { editingField = null; }}
                          onkeydown={(e) => { if (e.key === 'Escape') { editingField = null; } }}
                          use:focusOnMount
                        />
                      {:else}
                        <textarea
                          class="field-input field-textarea"
                          oninput={(e) => { editData[field] = e.currentTarget.value; }}
                          onblur={() => { editingField = null; }}
                          onkeydown={(e) => { if (e.key === 'Escape') { editingField = null; } }}
                          use:focusOnMount
                        >{String(editData[field] ?? '')}</textarea>
                      {/if}
                    </div>
                  {:else if val != null && facetType(field) !== 'boolean' && facetType(field) !== 'select'}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="field-row"
                      class:editable={!isReadonly}
                      ondblclick={() => { if (!isReadonly) startFieldEdit(field); }}
                    >
                      <span class="field-name">{field}{#if isFacetReadonly}<span class="lock-icon" title="read-only">&#x1f512;</span>{/if}</span>
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
                  {#if editingDoctrine}
                    <div class="doctrine-edit">
                      <textarea
                        class="doctrine-textarea"
                        bind:value={doctrineText}
                        onkeydown={(e) => { if (e.key === 'Escape') { editingDoctrine = false; } }}
                        use:focusOnMount
                      ></textarea>
                      <div class="doctrine-actions">
                        <button class="toolbar-btn cancel" onclick={() => { editingDoctrine = false; }} disabled={savingDoctrine}>cancel</button>
                        <button class="toolbar-btn save" onclick={saveDoctrine} disabled={savingDoctrine}>
                          {savingDoctrine ? 'saving…' : 'save'}
                        </button>
                      </div>
                    </div>
                  {:else}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <p class="doctrine" class:empty={!selected.doctrine} ondblclick={startDoctrineEdit}>
                      {selected.doctrine || 'no doctrine — double-click to set'}
                    </p>
                  {/if}
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

  .charter-entry {
    padding: 0.35rem 1rem;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .charter-entry + .charter-entry { margin-top: 0.25rem; }
  .charter-key {
    color: #a89044;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .charter-value {
    color: #8a8a98;
    margin-top: 0.1rem;
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
    position: relative;
  }

  .detail-scroll {
    overflow-y: auto;
    height: 100%;
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

  .doctrine {
    font-size: 0.75rem;
    color: #e8c872;
    line-height: 1.4;
    margin-top: 0.3rem;
    padding: 0.3rem 0.4rem;
    border-left: 2px solid #e8c87233;
    cursor: pointer;
  }
  .doctrine.empty {
    color: #3a3a48;
    font-style: italic;
  }

  .doctrine-edit {
    margin-top: 0.3rem;
  }
  .doctrine-textarea {
    width: 100%;
    min-height: 3rem;
    background: #0d0d12;
    color: #e8c872;
    border: 1px solid #e8c87255;
    border-radius: 3px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    padding: 0.4rem;
    resize: vertical;
  }
  .doctrine-textarea:focus { border-color: #e8c872; outline: none; }
  .doctrine-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.3rem;
    justify-content: flex-end;
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

  .lock-icon {
    font-size: 0.6rem;
    margin-left: 4px;
    opacity: 0.5;
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

  .field-row.editable { cursor: text; }
  .field-row.editable:hover .field-value {
    outline: 1px dashed #2a2a38;
    outline-offset: 2px;
    border-radius: 3px;
  }

  /* Editing */
  .detail-toolbar {
    position: absolute;
    top: 0.75rem;
    right: 2rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 1;
  }

  .toolbar-actions {
    display: flex;
    gap: 0.5rem;
  }

  .toolbar-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 0.35rem 0.8rem;
    border: 1px solid #2a2a38;
    border-radius: 4px;
    background: #12121a;
    color: #8a8a98;
    cursor: pointer;
    transition: all 0.1s;
  }
  .toolbar-btn:hover { border-color: #3a3a48; color: #c8c8d0; }
  .toolbar-btn:disabled { opacity: 0.4; cursor: default; }

  .toolbar-btn.save {
    background: #e8c872;
    color: #0a0a0c;
    border-color: #e8c872;
  }
  .toolbar-btn.save:hover { background: #f0d888; }
  .toolbar-btn.save:disabled { background: #6a5a30; border-color: #6a5a30; }

  .edit-error {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: #d46a6a;
    padding: 0.5rem 2rem 0;
  }

  .field-input {
    flex: 1;
    min-width: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    color: #c8c8d0;
    background: transparent;
    border: 1px solid #2a2a38;
    border-radius: 3px;
    padding: 0;
    margin: -1px;
    outline: none;
    transition: border-color 0.15s;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .field-input:focus { border-color: #e8c872; }

  .field-textarea {
    resize: vertical;
    min-height: 1.5em;
    field-sizing: content;
  }

  .field-checkbox {
    accent-color: #e8c872;
    width: 14px;
    height: 14px;
    cursor: pointer;
  }

  .field-select {
    flex: 1;
    background: #0d0d12;
    color: #c8c8d0;
    border: 1px solid #2a2a35;
    border-radius: 3px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    padding: 0.25rem 0.4rem;
    cursor: pointer;
  }
  .field-select:focus { border-color: #e8c872; outline: none; }
</style>
