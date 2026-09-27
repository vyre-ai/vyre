// The approve swipe on the web (DIRECTION.md, "Gestures on the compositor"): a horizontal
// scroll-snap strip of three full-width panels, Approve | the row | Deny, resting on the row.
// Scrolling and snapping run on the browser's scrolling thread, so a busy main thread cannot drop
// a frame of the gesture. Past half way it snaps to a side; the snap coming to rest there is the
// commit. JavaScript only hears where it came to rest (scrollend, or the scroll going quiet after
// the finger lifts where scrollend is missing).
//
// On commit the row's height goes to 0 in the same handler, before React hears of it, so the
// collapse is painted on the next frame; `approve.collapse` measures commit to that frame.

import { useCallback, useLayoutEffect, useRef } from "react";
import type { Decision } from "../state/needs-model";
import { afterPaint, perf } from "../perf";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import type { SwipeRowProps } from "./SwipeRow";

// Scrollbars off on the strip, once per page (Safari needs the pseudo-element).
if (typeof document !== "undefined" && !document.getElementById("vy-swipe-css")) {
  const css = document.createElement("style");
  css.id = "vy-swipe-css";
  css.textContent = ".vy-swipe{scrollbar-width:none}.vy-swipe::-webkit-scrollbar{display:none}";
  document.head.appendChild(css);
}

const QUIET_MS = 90;

// minWidth 0: a flex item's automatic minimum is its content, and one long unbroken line (a path)
// would widen the panel past the row.
const panel = { flex: "0 0 100%", width: "100%", minWidth: 0, height: "100%", scrollSnapAlign: "start", display: "flex", alignItems: "center", boxSizing: "border-box" } as const;

export function SwipeRow({ children, height, onSwipe, approveLabel, rejectLabel, testID }: SwipeRowProps) {
  const { color } = useTheme();
  const outer = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const state = useRef({ touching: false, done: false, quiet: 0 as ReturnType<typeof setTimeout> | 0 });

  const center = useCallback((smooth = false) => {
    const el = strip.current;
    if (el) el.scrollTo({ left: el.clientWidth, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Rest on the row, and again when the width changes (a rotation) while resting there.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    center();
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w && !state.current.done) {
        w = el.clientWidth;
        center();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [center]);

  const settle = useCallback(() => {
    const el = strip.current;
    const s = state.current;
    if (!el || s.done || s.touching) return;
    const w = el.clientWidth;
    const x = el.scrollLeft;
    const d: Decision | null = x <= 1 ? "approve" : x >= 2 * w - 1 ? "reject" : null;
    if (!d) return;
    perf.mark("approve.commit");
    if (onSwipe(d)) {
      s.done = true;
      const o = outer.current;
      if (o) {
        o.style.height = "0px";
        o.style.borderBottomWidth = "0px";
      }
      afterPaint((t) => perf.measure("approve.collapse", "approve.commit", t));
    } else center(true);
  }, [onSwipe, center]);

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const s = state.current;
    const hasEnd = "onscrollend" in el;
    const quiet = () => {
      if (s.quiet) clearTimeout(s.quiet);
      s.quiet = setTimeout(settle, QUIET_MS);
    };
    const onScroll = () => !hasEnd && quiet();
    const down = () => (s.touching = true);
    const up = () => {
      s.touching = false;
      quiet();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    if (hasEnd) el.addEventListener("scrollend", settle);
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchend", up, { passive: true });
    el.addEventListener("touchcancel", up, { passive: true });
    return () => {
      if (s.quiet) clearTimeout(s.quiet);
      el.removeEventListener("scroll", onScroll);
      if (hasEnd) el.removeEventListener("scrollend", settle);
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [settle]);

  const label = { fontSize: tokens.type.phone.base[0], lineHeight: `${tokens.type.phone.base[1]}px`, fontWeight: 600 };
  return (
    <div ref={outer} style={{ height, overflow: "hidden", transition: `height ${tokens.motion.tap}ms ease-out`, WebkitTouchCallout: "none", userSelect: "none" }}>
      <div
        ref={strip}
        data-testid={testID}
        className="vy-swipe"
        style={{ display: "flex", height: "100%", overflowX: "auto", overflowY: "hidden", scrollSnapType: "x mandatory", overscrollBehaviorX: "contain" }}
      >
        <div aria-hidden style={{ ...panel, background: color.primaryBg, color: color.primaryInk, paddingLeft: tokens.space[6], ...label }}>
          {approveLabel}
        </div>
        <div style={{ ...panel, scrollSnapStop: "always", background: color.bg }}>
          <div style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column" }}>{children}</div>
        </div>
        <div aria-hidden style={{ ...panel, justifyContent: "flex-end", background: color.hover, color: color.text, paddingRight: tokens.space[6], ...label }}>
          {rejectLabel}
        </div>
      </div>
    </div>
  );
}
