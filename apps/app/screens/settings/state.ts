import { create } from "zustand";
import { loadAi, loadAssistants, type AiAccount, type Assistant } from "./data";
import { toggleAccount } from "./logic.js";

type Priv = { seal: boolean; ask: boolean; mem: boolean; ret: string };
type S = {
  ai: AiAccount[]; setBudget: (name: string, budget: number) => void; toggleAi: (name: string) => void;
  assistants: Assistant[]; setAutonomy: (id: string, v: string) => void; setPaused: (id: string, on: boolean) => void;
  priv: Priv; setPriv: (p: Partial<Priv>) => void;
  notify: Record<string, boolean>; setNotify: (k: string, on: boolean) => void;
  upd: { channel: string; auto: boolean; checked: boolean }; setUpd: (p: Partial<S["upd"]>) => void;
  newCode: boolean; setNewCode: (on: boolean) => void;
  pin: boolean; setPin: (on: boolean) => void;
};

export const useSettings = create<S>((set) => ({
  ai: loadAi(),
  setBudget: (name, budget) => set((s) => ({ ai: s.ai.map((a) => (a.name === name ? { ...a, budget } : a)) })),
  toggleAi: (name) => set((s) => ({ ai: s.ai.map((a) => (a.name === name ? toggleAccount(a) : a)) })),
  assistants: loadAssistants(),
  setAutonomy: (id, autonomy) => set((s) => ({ assistants: s.assistants.map((a) => (a.id === id ? { ...a, autonomy } : a)) })),
  setPaused: (id, paused) => set((s) => ({ assistants: s.assistants.map((a) => (a.id === id ? { ...a, paused } : a)) })),
  priv: { seal: true, ask: true, mem: true, ret: "1y" },
  setPriv: (p) => set((s) => ({ priv: { ...s.priv, ...p } })),
  notify: { need: true, flow: true, reveal: true, upd: false, quiet: true },
  setNotify: (k, on) => set((s) => ({ notify: { ...s.notify, [k]: on } })),
  upd: { channel: "stable", auto: true, checked: false },
  setUpd: (p) => set((s) => ({ upd: { ...s.upd, ...p } })),
  newCode: false,
  setNewCode: (newCode) => set({ newCode }),
  pin: false,
  setPin: (pin) => set({ pin }),
}));
