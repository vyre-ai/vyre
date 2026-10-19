// What the generated views read: every type, every record of every type (a link shows its target's title, a contact lists its matters), the actors.
// One query against the Store (ui/store.ts), re-run whenever the store reports a change, so a screen keeps no copy of its own.
import { useMemo } from "react";
import { useStoreQuery } from "../store";
import type { FieldEnv } from "../fields/types";
import { isHiddenType, linkIndex } from "./logic.js";
import { tally } from "../tags/model.js";
import { filtersKey, listQuery } from "./world-load.js";
import type { RecordsWorld } from "./shared";

/** `filters` names a records.list filter for a type, so the box cuts that one list (the Notes a person wrote); every other type, and every caller that names none, reads whole. */
export function useRecordsWorld(filters?: Record<string, object | undefined>) {
  return useStoreQuery<RecordsWorld>(async (s) => {
    const types = (await s.types()).filter((t: any) => !isHiddenType(t));
    const lists = await Promise.all(types.map((t: any) => s.list(t.name, listQuery(t.name, filters))));
    return { types: types as any[], byType: Object.fromEntries(types.map((t: any, i: number) => [t.name, lists[i]])) as Record<string, any[]>, actors: (await s.actors()) as any[], me: await (s as { me?: () => Promise<string> }).me?.().catch(() => "") };
  }, [filtersKey(filters)]);
}

/** The Event log filtered to one record: who, what, when, why. */
export function useRecordEvents(urn: string | undefined) {
  return useStoreQuery<any[]>((s) => (urn ? s.events({ record: urn }) : []), [urn]);
}

/** The env every field renderer on a screen gets: who the actors are, what a link points at, the clock, where a link goes. */
export function useFieldEnv(world: RecordsWorld | undefined, open: (urn: string) => void, openTag?: (tag: string) => void): FieldEnv {
  return useMemo(() => ({ actors: world?.actors ?? [], me: world?.me, links: world ? linkIndex(world.types, world.byType) : {}, now: Date.now(), open, openTag, tags: world ? spaceTags(world) : [] }), [world, open, openTag]);
}

/** Every tag the Space's records carry, most used first (the suggestions of a tag field and the picks of a tag filter). */
export const spaceTags = (world: RecordsWorld): string[] => tally(Object.values(world.byType).flat()).map((t) => t.tag);
