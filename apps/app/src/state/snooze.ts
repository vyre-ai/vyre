// "Later" on a Needs you card, kept on this device (the engine has no snooze for a task, an ask or a held send): the card goes away until the time given, then
// comes back as it was. Read through selector hooks. The table lives in the device's own store (kv.ts), so it survives a restart and is never sent anywhere.
import { create } from "zustand";
import { readSnoozed, stillSnoozed } from "../../ui/tasks/ask-model.js";
import { kvGet, kvSet } from "./kv";

const KEY = "vyre.needs.later";
type State = { until: Record<string, number>; loaded: boolean };
const useStore = create<State>()(() => ({ until: {}, loaded: false }));

const save = (until: Record<string, number>) => { void kvSet(KEY, Object.keys(until).length ? JSON.stringify(until) : null); };

/** Read what the device kept, once. Called by the screen that shows the cards. */
export async function loadSnoozed(now: number = Date.now()): Promise<void> {
  if (useStore.getState().loaded) return;
  const kept = stillSnoozed(readSnoozed(await kvGet(KEY)), now);
  useStore.setState((s) => ({ until: { ...kept, ...s.until }, loaded: true }));
}

/** Put a card away until `until`. Returns a function that brings it back (the Undo). */
export function snoozeNeed(id: string, until: number): () => void {
  const next = { ...useStore.getState().until, [id]: until };
  useStore.setState({ until: next });
  save(next);
  return () => wakeNeed(id);
}

export function wakeNeed(id: string): void {
  const { [id]: _gone, ...rest } = useStore.getState().until;
  useStore.setState({ until: rest });
  save(rest);
}

/** The ids put away and not yet due. `now` is the caller's clock, so a screen on a sample day agrees with itself. */
export const useSnoozed = (now: number = Date.now()): ReadonlySet<string> => {
  const until = useStore((s) => s.until);
  return new Set(Object.keys(stillSnoozed(until, now)));
};
