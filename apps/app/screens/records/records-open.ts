// Records opens at once (stale while revalidate, the pattern Home uses in screens/now/home-world.ts): the last copy of this Space's type paints from the device's view cache, the first page
// and its count are read beside the types in one round trip, and the whole world (every type, for links, search, boards and the tabs' counts) is read behind them and replaces both in place.
// The tab after this one is read ahead when the screen is idle, so switching to it opens from a copy too. The packing rules (what is kept, never a sealed value) are ui/views/records-cache.js.
import { useEffect, useRef, useState } from "react";
import { allowsMock, useRecordsWorld, useStore } from "@vyre/ui";
import type { RecordsWorld } from "../../ui/views/shared";
import { viewCache } from "../../src/state/cache";
import { callT } from "../../src/real/call-tool";
import { afterPaint, perf } from "../../src/perf";
import { useSpaces } from "../shell/state";
import { FIRST_PAGE, nextTab, packOpen, pickRecords, recordsKey, unpackOpen, worldFromPage } from "../../ui/views/records-cache.js";
import { isHiddenType } from "../../ui/views/logic.js";

/** This visit's copies, so a tab opened again in the same visit draws in the same frame, before the view cache answers. */
const memory = new Map<string, RecordsWorld>();
/** How long after a fresh answer the copy is written, so a burst of box events writes once. */
const SAVE_MS = 800;
/** How long the screen is left alone before the next tab is read ahead. */
const IDLE_MS = 1500;

type Page = { rows?: any[]; total?: number | null };

/** One type's first page with its count (records.list count: true): the box answers both in one call, the count from the store's own count, never a scan. */
async function firstPage(type: string, filter?: object): Promise<Page | null> {
  const r = await callT<Page>("records.list", { type, limit: FIRST_PAGE, count: true, ...(filter ? { filter } : {}) });
  return r.data && Array.isArray(r.data.rows) ? r.data : null;
}

/**
 * The records world Records draws, with whether it is a copy (`stale`: the whole world has not answered yet) and where it came from. `filters` as useRecordsWorld takes them.
 * The reload, the error and the loading flag are the whole world's.
 */
export function useRecordsOpen(type: string, filters?: Record<string, object | undefined>) {
  const real = !allowsMock();
  const store = useStore();
  const space = useSpaces((s) => s.space);
  const key = recordsKey(space, type);
  const full = useRecordsWorld(filters);
  const filter = filters?.[type];
  const [kept, setKept] = useState<{ key: string; world: RecordsWorld } | null>(() => (memory.has(key) ? { key, world: memory.get(key)! } : null));
  const [page, setPage] = useState<{ key: string; world: RecordsWorld } | null>(null);
  const answered = useRef(false);
  answered.current = full.data !== undefined;
  const opened = useRef<{ key: string; at: number; drawn: boolean }>({ key, at: perf.now(), drawn: false });
  if (opened.current.key !== key) opened.current = { key, at: perf.now(), drawn: false };

  // 1. the kept copy: this visit's first, then the device's
  useEffect(() => {
    if (!real) return;
    const m = memory.get(key);
    if (m) { setKept({ key, world: m }); return; }
    let live = true;
    void viewCache.get(key).then((raw) => {
      const w = unpackOpen(raw, type) as RecordsWorld | null;
      if (live && w && !answered.current) { memory.set(key, w); setKept({ key, world: w }); }
    });
    return () => { live = false; };
  }, [real, key, type]);

  // 2. the types, the first page with its count and the people, at once; skipped when the whole world is already here (a tab switch inside a loaded visit)
  useEffect(() => {
    if (!real || answered.current) return;
    let live = true;
    void Promise.all([
      Promise.resolve(store.types()).catch(() => null),
      firstPage(type, filter),
      Promise.resolve(store.actors()).catch(() => undefined),
      Promise.resolve((store as { me?: () => Promise<string> }).me?.()).catch(() => undefined),
    ]).then(([types, p, actors, me]) => {
      if (!live || answered.current || !types || !p) return;
      const shown = (types as any[]).filter((t) => !isHiddenType(t));
      setPage({ key, world: worldFromPage({ type, types: shown, rows: p.rows ?? [], total: p.total, actors: actors as any[] | undefined, me: me ?? undefined }, memory.get(key)) as RecordsWorld });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, key, type, JSON.stringify(filter ?? null)]);

  const picked = pickRecords(full.data, page && page.key === key ? page.world : null, kept && kept.key === key ? kept.world : null);

  // the open, measured from the screen asking to the first frame with rows on it (the perf lane's records.open; records.open.kept when that frame was the kept copy)
  useEffect(() => {
    if (!perf.on || !picked.world || opened.current.drawn) return;
    opened.current.drawn = true;
    const { at } = opened.current, from = picked.from;
    afterPaint((t) => { perf.record("records.open", t - at); if (from === "kept") perf.record("records.open.kept", t - at); });
  }, [picked.world, picked.from]);

  // 3. keep what was drawn, under the Space and type showing when it came: the whole world when it is here, else the first page
  const keyNow = useRef(key);
  keyNow.current = key;
  const source = full.data ?? (page && page.key === key ? page.world : undefined);
  useEffect(() => {
    if (!real || !source) return;
    const k = keyNow.current, t = type;
    const timer = setTimeout(() => {
      const packed = packOpen(source, t);
      memory.set(k, unpackOpen(packed, t) as RecordsWorld);
      void viewCache.set(k, packed);
      // with every type here, the next tab's copy costs nothing: it is kept now
      if (!source.partial) {
        const n = nextTab(source.types.filter((x: any) => !x.hidden_in_records), t);
        if (n) { const nk = recordsKey(space, n); const np = packOpen(source, n); memory.set(nk, unpackOpen(np, n) as RecordsWorld); void viewCache.set(nk, np); }
      }
    }, SAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, source]);

  // 4. read ahead: while only a page is here, the next tab's first page is read when the screen is idle, and kept
  const types = picked.world?.types;
  useEffect(() => {
    if (!real || !types || answered.current) return;
    const n = nextTab(types.filter((x: any) => !x.hidden_in_records), type);
    if (!n) return;
    const nk = recordsKey(space, n);
    if (memory.has(nk)) return;
    let live = true;
    const timer = setTimeout(() => {
      void firstPage(n).then((p) => {
        if (!live || !p || memory.has(nk)) return;
        const w = worldFromPage({ type: n, types, rows: p.rows ?? [], total: p.total, actors: picked.world?.actors, me: picked.world?.me }, picked.world);
        const packed = packOpen(w, n);
        memory.set(nk, unpackOpen(packed, n) as RecordsWorld);
        void viewCache.set(nk, packed);
      });
    }, IDLE_MS);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, types, type, space]);

  if (!real) return { data: full.data, stale: false, from: full.data ? "box" : "none", loading: full.loading, error: full.error, reload: full.reload };
  return { data: picked.world, stale: picked.stale, from: picked.from, loading: full.loading && !picked.world, error: full.error, reload: full.reload };
}
