// What the Flows screens agree on in one session: whether @Engineer's proposal is applied, and which Kits are installed or updated.
// A real source replaces `flowsRepo`; the apply and install calls then go to it.
import { create } from "zustand";
import { flowsRepo, type KitCard } from "./data";

type S = {
  applied: boolean; setApplied: (a: boolean) => void;
  installed: KitCard[]; updated: boolean; install: (k: KitCard) => void; update: () => void;
};
const base = flowsRepo.kits();
export const useFlowsState = create<S>((set) => ({
  applied: false, setApplied: (applied) => set({ applied }),
  installed: base.installed, updated: false,
  install: (k) => set((s) => (s.installed.some((x) => x.id === k.id) ? s : { installed: [...s.installed, k] })),
  update: () => set((s) => ({ updated: true, installed: s.installed.map((k) => (k.id === "estate" ? { ...k, v: 4, adds: { ...k.adds, roles: 2 } } : k)) })),
}));
