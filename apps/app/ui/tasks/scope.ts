import { create } from "zustand";

/** Which space Now shows ("all", or a space id). A store of its own so the pages Now pushes (the rest of Needs you, everything running) keep the same scope. */
export const useNowScope = create<{ scope: string; setScope: (s: string) => void }>((set) => ({ scope: "all", setScope: (scope) => set({ scope }) }));
