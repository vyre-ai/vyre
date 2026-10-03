import { useCallback, useEffect, useState } from "react";
import { createMockStore } from "../../../../deck/ui/mock-store.js";
import { runClientPays } from "../../../../deck/ui/scenario.js";
import { getStore } from "../../../../deck/ui/store.js";
import { setStore } from "../store";

let played = false;

/**
 * Plays "a client pays" (deck/ui/scenario.js) on a fresh mock store, so the Welcome email can be seen waiting on Now with Send with Face ID. `flag` is the
 * route's `scenario` query value: "client-pays" plays it once when the screen opens. `replay()` plays it again (a button). `epoch` changes whenever the store
 * is replaced, so a screen re-reads and re-subscribes (pass it in the deps of its queries).
 */
export function usePlayScenario(flag?: string) {
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // The first render already reads the new store: swap it before any query runs.
  useState(() => { if (flag === "client-pays" && !played) setStore(createMockStore({ world: "payday" })); });
  const play = useCallback(async (pace: number) => {
    try {
      await runClientPays(getStore(), { pace, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), onStep: (_n: number, what: string) => setNotice(what) });
    } catch (e) { setNotice(String((e as Error)?.message || e)); return; }
    setNotice(null);
  }, []);
  useEffect(() => {
    if (flag !== "client-pays" || played) return;
    played = true;
    void play(0);
  }, [flag, play]);
  const replay = useCallback(() => {
    setStore(createMockStore({ world: "payday" }));
    setEpoch((e) => e + 1);
    void play(900);
  }, [play]);
  return { epoch, notice, replay };
}
