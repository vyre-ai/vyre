// A reply as it streams, revealed at the display's pace (chat core pace.js): arrivals move the
// target, the frame clock moves what shows. Each visible change is a `stream` gap in the meter;
// the run ends when the reply is done, so the wait before the next reply is not a gap.

import { memo, useEffect, useRef, useState } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { createPacer, type Pacer } from "@vyre/chat-core/pace.js";
import { perf } from "../perf";

const raf: (f: (t: number) => void) => void =
  typeof requestAnimationFrame === "function" ? (f) => void requestAnimationFrame(f) : (f) => void setTimeout(() => f(perf.now()), 16);

export const PacedText = memo(function PacedText({ text, streaming, style }: { text: string; streaming: boolean; style?: StyleProp<TextStyle> }) {
  const pacer = useRef<Pacer | null>(null);
  const running = useRef(false);
  const shownRef = useRef(streaming ? 0 : text.length);
  const [shown, setShown] = useState(shownRef.current);

  useEffect(() => {
    if (!streaming) {
      if (pacer.current) {
        pacer.current.done();
        pacer.current = null;
        perf.endGap("stream");
      }
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    const p = (pacer.current ??= createPacer());
    p.push(text.length, perf.now());
    if (running.current) return;
    running.current = true;
    const tick = (t: number) => {
      const cur = pacer.current;
      if (!cur) {
        running.current = false;
        return;
      }
      const v = cur.visible(t);
      if (v !== shownRef.current) {
        shownRef.current = v;
        setShown(v);
        perf.gap("stream", t);
      }
      if (cur.settled(t)) running.current = false;
      else raf(tick);
    };
    raf(tick);
  }, [text, streaming]);

  return (
    <Text selectable style={style}>
      {streaming ? text.slice(0, shown) : text}
    </Text>
  );
});
