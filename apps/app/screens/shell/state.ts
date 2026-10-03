// Which space is showing, and each space's look. Appearance writes the looks; the layout applies the showing space's look to the theme.
import { create } from "zustand";
import { DEFAULT_LOOKS, type SpaceLook } from "./spaces.js";

type S = {
  space: string;
  looks: Record<string, SpaceLook>;
  setShowing: (id: string) => void;
  setLook: (id: string, patch: Partial<SpaceLook>) => void;
};

export const useSpaces = create<S>((set) => ({
  space: "all",
  looks: DEFAULT_LOOKS,
  setShowing: (space) => set({ space }),
  setLook: (id, patch) => set((s) => ({ looks: { ...s.looks, [id]: { ...s.looks[id], ...patch } } })),
}));
