import { useEffect, useRef } from "react";
import { useUiTheme } from "@vyre/ui";
import { GRID, GRID_PHONE, buildDots, calmAround, lookOf, stepField } from "./field-core.js";
import { CONTENT_ID, FIELD, ripple } from "./field-state.js";

const rgb = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Measure the content and tell the field where to dim. Called after each step lays out. */
export function measureCalm() {
  const el = document.getElementById(CONTENT_ID), c = document.getElementById("onboard-field");
  if (!el || !c) return;
  FIELD.calm = calmAround(el.getBoundingClientRect(), c.getBoundingClientRect());
}

/**
 * The one canvas behind the whole welcome flow (mounted once at the root, so it lives through every step). Spring dots, a cursor that pushes and drags, shockwaves on clicks,
 * three wandering vortices; size and violet follow each dot's energy. Pauses when the tab is hidden; a single still frame under reduced motion; a lighter grid on a phone.
 */
export function HalftoneField({ phone }: { phone?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { color } = useUiTheme();
  const ink = useRef({ text: color.text, accent: color.accent });
  ink.current = { text: color.text, accent: color.accent };
  useEffect(() => {
    const c = ref.current;
    const x = c?.getContext("2d");
    if (!c || !x) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, dots = buildDots(0, 0), raf = 0, last = performance.now(), tm = 0;
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = c.clientWidth; H = c.clientHeight; c.width = W * dpr; c.height = H * dpr;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = buildDots(W, H, phone ? GRID_PHONE : GRID);
      measureCalm();
    };
    const frame = (t: number) => {
      const dt = Math.min(40, t - last); last = t; tm += dt;
      stepField(FIELD, dots, { dt, tm, W, H });
      const [tr, tg, tb] = rgb(ink.current.text), [br, bg, bb] = rgb(ink.current.accent);
      x.clearRect(0, 0, W, H);
      for (const d of dots) {
        const l = lookOf(FIELD, d, tm);
        x.fillStyle = `rgba(${((tr + (br - tr) * l.mix) | 0)},${((tg + (bg - tg) * l.mix) | 0)},${((tb + (bb - tb) * l.mix) | 0)},${l.a.toFixed(3)})`;
        x.beginPath(); x.arc(l.x, l.y, l.r, 0, 6.2832); x.fill();
      }
      if (!reduce && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const at = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const move = (e: PointerEvent) => { const [nx, ny] = at(e), P = FIELD.pointer; if (P.on) { P.vx = nx - P.x; P.vy = ny - P.y; } P.x = nx; P.y = ny; P.on = true; };
    const leave = () => { FIELD.pointer.on = false; };
    const down = (e: PointerEvent) => { if ((e.target as HTMLElement | null)?.closest?.("input,button,a,[role=button],[role=radio],[role=switch]")) return; const [nx, ny] = at(e); ripple(nx, ny, 0.6); };
    const visible = () => { if (document.hidden) cancelAnimationFrame(raf); else { last = performance.now(); raf = requestAnimationFrame(frame); } };
    size();
    window.addEventListener("resize", size);
    window.addEventListener("pointermove", move);
    document.addEventListener("pointerleave", leave);
    window.addEventListener("pointerdown", down);
    document.addEventListener("visibilitychange", visible);
    const settle = window.setTimeout(measureCalm, 150);
    raf = requestAnimationFrame(frame);
    if (reduce) window.setTimeout(() => frame(performance.now()), 120);
    return () => {
      cancelAnimationFrame(raf); window.clearTimeout(settle);
      window.removeEventListener("resize", size); window.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave);
      window.removeEventListener("pointerdown", down); document.removeEventListener("visibilitychange", visible);
    };
  }, [phone]);
  return <canvas id="onboard-field" ref={ref} aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}
