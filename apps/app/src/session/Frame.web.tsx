// The keyboard on the web (DIRECTION.md, Smooth): iOS shrinks the visual viewport, not the
// layout, so a fixed composer would sit under the keyboard or jump. One visualViewport listener
// sets one variable, --vyre-kb; the composer moves up by transform and the transcript's bottom
// padding follows it, both from that one value, so they move in the same frame.
//
// keyboard.jump: the distance from the transcript's last row to the composer before and after the
// inset changes. Anything but 0 px is a jump the reader sees.

import { useEffect, useRef, type ReactNode } from "react";
import { afterPaint, perf } from "../perf";

function gap(host: HTMLElement | null, composer: HTMLElement | null): number | null {
  if (!host || !composer) return null;
  const rows = host.querySelectorAll<HTMLElement>("[data-k]");
  const last = rows[rows.length - 1];
  if (!last) return null;
  return composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
}

export function Frame({ transcript, composer }: { transcript: ReactNode; composer: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let inset = 0;
    const apply = () => {
      const next = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      if (next === inset) return;
      const before = perf.on ? gap(host.current, bar.current) : null;
      inset = next;
      root.style.setProperty("--vyre-kb", `${next}px`);
      if (before !== null)
        afterPaint(() => {
          const after = gap(host.current, bar.current);
          if (after !== null) perf.record("keyboard.jump", Math.abs(Math.round(after - before)));
        });
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--vyre-kb");
    };
  }, []);

  return (
    <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div ref={host} style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {transcript}
      </div>
      <div ref={bar} style={{ flex: "none", transform: "translateY(calc(-1 * var(--vyre-kb, 0px)))", willChange: "transform" }}>
        {composer}
      </div>
    </div>
  );
}
