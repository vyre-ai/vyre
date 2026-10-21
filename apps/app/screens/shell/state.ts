// Which space is showing, and each space's look. Appearance writes the looks; the layout applies the showing space's look to the theme.
import { create } from "zustand";
import { allowsMock, setWorldSpace } from "@vyre/ui";
import { DEFAULT_LOOKS, type SpaceLook } from "./spaces.js";

type S = {
  space: string;
  looks: Record<string, SpaceLook>;
  setShowing: (id: string) => void;
  setLook: (id: string, patch: Partial<SpaceLook>) => void;
};

export const useSpaces = create<S>((set) => ({
  // Always one Space (DESIGN-one-space-menu.md): empty only until the first list lands, then the last one used or the first.
  space: allowsMock() ? "mine" : "",
  looks: DEFAULT_LOOKS,
  setShowing: (space) => set({ space }),
  setLook: (id, patch) => set((s) => ({ looks: { ...s.looks, [id]: { ...(s.looks[id] ?? DEFAULT_LOOKS.mine), ...patch } } })),
}));

// The records world is kept per Space: it follows the Space showing.
setWorldSpace(useSpaces.getState().space);
useSpaces.subscribe((s) => setWorldSpace(s.space));
