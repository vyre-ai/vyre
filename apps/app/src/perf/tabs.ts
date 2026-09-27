// tab.switch (ADR 0027): from the press on a tab to the first frame with that tab's content. The
// tabs stay mounted, so the content is there at once; the frame after focus is when it shows.
import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { afterPaint, perf } from "./index";

let pressAt: number | null = null;

/** A tab was pressed (the tab bar's tabPress). */
export function tabPressed(): void {
  if (perf.on) pressAt = perf.now();
}

/** In each tab screen: when it takes focus after a press, record the switch at its first frame. */
export function useTabDrawn(): void {
  useFocusEffect(
    useCallback(() => {
      if (pressAt === null) return;
      const t0 = pressAt;
      pressAt = null;
      afterPaint((t) => perf.record("tab.switch", t - t0));
    }, []),
  );
}
