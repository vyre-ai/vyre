// The pairings a device keeps: one per server it is paired to, keyed by the server's box id (Pairing.box), with one active. The active one is the fallback for a call that names no server and no Space
// (every caller that reads "the" pairing still gets one); each call that names a server or a Space is routed by src/real/server-route.js. Pure, so Node tests it; relay.native.ts and relay.web.ts only
// hold the text (the secure store on a phone, localStorage in a browser).
import { readPairing, type Pairing } from "./pairing";

export type Pairings = { v: 2; items: Record<string, Pairing>; active: string | null };

const empty = (): Pairings => ({ v: 2, items: {}, active: null });

/** A stored list, checked. The older single record (what a device paired before several servers is allowed to keep) reads as a list of one. A record that fails its check is dropped, never the others. */
export function readPairings(json: string | null | undefined): Pairings {
  if (!json) return empty();
  let v: any;
  try { v = JSON.parse(json); } catch { return empty(); }
  if (!v || typeof v !== "object") return empty();
  if (v.v === 2 && v.items && typeof v.items === "object") {
    const items: Record<string, Pairing> = {};
    for (const [k, raw] of Object.entries(v.items)) {
      const p = readPairing(JSON.stringify(raw));
      if (p && p.box === k) items[k] = p;
    }
    const ids = Object.keys(items);
    return { v: 2, items, active: typeof v.active === "string" && items[v.active] ? v.active : ids[0] ?? null };
  }
  const one = readPairing(json);
  return one ? { v: 2, items: { [one.box]: one }, active: one.box } : empty();
}

export const writePairings = (l: Pairings): string => JSON.stringify(l);

export const listPairings = (l: Pairings): Pairing[] => Object.values(l.items);
export const activePairing = (l: Pairings): Pairing | null => (l.active ? l.items[l.active] ?? null : null);
export const pairingFor = (l: Pairings, box: string): Pairing | null => l.items[box] ?? null;

/** Add a server, or replace the record of one already there. The first server added is active; a later one never takes it. */
export function addPairing(l: Pairings, p: Pairing): Pairings {
  const items = { ...l.items, [p.box]: p };
  return { v: 2, items, active: l.active && l.items[l.active] ? l.active : p.box };
}

/** Make a server the fallback. An id that is not in the list changes nothing. */
export const setActive = (l: Pairings, box: string): Pairings => (l.items[box] && l.active !== box ? { ...l, active: box } : l);

/** Forget a server. If it was active the next one is, and the last one leaves none. An id that is not there changes nothing. */
export function removePairing(l: Pairings, box: string): Pairings {
  if (!l.items[box]) return l;
  const { [box]: _gone, ...items } = l.items;
  const ids = Object.keys(items);
  return { v: 2, items, active: l.active === box ? ids[0] ?? null : l.active };
}
