// What the Flows screens agree on in one session: whether @Engineer's proposal is applied, and which Kits are installed or updated.
// A real source replaces `flowsRepo`; the apply and install calls then go to it.
import { create } from "zustand";
import { flowsRepo, type KitCard } from "./data";
import type { FlowDraft, Group } from "@vyre/ui";
// @ts-ignore a plain .js module
import { ATP_DRAFT, REFUND_DRAFT, REMINDER_DRAFT } from "./starters.js";

export type MadeFlow = { id: string; draft: FlowDraft };

type S = {
  applied: boolean; setApplied: (a: boolean) => void;
  /** Flows switched off in this session, by id. A Flow is on unless it is here. */
  off: Record<string, boolean>; setOn: (id: string, on: boolean) => void;
  installed: KitCard[]; updated: boolean; install: (k: KitCard) => void; update: () => void;
  /** Flows made in the builder (sample build only; a real one is on the box). The two starters come first. */
  made: MadeFlow[]; saveMade: (id: string | null, d: FlowDraft) => string;
  /** The groups of the Flows list, and which group each Flow is in (presentation only). */
  /** Sample build only: who each Flow is shared with, by Flow id then person or role, as "use" or "edit". */
  shares: Record<string, Record<string, string>>; setShare: (id: string, who: string, level: string) => void;
  groups: Group[]; groupOf: Record<string, string>; setGroups: (g: Group[], of: Record<string, string>) => void;
};
const base = flowsRepo.kits();
export const useFlowsState = create<S>((set) => ({
  applied: false, setApplied: (applied) => set({ applied }),
  off: { reminder: true }, setOn: (id, on) => set((s) => ({ off: { ...s.off, [id]: !on } })),
  made: [{ id: "refund", draft: REFUND_DRAFT }, { id: "atp", draft: ATP_DRAFT }, { id: "reminder", draft: REMINDER_DRAFT }],
  saveMade: (id, draft) => {
    const key = id ?? `flow-${Date.now().toString(36)}`;
    set((s) => ({ made: s.made.some((m) => m.id === key) ? s.made.map((m) => (m.id === key ? { id: key, draft } : m)) : [...s.made, { id: key, draft }], groupOf: draft.group ? { ...s.groupOf, [key]: draft.group } : s.groupOf }));
    return key;
  },
  shares: {}, setShare: (id, who, level) => set((s) => ({ shares: { ...s.shares, [id]: { ...(s.shares[id] ?? {}), [who]: level } } })),
  groups: [{ name: "Clients" }, { name: "Money" }, { name: "Operations" }],
  groupOf: { refund: "Money", atp: "Clients", reminder: "Clients", payment: "Money", intake: "Operations", engagement: "Operations", engineer: "Money" },
  setGroups: (groups, groupOf) => set({ groups, groupOf }),
  installed: base.installed, updated: false,
  install: (k) => set((s) => (s.installed.some((x) => x.id === k.id) ? s : { installed: [...s.installed, k] })),
  update: () => set((s) => ({ updated: true, installed: s.installed.map((k) => (k.id === "estate" ? { ...k, v: 4, adds: { ...k.adds, roles: 2 } } : k)) })),
}));
