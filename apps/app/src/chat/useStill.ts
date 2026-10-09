// A small still of a computer's screen for its card (previews.frame, which asks sight.frame): fetched when the card appears, again whenever the card says it did something new, and every few seconds while it is
// working or needs you. It stops when the card goes away. The box says why when there is none (a Mac's picture stays on the Mac).
import { useEffect, useRef, useState } from "react";
import { tool } from "../real/box";

export function useStill(run: string, tick: string, live: boolean, maxWidth = 640): { src: string | null; why: string | undefined } {
  const [src, setSrc] = useState<string | null>(null);
  const [why, setWhy] = useState<string | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => {
    let dead = false;
    const get = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await tool<{ image: string | null; mime?: string; why?: string }>("previews.frame", { run, maxWidth });
        if (dead) return;
        if (r.image) { setSrc(`data:${r.mime || "image/jpeg"};base64,${r.image}`); setWhy(undefined); } else setWhy(r.why);
      } catch { if (!dead) setWhy("later"); } finally { busy.current = false; }
    };
    void get();
    const t = live ? setInterval(get, 5000) : null;
    return () => { dead = true; if (t) clearInterval(t); };
  }, [run, tick, live, maxWidth]);
  return { src, why };
}
