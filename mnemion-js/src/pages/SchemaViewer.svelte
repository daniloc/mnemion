<script lang="ts">
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
    conventions: string[];
    guidance: string;
  }

  let { patterns, conventions, guidance }: Props = $props();

  let selected: Pattern | null = $state(null);
  let filter = $state('');

  let visible = $derived(
    patterns.filter(p =>
      p.name.toLowerCase().includes(filter.toLowerCase())
    )
  );

  let kernel = $derived(visible.filter(p => p.name.startsWith('_')));
  let user = $derived(visible.filter(p => !p.name.startsWith('_')));
</script>

<div class="hive">
  <header>
    <h1>hive</h1>
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
              onclick={() => selected = pattern}
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
              onclick={() => selected = pattern}
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
        <div class="detail">
          <div class="detail-header">
            <h2>{selected.name}</h2>
            <span class="entry-count">{selected.entry_count} {selected.entry_count === 1 ? 'entry' : 'entries'}</span>
          </div>
          <p class="description">{selected.description}</p>

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
      {:else}
        <div class="empty">
          <p>select a pattern</p>
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

  h1 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #e8c872;
  }

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
    padding: 2rem 2.5rem;
    overflow-y: auto;
    max-height: calc(100vh - 90px);
  }

  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 60vh;
  }
  .empty p {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    color: #2a2a38;
  }

  .detail-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .detail h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.1rem;
    font-weight: 600;
    color: #e8c872;
    padding: 0;
    letter-spacing: 0.05em;
    text-transform: none;
  }

  .entry-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: #4a4a58;
  }

  .description {
    font-size: 0.88rem;
    color: #8a8a98;
    margin-bottom: 1.5rem;
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
  }

  td {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid #111118;
  }

  .facet-name { color: #c8c8d0; }
  .facet-type { color: #6a8a9a; }
  .facet-req { color: #e8c872; text-align: center; }
  .facet-default { color: #5a5a68; }
  .facet-link { color: #7a6a9a; }

  tr:hover td { background: #0e0e14; }
</style>
