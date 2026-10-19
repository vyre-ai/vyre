// What a person keeps for themselves about how a record page reads: whether empty fields show as rows. Kept on this device (kv.ts) and read through a hook; the choice stays across records and restarts.
import { useEffect } from "react";
import { create } from "zustand";
import { kvGet, kvSet } from "./kv";

const KEY = "vyre.records.showEmpty";
const DENSITY = "vyre.records.density";
const FREEZE = "vyre.records.freezeFirst";
export type Density = "comfortable" | "compact";
type State = { showEmpty: boolean; density: Density; freezeFirst: boolean; loaded: boolean };
const useStore = create<State>()(() => ({ showEmpty: false, density: "comfortable", freezeFirst: false, loaded: false }));

/** Read what the device kept, once. */
export async function loadRecordPrefs(): Promise<void> {
  if (useStore.getState().loaded) return;
  const [kept, density, freeze] = await Promise.all([kvGet(KEY), kvGet(DENSITY), kvGet(FREEZE)]);
  useStore.setState((s) => ({ showEmpty: s.loaded ? s.showEmpty : kept === "1", density: s.loaded ? s.density : density === "compact" ? "compact" : "comfortable", freezeFirst: s.loaded ? s.freezeFirst : freeze === "1", loaded: true }));
}

export function setShowEmpty(on: boolean): void {
  useStore.setState({ showEmpty: on, loaded: true });
  void kvSet(KEY, on ? "1" : null);
}

/** Whether empty fields show as rows on a record page. */
export function useShowEmpty(): [boolean, (on: boolean) => void] {
  useEffect(() => { void loadRecordPrefs(); }, []);
  return [useStore((s) => s.showEmpty), setShowEmpty];
}

/** How tall a table's rows are, and whether its first column stays put when the table scrolls sideways: kept on this device, the same for every table. */
export function useTablePrefs() {
  useEffect(() => { void loadRecordPrefs(); }, []);
  const density = useStore((s) => s.density), freezeFirst = useStore((s) => s.freezeFirst);
  return {
    density, freezeFirst,
    setDensity: (d: Density) => { useStore.setState({ density: d, loaded: true }); void kvSet(DENSITY, d === "compact" ? "compact" : null); },
    setFreezeFirst: (on: boolean) => { useStore.setState({ freezeFirst: on, loaded: true }); void kvSet(FREEZE, on ? "1" : null); },
  };
}
