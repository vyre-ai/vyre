import { create } from "zustand";
import { MOCK, said, tool } from "../../src/real/box";
import { loadAccess, loadDeviceSpaces, loadLend, SPACE_NAMES, type AccessItem } from "./data";
import { deviceRows, deviceSpaces, spaceNames } from "./real.js";

type S = {
  items: AccessItem[];
  devSpaces: Record<string, string[]>;
  spaceNames: Record<string, string>;
  faster: boolean;
  meLends: boolean;
  /** Real mode: the box's answer is loading, or the words for why it could not be read. */
  loading: boolean;
  error: string | null;
  /** Read the device list and the spaces from the box (a no-op for the sample). */
  load: () => Promise<void>;
  /** Remove a device. Real: the box removes it (it needs the person present) and the list reloads; throws the box's words. */
  removeItem: (id: string) => Promise<void>;
  addToSpace: (id: string, space: string) => void;
  removeFromSpace: (id: string, space: string) => void;
  setFaster: (on: boolean) => void;
  setLend: (on: boolean) => void;
  addDevice: (d: AccessItem, spaces: string[]) => void;
};

export const useDevices = create<S>((set, get) => ({
  items: MOCK ? loadAccess() : [],
  devSpaces: MOCK ? loadDeviceSpaces() : {},
  spaceNames: MOCK ? SPACE_NAMES : {},
  faster: true,
  meLends: false,
  loading: !MOCK,
  error: null,
  async load() {
    if (MOCK) return;
    set({ loading: true });
    try {
      const [devices, spaces] = await Promise.all([tool("relay.devices.list"), tool("spaces.list").catch(() => [])]);
      const items = deviceRows(devices);
      const names = spaceNames(spaces);
      set({ items, spaceNames: names, devSpaces: deviceSpaces(items.map((i) => i.id), names), error: null });
    } catch (e) {
      set({ error: said(e) });
    } finally {
      set({ loading: false });
    }
  },
  async removeItem(id) {
    if (!MOCK) {
      await tool("relay.devices.remove", { id });
      await get().load();
      return;
    }
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
  addToSpace: (id, sp) => set((s) => ({ devSpaces: { ...s.devSpaces, [id]: [...(s.devSpaces[id] ?? []), sp] } })),
  removeFromSpace: (id, sp) => set((s) => ({ devSpaces: { ...s.devSpaces, [id]: (s.devSpaces[id] ?? []).filter((x) => x !== sp) } })),
  setFaster: (faster) => set({ faster }),
  setLend: (meLends) => set({ meLends }),
  addDevice: (d, spaces) => set((s) => ({ items: [...s.items, d], devSpaces: { ...s.devSpaces, [d.id]: spaces } })),
}));

export const lendInfo = loadLend();
