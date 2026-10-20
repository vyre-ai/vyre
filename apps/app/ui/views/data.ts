// What the generated views read: every type, every record of every type (a link shows its target's title, a contact lists its matters), the actors.
// One world per filter, shared by every screen that shows it (world-share.js), kept current by the store's changes, so a screen keeps no copy of its own and two screens never read it twice.
import { useEffect, useMemo, useState } from "react";
import { useStoreQuery } from "../store";
import { getStore } from "../../src/store-core/store.js";
import type { Store } from "../../src/store-core/contracts.js";
import type { FieldEnv } from "../fields/types";
import { isHiddenType, linkIndex } from "./logic.js";
import { tally } from "../tags/model.js";
import { filtersKey, listQuery } from "./world-load.js";
import { createShare } from "./world-share.js";
import type { RecordsWorld } from "./shared";

type Filters = Record<string, object | undefined> | undefined;
type Share = {
  state(): { data: RecordsWorld | undefined; error: Error | null; loading: boolean };
  subscribe(f: () => void): () => void;
  changed(h?: { type?: string; soon?: boolean }): void;
  reload(): Promise<void>;
  users(): number;
};

/** Every type the views show, every record of each, the people and who "me" is. The people and "me" do not wait on the types, and the lists are read four at a time. */
async function readAll(s: Store, filters: Filters): Promise<RecordsWorld> {
  const actorsP = Promise.resolve(s.actors());
  const meP = Promise.resolve((s as { me?: () => Promise<string> }).me?.()).catch(() => "");
  actorsP.catch(() => undefined);
  const types = (await s.types()).filter((t: any) => !isHiddenType(t));
  // At most four types are read at a time: every type at once put a dozen full reads on the box together, and the first page the screen asked for beside them waited behind all of them.
  const lists: any[][] = new Array(types.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, types.length) }, async () => {
    while (next < types.length) { const i = next++; lists[i] = await s.list(types[i].name, listQuery(types[i].name, filters)); }
  }));
  return { types: types as any[], byType: Object.fromEntries(types.map((t: any, i: number) => [t.name, lists[i]])) as Record<string, any[]>, actors: (await actorsP) as any[], me: (await meP) ?? "" };
}

/** The same world with the named types read again: a record written here or a record event from the box touches one type, so only that type's list is read. */
async function readTypes(s: Store, filters: Filters, prev: RecordsWorld, types: string[]): Promise<RecordsWorld> {
  const lists = await Promise.all(types.map((t) => s.list(t, listQuery(t, filters))));
  return { ...prev, byType: { ...prev.byType, ...Object.fromEntries(types.map((t, i) => [t, lists[i]])) } };
}

/** The current store, or null where there is none yet (the app before it is paired). */
const storeNow = (): Store | null => { try { return getStore(); } catch { return null; } };

const shares = new Map<string, { store: Store | null; share: Share; stop: (() => void) | null }>();

/** The shared world for a filter, made for the store in use (a new store, a test's or the lab's, gets a new one). */
function shareFor(key: string, filters: Filters) {
  const store = storeNow();
  const had = shares.get(key);
  if (had && had.store === store && store) return had;
  had?.stop?.();
  const share = createShare({
    readAll: () => readAll(getStore(), filters),
    readTypes: (prev: RecordsWorld, types: string[]) => readTypes(getStore(), filters, prev, types),
    has: (w: RecordsWorld, t: string) => w.types.some((x: any) => x.name === t),
  }) as unknown as Share;
  const entry = { store, share, stop: null as (() => void) | null };
  shares.set(key, entry);
  return entry;
}

/** `filters` names a records.list filter for a type, so the box cuts that one list (the Notes a person wrote); every other type, and every caller that names none, reads whole. */
export function useRecordsWorld(filters?: Record<string, object | undefined>) {
  const key = filtersKey(filters);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entry = useMemo(() => shareFor(key, filters), [key]);
  const [, redraw] = useState(0);
  useEffect(() => {
    const off = entry.share.subscribe(() => redraw((n) => n + 1));
    // the store's changes reach the world while any screen shows it
    if (!entry.stop && entry.store) entry.stop = entry.store.subscribe((h) => entry.share.changed(h));
    return () => {
      off();
      if (!entry.share.users() && entry.stop) { entry.stop(); entry.stop = null; }
    };
  }, [entry]);
  const st = entry.share.state();
  return { data: st.data, loading: st.loading, error: st.error, reload: entry.share.reload };
}

/** The Event log filtered to one record: who, what, when, why. */
export function useRecordEvents(urn: string | undefined) {
  return useStoreQuery<any[]>((s) => (urn ? s.events({ record: urn }) : []), [urn]);
}

/** The env every field renderer on a screen gets: who the actors are, what a link points at, the clock, where a link goes. */
export function useFieldEnv(world: RecordsWorld | undefined, open: (urn: string) => void, openTag?: (tag: string) => void): FieldEnv {
  // a partial world (Records opening from its kept copy) brings the titles its rows point at; the records it holds add theirs
  return useMemo(() => ({ actors: world?.actors ?? [], me: world?.me, links: world ? { ...(world.links ?? {}), ...linkIndex(world.types, world.byType) } : {}, now: Date.now(), open, openTag, tags: world ? spaceTags(world) : [] }), [world, open, openTag]);
}

/** Every tag the Space's records carry, most used first (the suggestions of a tag field and the picks of a tag filter). */
export const spaceTags = (world: RecordsWorld): string[] => tally(Object.values(world.byType).flat()).map((t) => t.tag);
