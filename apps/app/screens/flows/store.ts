// What the Flows screens agree on in one session: whether @Engineer's proposal is applied, and which Kits are installed or updated.
// A real source replaces `flowsRepo`; the apply and install calls then go to it.
import { create } from "zustand";
import { flowsRepo, type KitCard } from "./data";

type S = {
  applied: boolean; setApplied: (a: boolean) => void;
  /** Flows switched off in this session, by id. A Flow is on unless it is here. */
  off: Record<string, boolean>; setOn: (id: string, on: boolean) => void;
  installed: KitCard[]; updated: boolean; install: (k: KitCard) => void; update: () => void;
};
const base = flowsRepo.kits();
export const useFlowsState = create<S>((set) => ({
  applied: false, setApplied: (applied) => set({ applied }),
  off: {}, setOn: (id, on) => set((s) => ({ off: { ...s.off, [id]: !on } })),
  installed: base.installed, updated: false,
  install: (k) => set((s) => (s.installed.some((x) => x.id === k.id) ? s : { installed: [...s.installed, k] })),
  update: () => set((s) => ({ updated: true, installed: s.installed.map((k) => (k.id === "estate" ? { ...k, v: 4, adds: { ...k.adds, roles: 2 } } : k)) })),
}));
