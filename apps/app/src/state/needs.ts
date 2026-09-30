import { create } from "zustand";
import type { Need } from "./needs-model";

export type { Need } from "./needs-model";

/** The Undo toast: the newest answer still in its window. */
export type Toast = { id: string; label: string; until: number } | null;

type NeedsState = {
  /** Everything waiting, oldest first, as the box (or the cache) last said. */
  items: readonly Need[];
  /** Where `items` came from: nothing yet, this device's cache, or the box. */
  from: "none" | "cache" | "box";
  /** Rows answered and not drawn (held for Undo, sending, done). */
  hidden: ReadonlySet<string>;
  /** Rows back from a refusal, with the reason. */
  refused: ReadonlyMap<string, string>;
  toast: Toast;
};

const useNeedsStore = create<NeedsState>()(() => ({
  items: [],
  from: "none",
  hidden: new Set<string>(),
  refused: new Map<string, string>(),
  toast: null,
}));

// Read the store only through selector hooks, so a screen re-renders on the slice it shows.
export const useNeeds = () => useNeedsStore((s) => s.items);
export const useNeedsFrom = () => useNeedsStore((s) => s.from);
export const useHidden = () => useNeedsStore((s) => s.hidden);
export const useRefused = () => useNeedsStore((s) => s.refused);
export const useToast = () => useNeedsStore((s) => s.toast);
/** What the tab's dot and the badge count: waiting and not already answered. */
export const useNeedsCount = () => useNeedsStore((s) => s.items.filter((n) => !s.hidden.has(n.id)).length);
export const useNeed = (id: string) => useNeedsStore((s) => s.items.find((n) => n.id === id) ?? null);

export const needsStore = {
  get: useNeedsStore.getState,
  set: useNeedsStore.setState,
};

export const setNeeds = (items: readonly Need[], from: "cache" | "box" = "box") => useNeedsStore.setState({ items, from });
