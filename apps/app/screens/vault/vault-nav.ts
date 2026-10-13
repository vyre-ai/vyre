// The Vault's navigation, shared by the sidebar's Vault panel (Mine and Space, the groups, Expiring, Shared with me) and the page (the list it shows): which vault is open, which pick narrows it, and the
// counts the page last worked out. A store, so the two can sit in different parts of the shell and still agree.
import { create } from "zustand";
import { ALL, type Nav } from "./redesign.js";
import type { Scope } from "./redesign-data";

/** The width at which the shell shows the Vault as a sidebar panel (the same as Files); narrower, and on a phone, the page keeps its own Mine and Space switch. */
export const VAULT_PANEL_MIN = 760;

export type Counts = { all: number; groups: Record<string, number>; expiring: number; shared: number };
export const NO_COUNTS: Counts = { all: 0, groups: {}, expiring: 0, shared: 0 };

type State = {
  scope: Scope; nav: Nav; counts: Counts;
  setScope: (s: Scope) => void;
  setNav: (n: Nav) => void;
  setCounts: (c: Counts) => void;
};

export const useVaultNav = create<State>((set) => ({
  scope: "mine", nav: ALL, counts: NO_COUNTS,
  // another vault is another list: the pick starts over
  setScope: (scope) => set((s) => (s.scope === scope ? s : { scope, nav: ALL, counts: NO_COUNTS })),
  setNav: (nav) => set({ nav }),
  setCounts: (counts) => set({ counts }),
}));
