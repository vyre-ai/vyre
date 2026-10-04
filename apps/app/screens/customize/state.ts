// The types Customize shows. In a mock build they are the sample world, edited in memory. Everywhere else they are the vyred's own definitions
// (records.types), and every change is one records.define diff: the screen changes at once, the vyred answers (with the person's presence
// where it asks for it), and a refusal puts the type back and says why.
import { create } from "zustand";
import { allowsMock, showToast, useStore } from "@vyre/ui";
import { loadTypes } from "./data";
import type { TypeDef } from "./logic.js";
import { diffFor, isOwn, toTypeDef } from "./real-model.js";

type S = { types: TypeDef[]; loading: boolean; error: string; load: (space?: string) => Promise<void>; update: (t: TypeDef) => void; add: (t: TypeDef) => void };

/** The kernel's definitions as last read, by type name: what a change is applied onto. */
let kernel: Record<string, unknown> = {};
const real = () => !allowsMock();
const say = (e: unknown) => (e instanceof Error ? e.message : "That did not save.");

export const useTypes = create<S>((set, get) => ({
  types: real() ? [] : loadTypes(),
  loading: real(),
  error: "",
  async load(want) {
    if (!real()) return;
    set({ loading: true, error: "" });
    try {
      const store = useStore();
      const [spaces, defs] = await Promise.all([store.spaces(), store.types(want)]);
      kernel = Object.fromEntries(defs.map((t: any) => [t.name, t]));
      const space = want ?? (spaces[0] as any)?.id ?? "";
      set({ types: defs.filter(isOwn).map((t: any) => toTypeDef(t, space)), loading: false });
    } catch (e) { set({ loading: false, error: say(e) }); }
  },
  update(t) {
    const before = get().types;
    set({ types: before.map((x) => (x.id === t.id ? t : x)) });
    if (!real()) return;
    useStore().define(diffFor(t, kernel[t.id]) as any).then(() => get().load()).catch((e) => { set({ types: before }); showToast(say(e)); });
  },
  add(t) {
    const before = get().types;
    set({ types: [...before, t] });
    if (!real()) return;
    useStore().define(diffFor(t, undefined) as any).then(() => get().load()).catch((e) => { set({ types: before }); showToast(say(e)); });
  },
}));
