// The approve swipe on the web, the way the pwa's now-phone.js does it: the row's face follows the
// finger 1:1 on pointer events, then release() (swipe.js, the needs-row rule) decides. A full 100
// reveal or a fling commits; 40 to 100 rests open with the action showing, and a tap on it commits;
// under 40 springs back. The first 8 px lock the axis: a vertical move is the list's scroll
// (touch-action: pan-y on the face), a horizontal one captures the pointer. Only the face's
// transform moves, at most once a frame, and it is promoted (will-change) only while it moves.
//
// On commit the row's height goes to 0 in the same handler, before React hears of it, so the
// collapse is painted on the next frame; `approve.collapse` measures commit to that frame.

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { Decision } from "../state/needs-model";
import { afterPaint, perf } from "../perf";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import type { SwipeRowProps } from "./SwipeRow";
import { ACTION_W, release } from "./swipe.js";

const AXIS = 8;
const ease = `cubic-bezier(${tokens.motion.ease.join(",")})`;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const side = { position: "absolute", inset: 0, display: "flex", alignItems: "center", visibility: "hidden" } as const;
// The revealed action: the 100 px a resting row uncovers, a real button only while it rests open.
const action = { width: ACTION_W, height: "100%", display: "flex", alignItems: "center", boxSizing: "border-box", flexShrink: 0 } as const;
const bare = { background: "none", border: 0, margin: 0, font: "inherit", color: "inherit", cursor: "pointer" } as const;

export function SwipeRow({ children, height, onSwipe, approveLabel, rejectLabel, testID }: SwipeRowProps) {
  const { color } = useTheme();
  const outer = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const g = useRef({ pid: -1, x0: 0, y0: 0, dx: 0, v: 0, lastX: 0, lastT: 0, axis: null as null | "x" | "y", moved: false, frame: 0, rest: 0, done: false });
  // Which side rests open: 1 approve, -1 deny. State, so the revealed action renders as a button.
  const [open, setOpen] = useState<0 | 1 | -1>(0);

  // "spring" back to a rest, "out" off the row on a commit, or "none" under the finger.
  const place = useCallback((x: number, how: "none" | "spring" | "out") => {
    const f = face.current;
    if (!f) return;
    const ms = how === "spring" ? tokens.motion.panel : tokens.motion.tap;
    f.style.transition = how === "none" || reduced() ? "none" : `transform ${ms}ms ${how === "out" ? "ease-out" : ease}`;
    f.style.transform = x ? `translateX(${x}px)` : "";
    if (left.current) left.current.style.visibility = x > 0 ? "visible" : "hidden";
    if (right.current) right.current.style.visibility = x < 0 ? "visible" : "hidden";
  }, []);

  const rest = useCallback(
    (x: number) => {
      g.current.rest = x;
      setOpen(x > 0 ? 1 : x < 0 ? -1 : 0);
      place(x, "spring");
    },
    [place],
  );

  const commit = useCallback(
    (d: Decision) => {
      const s = g.current;
      if (s.done) return;
      perf.mark("approve.commit");
      if (onSwipe(d)) {
        s.done = true;
        s.rest = 0;
        setOpen(0);
        const o = outer.current;
        place((d === "approve" ? 1 : -1) * (o?.clientWidth ?? 0), "out");
        if (o) {
          o.style.height = "0px";
          o.style.borderBottomWidth = "0px";
        }
        afterPaint((t) => perf.measure("approve.collapse", "approve.commit", t));
      } else rest(0);
    },
    [onSwipe, place, rest],
  );

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (s.done || e.button !== 0 || s.pid !== -1) return;
    s.pid = e.pointerId;
    s.x0 = s.lastX = e.clientX;
    s.y0 = e.clientY;
    s.lastT = e.timeStamp;
    s.axis = null;
    s.v = 0;
    s.dx = s.rest;
    s.moved = false;
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (e.pointerId !== s.pid) return;
    const mx = e.clientX - s.x0;
    const my = e.clientY - s.y0;
    if (!s.axis) {
      if (Math.abs(mx) < AXIS && Math.abs(my) < AXIS) return;
      s.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (s.axis === "y") return;
      try {
        e.currentTarget.setPointerCapture(s.pid);
      } catch {
        // The pointer is already gone: its pointerup or pointercancel ends the drag.
      }
      s.moved = true;
      e.currentTarget.style.willChange = "transform";
    }
    if (s.axis !== "x") return;
    const dt = e.timeStamp - s.lastT;
    if (dt > 0) s.v = (e.clientX - s.lastX) / dt;
    s.lastX = e.clientX;
    s.lastT = e.timeStamp;
    s.dx = s.rest + mx;
    if (!s.frame)
      s.frame = requestAnimationFrame(() => {
        s.frame = 0;
        place(s.dx, "none");
      });
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (e.pointerId !== s.pid) return;
    s.pid = -1;
    const axis = s.axis;
    s.axis = null;
    if (axis !== "x") return;
    if (s.frame) {
      cancelAnimationFrame(s.frame);
      s.frame = 0;
    }
    e.currentTarget.style.willChange = "";
    if (e.type === "pointercancel") {
      s.dx = s.rest;
      s.v = 0;
    }
    const r = release(s.dx, s.v);
    if (r === "commit-right") commit("approve");
    else if (r === "commit-left") commit("reject");
    else rest(r === "open-right" ? ACTION_W : r === "open-left" ? -ACTION_W : 0);
  };

  // A drag is not a tap on the row, and a tap on a row resting open closes it.
  const click = (e: ReactMouseEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s.moved && !s.rest) return;
    e.preventDefault();
    e.stopPropagation();
    if (s.moved) s.moved = false;
    else rest(0);
  };

  // A plain DOM style: the line height needs its unit here (a bare number is a multiplier in CSS).
  const label = { ...type.baseStrong, lineHeight: `${type.baseStrong.lineHeight}px` };
  return (
    <div ref={outer} style={{ position: "relative", height, overflow: "hidden", transition: `height ${tokens.motion.tap}ms ease-out`, WebkitTouchCallout: "none", userSelect: "none" }}>
      <div ref={left} aria-hidden={open !== 1} style={{ ...side, background: color.primaryBg, color: color.primaryInk, ...label }}>
        {open === 1 ? (
          <button type="button" onClick={() => commit("approve")} style={{ ...action, ...bare, paddingLeft: tokens.space[6] }}>
            {approveLabel}
          </button>
        ) : (
          <div style={{ ...action, paddingLeft: tokens.space[6] }}>{approveLabel}</div>
        )}
      </div>
      <div ref={right} aria-hidden={open !== -1} style={{ ...side, justifyContent: "flex-end", background: color.hover, color: color.text, ...label }}>
        {open === -1 ? (
          <button type="button" onClick={() => commit("reject")} style={{ ...action, ...bare, justifyContent: "flex-end", paddingRight: tokens.space[6] }}>
            {rejectLabel}
          </button>
        ) : (
          <div style={{ ...action, justifyContent: "flex-end", paddingRight: tokens.space[6] }}>{rejectLabel}</div>
        )}
      </div>
      {/* minWidth 0: a flex item's automatic minimum is its content, and one long unbroken line (a path) would widen the row. */}
      <div
        ref={face}
        data-testid={testID}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onClickCapture={click}
        style={{ position: "relative", height: "100%", display: "flex", alignItems: "center", background: color.bg, touchAction: "pan-y" }}
      >
        <div style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column" }}>{children}</div>
      </div>
    </div>
  );
}
