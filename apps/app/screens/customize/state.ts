import { create } from "zustand";
import { loadTypes } from "./data";
import type { TypeDef } from "./logic.js";

type S = { types: TypeDef[]; update: (t: TypeDef) => void; add: (t: TypeDef) => void };

export const useTypes = create<S>((set) => ({
  types: loadTypes(),
  update: (t) => set((s) => ({ types: s.types.map((x) => (x.id === t.id ? t : x)) })),
  add: (t) => set((s) => ({ types: [...s.types, t] })),
}));
