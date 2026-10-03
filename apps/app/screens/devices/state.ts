import { create } from "zustand";
import { loadAccess, loadDeviceSpaces, loadLend, type AccessItem } from "./data";

type S = {
  items: AccessItem[];
  devSpaces: Record<string, string[]>;
  faster: boolean;
  meLends: boolean;
  removeItem: (id: string) => void;
  addToSpace: (id: string, space: string) => void;
  removeFromSpace: (id: string, space: string) => void;
  setFaster: (on: boolean) => void;
  setLend: (on: boolean) => void;
  addDevice: (d: AccessItem, spaces: string[]) => void;
};

export const useDevices = create<S>((set) => ({
  items: loadAccess(),
  devSpaces: loadDeviceSpaces(),
  faster: true,
  meLends: false,
  removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  addToSpace: (id, sp) => set((s) => ({ devSpaces: { ...s.devSpaces, [id]: [...(s.devSpaces[id] ?? []), sp] } })),
  removeFromSpace: (id, sp) => set((s) => ({ devSpaces: { ...s.devSpaces, [id]: (s.devSpaces[id] ?? []).filter((x) => x !== sp) } })),
  setFaster: (faster) => set({ faster }),
  setLend: (meLends) => set({ meLends }),
  addDevice: (d, spaces) => set((s) => ({ items: [...s.items, d], devSpaces: { ...s.devSpaces, [d.id]: spaces } })),
}));

export const lendInfo = loadLend();
