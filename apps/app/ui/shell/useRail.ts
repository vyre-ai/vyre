import { create } from "zustand";
import { readCollapsed, writeCollapsed } from "./rail-state.js";

/** The device's storage when there is one: the browser's, guarded (it can be blocked or missing). */
const store = () => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };

/** Is the rail folded on this device? Remembered per device, never per space or person. */
export const useRail = create<{ collapsed: boolean; toggle: () => void; set: (v: boolean) => void }>((set, get) => ({
  collapsed: readCollapsed(store()),
  set: (v) => { writeCollapsed(store(), v); set({ collapsed: v }); },
  toggle: () => get().set(!get().collapsed),
}));
