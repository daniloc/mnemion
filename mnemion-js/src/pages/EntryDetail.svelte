<script lang="ts">
  import { tick } from 'svelte';

  function focusOnMount(node: HTMLElement) {
    tick().then(() => node.focus());
  }

  interface Facet {
    name: string;
    type: string;
    required: boolean;
    default?: string | number | boolean | null;
    links?: string | null;
    readonly?: boolean;
    options?: string[];
  }

  interface Props {
    patternName: string;
    facets: Facet[];
    entry: Record<string, unknown>;
    onsave?: (entry: Record<string, unknown>) => void;
  }

  let { patternName, facets, entry, onsave }: Props = $props();

  const KERNEL_FIELDS = ['id', 'created_at', 'updated_at', 'archived_at', 'version'];

  let detailFields = $derived.by(() => {
    const facetNames = facets.map(f => f.name);
    return [...KERNEL_FIELDS, ...facetNames];
  });

  let editingField: string | null = $state(null);
  let editData: Record<string, unknown> = $state({});
  let saving = $state(false);
  let editError: string | null = $state(null);

  let dirty = $derived.by(() => {
    for (const key of Object.keys(editData)) {
      if (String(editData[key] ?? '') !== String(entry[key] ?? '')) return true;
    }
    return false;
  });

  function seedEditData() {
    if (Object.keys(editData).length === 0) {
      for (const f of facets) {
        editData[f.name] = entry[f.name] ?? '';
      }
    }
  }

  function startFieldEdit(field: string) {
    seedEditData();
    editError = null;
    editingField = field;
  }

  function cancelEditing() {
    editingField = null;
    editData = {};
    editError = null;
  }

  async function saveEditing() {
    saving = true;
    editError = null;
    try {
      // Only send fields that were actually edited (dirty), not all facets
      const data: Record<string, unknown> = { id: entry.id };
      for (const f of facets) {
        if (!(f.name in editData)) continue;
        const val = editData[f.name];
        if (String(val ?? '') === String(entry[f.name] ?? '')) continue; // unchanged
        if (f.type === 'integer') data[f.name] = val === '' ? null : Number(val);
        else if (f.type === 'real') data[f.name] = val === '' ? null : Number(val);
        else if (f.type === 'boolean') data[f.name] = val === 'true' || val === true;
        else data[f.name] = val === '' ? null : val;
      }
      if (Object.keys(data).length <= 1) { // only id, nothing to update
        editingField = null;
        editData = {};
        return;
      }
      const res = await fetch(`/api/mutate/${patternName}`, {
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
        if (onsave) onsave(result.entry);
      }
    } catch {
      editError = 'Network error';
    }
    saving = false;
  }

  function facetType(fieldName: string): string {
    return facets.find(f => f.name === fieldName)?.type ?? 'text';
  }

  function facetOptions(fieldName: string): string[] | undefined {
    return facets.find(f => f.name === fieldName)?.options;
  }
</script>

<div class="entry-detail-component">
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
          {saving ? 'saving\u2026' : 'save'}
        </button>
      </div>
    </div>
  {/if}
  <div class="detail-scroll">
    {#each detailFields as field}
      {@const val = entry[field]}
      {@const isKernel = KERNEL_FIELDS.includes(field)}
      {@const isFacetReadonly = facets.some(f => f.name === field && f.readonly)}
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
              seedEditData();
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
              seedEditData();
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
</div>

<style>
  .entry-detail-component {
    position: relative;
    height: 100%;
    min-height: 0;
  }

  .detail-toolbar {
    position: absolute;
    top: 0.75rem;
    right: 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 1;
  }

  .toolbar-actions { display: flex; gap: 0.5rem; }

  .toolbar-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em;
    padding: 0.35rem 0.8rem;
    border: 1px solid #2a2a38; border-radius: 4px;
    background: #12121a; color: #8a8a98;
    cursor: pointer; transition: all 0.1s;
  }
  .toolbar-btn:hover { border-color: #3a3a48; color: #c8c8d0; }
  .toolbar-btn:disabled { opacity: 0.4; cursor: default; }
  .toolbar-btn.save { background: #e8c872; color: #0a0a0c; border-color: #e8c872; }
  .toolbar-btn.save:hover { background: #f0d888; }
  .toolbar-btn.save:disabled { background: #6a5a30; border-color: #6a5a30; }

  .edit-error {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem; color: #d46a6a;
  }

  .detail-scroll {
    overflow-y: auto;
    height: 100%;
    padding: 0.75rem 1.5rem 1.5rem;
  }

  .field-row {
    display: flex; gap: 1.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #111118;
    align-items: baseline;
  }

  .field-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem; font-weight: 600;
    color: #6a6a78; min-width: 140px; flex-shrink: 0;
  }

  .lock-icon { font-size: 0.6rem; margin-left: 4px; opacity: 0.5; }

  .field-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem; color: #c8c8d0;
    word-break: break-word; white-space: pre-wrap; line-height: 1.5;
  }
  .field-value.long { font-size: 0.78rem; color: #9a9aa8; }

  .field-row.editable { cursor: text; }
  .field-row.editable:hover .field-value {
    outline: 1px dashed #2a2a38; outline-offset: 2px; border-radius: 3px;
  }

  .field-input {
    flex: 1; min-width: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem; color: #c8c8d0;
    background: transparent; border: 1px solid #2a2a38; border-radius: 3px;
    padding: 0; margin: -1px; outline: none;
    transition: border-color 0.15s; line-height: 1.5;
    word-break: break-word; white-space: pre-wrap;
  }
  .field-input:focus { border-color: #e8c872; }

  .field-textarea { resize: vertical; min-height: 1.5em; field-sizing: content; }

  .field-checkbox { accent-color: #e8c872; width: 14px; height: 14px; cursor: pointer; }

  .field-select {
    flex: 1; background: #0d0d12; color: #c8c8d0;
    border: 1px solid #2a2a35; border-radius: 3px;
    font-family: 'JetBrains Mono', monospace; font-size: 0.65rem;
    padding: 0.25rem 0.4rem; cursor: pointer;
  }
  .field-select:focus { border-color: #e8c872; outline: none; }
</style>
