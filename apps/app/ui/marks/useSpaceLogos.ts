import { create } from "zustand";

/** The logos people gave their spaces, by space id: set once by the shell, read by every SpaceTile, so a space looks the same wherever it shows without each screen passing its logo down. */
export const useSpaceLogos = create<{ logos: Record<string, string>; set: (logos: Record<string, string>) => void }>((set) => ({ logos: {}, set: (logos) => set({ logos }) }));
