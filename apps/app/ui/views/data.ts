// What the generated views read: every type, every record of every type (a link shows its target's title, a contact lists its matters), the actors.
// One query against the Store (ui/store.ts), re-run whenever the store reports a change, so a screen keeps no copy of its own.
import { useMemo } from "react";
import { useStoreQuery } from "../store";
import type { FieldEnv } from "../fields/types";
import { linkIndex } from "./logic.js";
import type { RecordsWorld } from "./shared";

export function useRecordsWorld() {
  return useStoreQuery<RecordsWorld>(async (s) => {
    const types = await s.types();
    const lists = await Promise.all(types.map((t: any) => s.list(t.name)));
    return { types: types as any[], byType: Object.fromEntries(types.map((t: any, i: number) => [t.name, lists[i]])) as Record<string, any[]>, actors: (await s.actors()) as any[], me: await (s as { me?: () => Promise<string> }).me?.().catch(() => "") };
  }, []);
}

/** The Event log filtered to one record: who, what, when, why. */
export function useRecordEvents(urn: string | undefined) {
  return useStoreQuery<any[]>((s) => (urn ? s.events({ record: urn }) : []), [urn]);
}

/** The env every field renderer on a screen gets: who the actors are, what a link points at, the clock, where a link goes. */
export function useFieldEnv(world: RecordsWorld | undefined, open: (urn: string) => void): FieldEnv {
  return useMemo(() => ({ actors: world?.actors ?? [], links: world ? linkIndex(world.types, world.byType) : {}, now: Date.now(), open }), [world, open]);
}
