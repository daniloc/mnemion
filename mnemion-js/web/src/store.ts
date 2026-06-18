import { useSyncExternalStore } from 'react';

// Normalized live store. The point: an MCP change arrives as a granular delta and
// patches exactly one entry, so only the component subscribed to that entry
// re-renders — not the whole pattern. Container components subscribe to the
// (cheap) ordered id list; each Card subscribes to its single entry and is
// React.memo'd, so a status flip redraws one card's contents and nothing else.

export type Entry = Record<string, unknown> & { id: number };

interface PatternState {
  byId: Map<number, Entry>;
  ordered: Entry[];        // cached, stable reference until the set/order changes
  listVersion: number;
  entryListeners: Map<number, Set<() => void>>;
  listListeners: Set<() => void>;
}

function freshState(): PatternState {
  return { byId: new Map(), ordered: [], listVersion: 0, entryListeners: new Map(), listListeners: new Set() };
}

class LiveStore {
  private patterns = new Map<string, PatternState>();

  private ensure(p: string): PatternState {
    let s = this.patterns.get(p);
    if (!s) { s = freshState(); this.patterns.set(p, s); }
    return s;
  }

  private rebuild(s: PatternState) {
    s.ordered = [...s.byId.values()];
    s.listVersion++;
    s.listListeners.forEach((cb) => cb());
  }

  private notifyEntry(s: PatternState, id: number) {
    s.entryListeners.get(id)?.forEach((cb) => cb());
  }

  /** Replace a pattern's entries (initial load or coarse refetch). */
  load(pattern: string, entries: Entry[]) {
    const s = this.ensure(pattern);
    s.byId = new Map(entries.filter((e) => e && e.id != null).map((e) => [e.id, e]));
    this.rebuild(s);
    // wake every entry subscriber (values may have changed)
    for (const set of s.entryListeners.values()) set.forEach((cb) => cb());
  }

  has(pattern: string): boolean {
    return this.patterns.has(pattern);
  }

  /** Optimistically merge a patch into one entry (e.g. a drag changes status).
   *  The server's WS echo arrives moments later and overwrites with the truth. */
  patchEntry(pattern: string, id: number, patch: Record<string, unknown>) {
    const s = this.patterns.get(pattern);
    const cur = s?.byId.get(id);
    if (!s || !cur) return;
    s.byId.set(id, { ...cur, ...patch });
    this.rebuild(s);     // grouping may move the card to another column
    this.notifyEntry(s, id);
  }

  /** Apply a single granular change from the live socket. */
  applyDelta(d: { pattern: string; op: string; id: number; entry: Entry | null }) {
    const s = this.patterns.get(d.pattern);
    if (!s) return; // not loaded → nothing on screen depends on it
    const id = Number(d.id);
    const removing = d.op === 'archive' || (d.entry && (d.entry as any).archived_at);
    if (removing) {
      if (s.byId.delete(id)) this.rebuild(s);
      this.notifyEntry(s, id);
      return;
    }
    if (!d.entry) return;
    const existed = s.byId.has(id);
    s.byId.set(id, d.entry);
    // Rebuild the ordered list (new entries appear; grouping by a facet may move
    // a card between columns). Containers re-render cheaply; memo'd cards don't.
    this.rebuild(s);
    if (existed) this.notifyEntry(s, id);
  }

  // --- subscription surface for useSyncExternalStore ---
  subscribeList(pattern: string, cb: () => void): () => void {
    const s = this.ensure(pattern);
    s.listListeners.add(cb);
    return () => s.listListeners.delete(cb);
  }
  getOrdered(pattern: string): Entry[] {
    return this.patterns.get(pattern)?.ordered ?? EMPTY;
  }
  subscribeEntry(pattern: string, id: number, cb: () => void): () => void {
    const s = this.ensure(pattern);
    let set = s.entryListeners.get(id);
    if (!set) { set = new Set(); s.entryListeners.set(id, set); }
    set.add(cb);
    return () => { set!.delete(cb); if (set!.size === 0) s.entryListeners.delete(id); };
  }
  getEntry(pattern: string, id: number): Entry | undefined {
    return this.patterns.get(pattern)?.byId.get(id);
  }
}

const EMPTY: Entry[] = [];
export const store = new LiveStore();

/** Ordered entries for a pattern — re-renders only when the set/order changes. */
export function usePatternEntries(pattern: string): Entry[] {
  return useSyncExternalStore(
    (cb) => store.subscribeList(pattern, cb),
    () => store.getOrdered(pattern),
  );
}

/** A single entry — re-renders only when THAT entry changes. */
export function useEntry(pattern: string, id: number): Entry | undefined {
  return useSyncExternalStore(
    (cb) => store.subscribeEntry(pattern, id, cb),
    () => store.getEntry(pattern, id),
  );
}
