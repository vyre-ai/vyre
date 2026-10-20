import { create } from "zustand";

/** The Space the shell is showing (the shell writes it). A person is in one Space at a time, so Now and Projects show that Space only; "all" is only what a list says before the Space is known, or when the data does not name that Space. A store of its own so the pages Now pushes keep the same Space. */
const store = create<{ space: string; setScope: (s: string) => void }>((set) => ({ space: "all", setScope: (space) => set({ space: space || "all" }) }));

/** The Space whose things are shown: the shell's Space when the data has it, else everything the data holds (a single-Space world). */
export const scopeIn = (world: { spaces: { id: string }[] }, space: string): string => (space && world.spaces.some((s) => s.id === space) ? space : "all");

export const useNowScope = (world?: { spaces: { id: string }[] }): { scope: string; setScope: (s: string) => void } => {
  const { space, setScope } = store();
  return { scope: world ? scopeIn(world, space) : space, setScope };
};
export const setNowScope = (space: string) => store.getState().setScope(space);
