// Which space a place is showing: all of them, Mine, or one shared space. One value for every place, so switching it in Memory
// is still switched in Vault. The shell's space switcher can write here later; until then each place shows the same bar.
import { create } from "zustand";

export type SpaceId = "mine" | "juniper";
export type Scope = "all" | SpaceId;

export const SPACES: Record<SpaceId, { name: string }> = { mine: { name: "Mine" }, juniper: { name: "Juniper Studio" } };

export const useScope = create<{ scope: Scope; setScope: (s: Scope) => void }>((set) => ({ scope: "all", setScope: (scope) => set({ scope }) }));

/** True when a thing in space `sp` is visible under `scope`. */
export const inScope = (scope: Scope, sp: SpaceId): boolean => scope === "all" || sp === scope;
