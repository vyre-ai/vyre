// The types Customize edits, as the kernel stores them (kernel/contracts/fields.d.ts TypeDefinition). Real: records.types read and records.define diffs, so the vyred decides what is allowed and a
// refusal puts the type back and says why. A mock build keeps the same edits in memory.
import { create } from "zustand";
import { allowsMock, showToast, useStore } from "@vyre/ui";
import { isOwn } from "./real-model.js";

export type Def = { name: string; label: string; icon?: string; fields: any[]; stages?: { name: string }[]; groups?: { name: string; collapsed?: boolean }[]; [k: string]: unknown };
type S = { defs: Def[]; loading: boolean; error: string; load: (space?: string) => Promise<void>; save: (d: Def) => void; create: (d: Def) => void };

const real = () => !allowsMock();
const say = (e: unknown) => (e instanceof Error ? e.message : "That did not save.");

export const useKernelTypes = create<S>((set, get) => {
  const apply = (next: Def[], diff: unknown, before: Def[]) => {
    set({ defs: next });
    if (!real()) return;
    useStore().define(diff as any).then(() => get().load()).catch((e) => { set({ defs: before }); showToast(say(e)); });
  };
  return {
    defs: [],
    loading: true,
    error: "",
    async load(space) {
      set({ loading: true, error: "" });
      try { set({ defs: ((await useStore().types(space)) as Def[]).filter(isOwn), loading: false }); } catch (e) { set({ loading: false, error: say(e) }); }
    },
    save(d) { const before = get().defs; apply(before.map((x) => (x.name === d.name ? d : x)), { change_types: [d] }, before); },
    create(d) { const before = get().defs; apply([...before, d], { add_types: [d] }, before); },
  };
});
