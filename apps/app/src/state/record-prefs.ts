// What a person keeps for themselves about how a record page reads: whether empty fields show as rows. Kept on this device (kv.ts) and read through a hook; the choice stays across records and restarts.
import { useEffect } from "react";
import { create } from "zustand";
import { kvGet, kvSet } from "./kv";

const KEY = "vyre.records.showEmpty";
type State = { showEmpty: boolean; loaded: boolean };
const useStore = create<State>()(() => ({ showEmpty: false, loaded: false }));

/** Read what the device kept, once. */
export async function loadRecordPrefs(): Promise<void> {
  if (useStore.getState().loaded) return;
  const kept = await kvGet(KEY);
  useStore.setState((s) => ({ showEmpty: s.loaded ? s.showEmpty : kept === "1", loaded: true }));
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
