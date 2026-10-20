import { create } from "zustand";

/** The looks people chose in their Space profiles, by lower-case name: set by the app when it reads a Space's profiles, read by every person's face drawn with no look of its own (a chat message, a member row), so a person looks the same wherever their name shows. */
export const usePersonLooks = create<{ looks: Record<string, string>; set: (looks: Record<string, string>) => void }>((set) => ({ looks: {}, set: (looks) => set({ looks }) }));
