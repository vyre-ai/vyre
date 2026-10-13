// The types Customize edits, as the kernel stores them (kernel/contracts/fields.d.ts TypeDefinition). Real: records.types read and records.define diffs, so the vyred decides what is allowed and a
// refusal puts the type back and says why. A mock build keeps the same edits in memory.
import { create } from "zustand";
import { allowsMock, showToast, useStore } from "@vyre/ui";
import { isOwn } from "./real-model.js";

export type Def = { name: string; label: string; icon?: string; fields: any[]; stages?: { name: string }[]; groups?: { name: string; collapsed?: boolean }[]; [k: string]: unknown };
type S = { defs: Def[]; /** Types being set up or changed in Records right now (a type on Twenty takes about a minute): name to its label. */ busy: Record<string, string>; loading: boolean; error: string; load: (space?: string) => Promise<void>; save: (d: Def) => void; create: (d: Def) => void };

const real = () => !allowsMock();
/** Writes go one after another: each is the whole type as the person left it, so a later one is never overtaken by an earlier. */
let tail: Promise<unknown> = Promise.resolve();
const say = (e: unknown) => (e instanceof Error ? e.message : "That did not save.");

export const useKernelTypes = create<S>((set, get) => {
  const done = (name: string) => set((s) => { const { [name]: _x, ...rest } = s.busy; return { busy: rest }; });
  const apply = (d: Def, next: Def[], diff: unknown, before: Def[]) => {
    set({ defs: next });
    if (!real()) return;
    set((s) => ({ busy: { ...s.busy, [d.name]: d.label } }));
    // It finishes in the background: a screen may be left meanwhile, and the list updates when the store answers.
    tail = tail.catch(() => {}).then(() => useStore().define(diff as any)).then(() => get().load()).then(() => showToast(`${d.label} is set up.`)).catch((e) => { set({ defs: before }); showToast(say(e)); }).finally(() => done(d.name));
  };
  return {
    defs: [],
    busy: {},
    loading: true,
    error: "",
    async load(space) {
      set({ loading: true, error: "" });
      try { set({ defs: ((await useStore().types(space)) as Def[]).filter(isOwn), loading: false }); } catch (e) { set({ loading: false, error: say(e) }); }
    },
    save(d) { const before = get().defs; apply(d, before.map((x) => (x.name === d.name ? d : x)), { change_types: [d] }, before); },
    create(d) { const before = get().defs; apply(d, [...before, d], { add_types: [d] }, before); },
  };
});
