import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { Text } from "./Text";
import { useReducedMotion } from "../motion/useReducedMotion";
import { done, intro, markup, small, working } from "../marks/vyre-mark.js";

export type MarkState = "static" | "intro" | "working" | "done";
export type MarkSize = "sm" | "md" | "lg";
/** The three sizes: 28 for the lockup, 56 for a screen's own mark and 112 for the first screen. Under 48 the small master is used (hand-tuned for it). */
const PX: Record<MarkSize, number> = { sm: 28, md: 56, lg: 112 };
const INTRO_MS = 900;
const DONE_MS = 700;

/** A clock for the states that move: calls `frame` with the time as it runs, to the end (`ms`) or for ever (`ms` 0, at 20 frames a second). Reduced motion: no clock, the last frame once. */
function useClock(active: boolean, ms: number, reduced: boolean): number {
  const [t, setT] = useState(reduced || !active ? (ms ? ms : 0) : 0);
  useEffect(() => {
    if (!active || reduced) { setT(ms ? ms : 0); return; }
    const t0 = Date.now();
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      const e = Date.now() - t0;
      setT(ms ? Math.min(e, ms) : e);
      if (!ms || e < ms) id = setTimeout(tick, ms ? 16 : 50);
    };
    tick();
    return () => clearTimeout(id);
  }, [active, ms, reduced]);
  return t;
}

/**
 * The Vyre mark: the wire drawn as a glass tube ending in a bead of light (docs/design/brand), from the approved master files, never redrawn. Four states.
 * static: at rest. intro (900 ms): the wire draws in along the tube, then the bead's light comes on. working: a slow breath of the bead's light while something waits (2.4 s a cycle). done: one bright pulse out of the bead (700 ms).
 * Reduced motion: every state shows at once and nothing loops. `lockup` adds the word Vyre beside it (the top left of a flow screen).
 */
export function VyreMark({ state = "static", size = "md", lockup }: { state?: MarkState; size?: MarkSize; lockup?: boolean }) {
  const reduced = useReducedMotion();
  const px = PX[size];
  const moving = state !== "static";
  const t = useClock(moving, state === "intro" ? INTRO_MS : state === "done" ? DONE_MS : 0, reduced);
  const xml = useMemo(() => {
    if (state === "static" || reduced) return px < 48 ? small() : markup();
    if (state === "intro") return markup(intro(t / INTRO_MS));
    if (state === "done") return markup(done(t / DONE_MS));
    return markup(working(t));
  }, [state, reduced, px, t]);
  const mark = (
    <View accessibilityRole="image" accessibilityLabel="Vyre" style={{ width: px, height: px }}>
      <SvgXml xml={xml} width={px} height={px} />
    </View>
  );
  if (!lockup) return mark;
  return (
    <View accessibilityLabel="Vyre" className="flex-row items-center gap-s2">
      {mark}
      <Text strong size="headline">Vyre</Text>
    </View>
  );
}
