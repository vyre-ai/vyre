// useKept: one list screen's data with a kept copy. The last answer for this Space draws in the first frame (this visit's memory, then the device's view cache), the read runs behind it, and the
// fresh answer replaces it in place. A read past its budget with nothing to show is an error with Try again; with a copy showing, the copy stays and nothing flashes. Rules: src/state/kept-model.js.
// Only lists a person may read on this device belong here: never a value a reveal guards.
import { useCallback, useEffect, useRef, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { useSpaces } from "../../screens/shell/state";
import { viewCache } from "./cache";
import { keptKey, packKept, saidError, unpackKept, within } from "./kept-model.js";

const memory = new Map<string, unknown>();

export function useKept<T>(name: string, load: () => Promise<T>, fallback = "That did not load.") {
  const space = useSpaces((s) => s.space);
  const key = keptKey(name, space);
  const [data, setData] = useState<T | null>(() => (memory.has(key) ? (memory.get(key) as T) : null));
  const [err, setErr] = useState("");
  const [fresh, setFresh] = useState(false);
  const [n, setN] = useState(0);
  const keyNow = useRef(key);
  keyNow.current = key;
  const loadRef = useRef(load);
  loadRef.current = load;

  // 1. the kept copy, when this visit has none
  useEffect(() => {
    setFresh(false);
    if (memory.has(key)) { setData(memory.get(key) as T); return; }
    setData(null);
    if (allowsMock()) return;
    let live = true;
    void viewCache.get(key).then((raw) => {
      const v = unpackKept(raw);
      if (live && v !== undefined && !memory.has(key)) { memory.set(key, v); setData(v as T); }
    });
    return () => { live = false; };
  }, [key]);

  // 2. the fresh answer, replacing the copy in place
  useEffect(() => {
    let live = true;
    setErr("");
    within(loadRef.current()).then((v) => {
      if (!live || keyNow.current !== key) return;
      memory.set(key, v); setData(v); setFresh(true); setErr("");
      if (!allowsMock()) void viewCache.set(key, packKept(v));
    }).catch((e) => { if (live && keyNow.current === key && !memory.has(key)) setErr(saidError(e, fallback)); });
    return () => { live = false; };
  }, [key, n, fallback]);

  const reload = useCallback(() => setN((x) => x + 1), []);
  /** Put a changed value on screen and in the copy at once (an optimistic change). */
  const put = useCallback((next: T | ((cur: T | null) => T | null)) => {
    setData((cur) => { const v = typeof next === "function" ? (next as (c: T | null) => T | null)(cur) : next; if (v !== null) memory.set(keyNow.current, v); return v; });
  }, []);
  return { data, err: data === null ? err : "", fresh, reload, put };
}
