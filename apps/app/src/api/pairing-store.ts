// The pairing store both platforms share: the list (pairing-list.ts) kept as one text under `vyre.relay.pairings` in whatever keyed store the platform has (the secure store on a phone, localStorage in a
// browser). A device that was paired before several servers were allowed keeps the single record under `vyre.relay.pairing`: it is read as a list of one, and the first change writes the list and removes the old
// key. Changes run one at a time (a read-change-write of two saves at once would lose one). A store that throws is an empty list; a save that fails is not an error the person can act on.
import type { Pairing } from "./pairing";
import { activePairing, addPairing, listPairings as listOf, pairingFor, readPairings, removePairing, setActive, writePairings, type Pairings } from "./pairing-list";

export const LIST_KEY = "vyre.relay.pairings";
export const OLD_KEY = "vyre.relay.pairing";

export type KeyedText = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; del(key: string): Promise<void> };

export function makePairingStore(io: KeyedText) {
  let chain: Promise<unknown> = Promise.resolve();
  /** One change at a time, in the order asked; a failed one does not stop the next. */
  const inOrder = <T>(f: () => Promise<T>): Promise<T> => { const r = chain.then(f, f); chain = r.catch(() => {}); return r; };

  async function loadPairings(): Promise<Pairings> {
    try {
      const now = await io.get(LIST_KEY);
      return readPairings(now ?? (await io.get(OLD_KEY)));
    } catch { return readPairings(null); }
  }
  async function write(l: Pairings): Promise<void> {
    try {
      if (!listOf(l).length) { await io.del(LIST_KEY); await io.del(OLD_KEY); return; }
      await io.set(LIST_KEY, writePairings(l));
      await io.del(OLD_KEY);
    } catch { /* nothing kept; the person pairs again */ }
  }
  const change = (f: (l: Pairings) => Pairings) => inOrder(async () => { await write(f(await loadPairings())); });

  return {
    loadPairings,
    listPairings: async (): Promise<Pairing[]> => listOf(await loadPairings()),
    /** The active server's pairing: what every caller that reads "the" pairing gets. */
    loadPairing: async (): Promise<Pairing | null> => activePairing(await loadPairings()),
    loadPairingFor: async (box: string): Promise<Pairing | null> => pairingFor(await loadPairings(), box),
    /** Add a server (or replace its record); null forgets the active one. */
    savePairing: (p: Pairing | null): Promise<void> => change((l) => (p ? addPairing(l, p) : l.active ? removePairing(l, l.active) : l)),
    removePairingFor: (box: string): Promise<void> => change((l) => removePairing(l, box)),
    setActivePairing: (box: string): Promise<void> => change((l) => setActive(l, box)),
  };
}
