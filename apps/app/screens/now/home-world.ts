// Now's world, stale while revalidate: the last good copy for the showing Space paints at once from this device's view cache, the box is read behind it, and the fresh answer
// replaces it in place. Only the very first open of a Space (nothing kept yet) shows the placeholder rows. The packing rules (what is kept, never a sealed value) are ui/tasks/world-cache.js.
import { useEffect, useRef, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { viewCache } from "../../src/state/cache";
import { useSpaces } from "../shell/state";
import { homeKey, packWorld, pickWorld, unpackWorld } from "../../ui/tasks/world-cache.js";
import { homeName } from "./home-model.js";

const NAME_KEY = "home.name";

/** The name Home greets (home-model.js homeName): this device's last copy at once, then Account's identity read. Empty while unknown, so the greeting has no name rather than "You". */
export function useHomeName(real: boolean): string {
  const [name, setName] = useState("");
  useEffect(() => {
    if (!real) return;
    let live = true, fresh = false;
    void viewCache.get<string>(NAME_KEY).then((v) => { if (live && !fresh && typeof v === "string") setName(v); });
    void import("../settings/real").then((m) => m.identity()).then((id) => {
      const n = homeName(id as { label?: string; name?: string });
      fresh = true;
      if (!live) return;
      setName(n);
      void viewCache.set(NAME_KEY, n);
    }).catch(() => { /* the kept name, or none, stands */ });
    return () => { live = false; };
  }, [real]);
  return name;
}

/** How long after a fresh answer the copy is written, so a burst of box events writes once. */
const SAVE_MS = 800;

/**
 * @param fresh the store's world (useWorld) merged with today's calendar, undefined until the box answers
 * @returns the world to draw and whether it is the kept copy (a quiet "Updating" shows while it is)
 */
export function useHomeWorld<W>(fresh: W | undefined): { world: W | undefined; stale: boolean } {
  const real = !allowsMock();
  const space = useSpaces((s) => s.space);
  const key = homeKey(space);
  const [kept, setKept] = useState<{ key: string; world: W } | null>(null);
  const answered = useRef(false);
  answered.current = fresh !== undefined;

  useEffect(() => {
    if (!real) return;
    let live = true;
    void viewCache.get(key).then((raw) => {
      const w = unpackWorld(raw) as unknown as W | null;
      // The box may have answered first: its world wins and the copy is not drawn.
      if (live && w && !answered.current) setKept({ key, world: w });
    });
    return () => { live = false; };
  }, [real, key]);

  // Kept under the Space showing when the answer came: a Space switch alone never files one Space's world under another.
  const keyNow = useRef(key);
  keyNow.current = key;
  useEffect(() => {
    if (!real || fresh === undefined) return;
    const k = keyNow.current;
    const t = setTimeout(() => void viewCache.set(k, packWorld(fresh)), SAVE_MS);
    return () => clearTimeout(t);
  }, [real, fresh]);

  return pickWorld(fresh, kept && kept.key === key ? kept.world : null);
}
