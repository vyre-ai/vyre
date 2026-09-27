import { create } from "zustand";

/** One row waiting on the user (a Gate item, an ask, a grant). Filled by the spike. */
export type Need = { id: string; kind: string; summary: string; at: number };

type NeedsState = { items: Need[]; set: (items: Need[]) => void };

const useNeedsStore = create<NeedsState>()((set) => ({
  items: [],
  set: (items) => set({ items }),
}));

// Read the store only through selector hooks, so a screen re-renders on the slice it shows.
export const useNeeds = () => useNeedsStore((s) => s.items);
export const useNeedsCount = () => useNeedsStore((s) => s.items.length);
export const setNeeds = (items: Need[]) => useNeedsStore.getState().set(items);
