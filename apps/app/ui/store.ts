// The Store as React sees it. The one switch is deck/ui/store.js (mock now, the gateway adapter later); screens call useStore() and
// useStoreQuery(), never the mock. Shared with the Deck: the domain is one copy (ui-primitives.md section 1).
import { useCallback, useEffect, useRef, useState } from "react";
import { getStore, setStore } from "../../../deck/ui/store.js";
import type { Store } from "../../../deck/ui/contracts.js";

export { setStore };
export type { Store };

export function useStore(): Store {
  return getStore();
}

export type Query<T> = { data: T | undefined; loading: boolean; error: Error | null; reload: () => Promise<void> };

/**
 * Run a read against the Store and re-run it whenever the store reports a change. `read` may be async. Returns the last good data while
 * it reloads, so a screen does not flash empty between updates. Keep `read` stable per `deps`.
 */
export function useStoreQuery<T>(read: (s: Store) => T | Promise<T>, deps: unknown[] = []): Query<T> {
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: Error | null }>({ data: undefined, loading: true, error: null });
  const seq = useRef(0);
  const run = useCallback((): Promise<void> => {
    const mine = ++seq.current;
    return Promise.resolve()
      .then(() => read(getStore()))
      .then((data) => { if (mine === seq.current) setState({ data, loading: false, error: null }); })
      .catch((e) => { if (mine === seq.current) setState((s) => ({ data: s.data, loading: false, error: e instanceof Error ? e : new Error(String(e)) })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
    return getStore().subscribe(() => void run());
  }, [run]);
  return { ...state, reload: run };
}
