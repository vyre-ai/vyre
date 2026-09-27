// The transcript on the web (DIRECTION.md, Smooth): an inverted list, windowed by chat's core.
//
// - Inverted: the scroller is `flex-direction: column-reverse`, so its scroll origin is the
//   bottom. Following the tail needs no code, and history added above never moves what is on
//   screen, in Safari too (Safari has no overflow-anchor).
// - Windowed: above 100 rows only the rows near the viewport are mounted, with one spacer above
//   and one below as tall as the rows they stand for (deck/chat/core/window.js: heights by key,
//   estimates by kind replaced by measurements, windowRange, spacers).
// - Reading history while the tail changes: a row growing or arriving below the viewport would
//   push the view (the origin is the bottom). The row at the top of the viewport is the anchor
//   (window.js captureAnchor names it), and after any change its screen position is put back.
// - Rows off screen skip paint with `content-visibility: auto`.
// - The keyboard: the scroller's bottom padding is the one inset variable (--vyre-kb), so the
//   last row rides up with the composer in the same frame.
// - Up in history, a "Jump to latest" pill takes the reader back to the tail.
// - The meter (?perf=1): `cls` is the layout shift of rows above the live row (the last one), and
//   `view.jump` what the anchor kept of a move while the reader is up in history; both must be 0.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { captureAnchor, createHeights, isAtBottom, offsets, sameRange, spacers, THRESHOLD, windowRange } from "@vyre/chat-core/window.js";
import { perf } from "../perf";
import { ESTIMATES } from "./model";
import type { TranscriptProps } from "./Transcript";

type Range = { start: number; end: number; windowed: boolean };

const NEAR_TOP = 600;
/** Keys session-state derives from the box's own ids, the same on every read (a user row's by its uuid; u:live:N is minted per read). */
const STABLE = /^(m|r|t|a|run|steer):|^u:(?!live:)/;

export function Transcript({ rows, renderRow, hasMore, onNearTop, head, jump }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const headEl = useRef<HTMLDivElement>(null);
  const heights = useMemo(() => createHeights({ estimates: ESTIMATES }), []);
  const [measured, setMeasured] = useState(0);
  const [range, setRange] = useState<Range | null>(null);

  const keys = useMemo(() => rows.map((r) => r.key), [rows]);
  const kinds = useMemo(() => rows.map((r) => (r.type === "run" ? "run" : r.kind)), [rows]);
  // Spacer sizes need offsets only when windowed; below the threshold every row is in the DOM.
  const windowed = rows.length > THRESHOLD;
  const offs = useMemo(() => offsets(keys, heights, kinds), [keys, kinds, heights, windowed ? measured : 0]);
  const live = useRef({ keys, offs, rows, windowed, anchor: null as { key: string; top: number } | null, hasMore, onNearTop });
  live.current.keys = keys;
  live.current.offs = offs;
  live.current.rows = rows;
  live.current.windowed = windowed;
  live.current.hasMore = hasMore;
  live.current.onNearTop = onNearTop;

  /** The scroll position in the model's coordinates: 0 at the top of the first row. */
  const modelTop = useCallback((el: HTMLDivElement) => el.scrollHeight - el.clientHeight + el.scrollTop - (headEl.current?.offsetHeight ?? 0), []);

  const current = useCallback((): Range => {
    const el = scroller.current;
    const { offs: o } = live.current;
    const n = o.length - 1;
    if (!el) return windowRange({ offs: o, scrollTop: Math.max(0, o[n] - 900), viewport: 900 });
    return windowRange({ offs: o, scrollTop: modelTop(el), viewport: el.clientHeight });
  }, [modelTop]);

  /** Name the row at the top of the viewport and where it sits, when the reader is up in history. */
  const remember = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const L = live.current;
    if (isAtBottom(el.scrollHeight - el.clientHeight + el.scrollTop, el.clientHeight, el.scrollHeight)) {
      L.anchor = null;
      return;
    }
    // The row at the top of the viewport, or the first after it whose key survives a reread
    // (a reply, a tool, an ask, a message with its uuid).
    const a = captureAnchor(L.keys, L.offs, Math.max(0, modelTop(el)));
    L.anchor = null;
    if (!a) return;
    for (let i = L.keys.indexOf(a.key), n = 0; i >= 0 && i < L.keys.length && n < 40; i++, n++) {
      const k = L.keys[i];
      if (!STABLE.test(k)) continue;
      const node = el.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`);
      if (node) {
        L.anchor = { key: k, top: node.getBoundingClientRect().top };
        return;
      }
    }
  }, [modelTop]);

  /** Put the anchor row back where it was: nothing below the viewport may move what is read. */
  const restore = useCallback(() => {
    const el = scroller.current;
    const a = live.current.anchor;
    if (!el || !a) return;
    const node = el.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.key)}"]`);
    if (!node) return;
    const d = node.getBoundingClientRect().top - a.top;
    if (Math.abs(d) < 0.5) return;
    el.scrollTop += d;
    // Put back before the paint: what the reader would see move is what is left.
    if (perf.on) perf.record("view.jump", Math.round(Math.abs(node.getBoundingClientRect().top - a.top)));
  }, []);

  // Measure mounted rows; a change re-lays spacers (windowed) and keeps the anchor.
  const ro = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            let changed = false;
            for (const e of entries) {
              const k = (e.target as HTMLElement).dataset.k;
              if (!k) continue;
              const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
              const first = !heights.measured(k);
              if (heights.set(k, h) !== 0 || first) changed = true;
            }
            restore();
            if (changed && live.current.windowed) setMeasured((m) => m + 1);
          }),
    [heights, restore],
  );
  // One ref callback per key, kept, so a re-render does not unobserve and observe every row.
  const refs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const observe = useCallback(
    (key: string) => {
      let f = refs.current.get(key);
      if (!f) {
        let el: HTMLDivElement | null = null;
        f = (node: HTMLDivElement | null) => {
          if (el && el !== node) ro?.unobserve(el);
          el = node;
          if (node) ro?.observe(node);
          else refs.current.delete(key);
        };
        refs.current.set(key, f);
      }
      return f;
    },
    [ro],
  );

  // After any change of rows: the window follows the view, the anchor is kept.
  useLayoutEffect(() => {
    restore();
    const r = current();
    setRange((was) => (sameRange(was, r) && was?.windowed === r.windowed ? was : r));
    heights.prune(keys);
  }, [rows, measured, current, restore, heights, keys]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        remember();
        setAway(live.current.anchor !== null);
        const r = current();
        setRange((was) => (sameRange(was, r) && was?.windowed === r.windowed ? was : r));
        const L = live.current;
        if (L.hasMore && modelTop(el) < NEAR_TOP) L.onNearTop();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [current, remember, modelTop]);

  useLayoutEffect(() => () => ro?.disconnect(), [ro]);

  // cls: layout shifts of rows above the live row. A 0 goes in first, so a clean run is judged.
  useEffect(() => {
    if (!perf.on || typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) return;
    const el = scroller.current;
    if (!el) return;
    perf.record("cls", 0);
    type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
    const po = new PerformanceObserver((list) => {
      const rows = el.querySelectorAll<HTMLElement>("[data-k]");
      const tail = rows[rows.length - 1];
      for (const e of list.getEntries() as Shift[]) {
        if (e.hadRecentInput) continue;
        const above = (e.sources ?? []).some((src) => src.node && el.contains(src.node) && !(tail && tail.contains(src.node)));
        if (above) perf.record("cls", e.value);
      }
    });
    po.observe({ type: "layout-shift", buffered: false });
    return () => po.disconnect();
  }, []);

  const [away, setAway] = useState(false);
  const toLatest = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    live.current.anchor = null;
    // The scroller is reversed: 0 is the bottom.
    el.scrollTo({ top: 0 });
    setAway(false);
  }, []);

  const n = rows.length;
  // Rows read in above shift every index: the window keeps the rows it held, found by key.
  const held = useRef<{ keys: readonly string[]; range: Range | null }>({ keys, range: null });
  let base = range;
  if (base && base.windowed && held.current.keys !== keys) {
    const was = held.current.keys[base.start];
    const at = was === undefined ? -1 : keys.indexOf(was);
    if (at >= 0 && at !== base.start) base = { ...base, start: at, end: Math.min(n, at + (base.end - base.start)) };
  }
  const r: Range = !windowed ? { start: 0, end: n, windowed: false } : base && base.windowed && base.end <= n ? base : current();
  held.current = { keys, range: r };
  const sp = r.windowed ? spacers(offs, r.start, r.end) : { top: 0, bottom: 0 };
  const mounted = rows.slice(r.start, r.end);

  return (
    <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div
        ref={scroller}
        data-testid="transcript"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column-reverse",
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
          overflowAnchor: "none",
          paddingBottom: "var(--vyre-kb, 0px)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div ref={headEl}>{head}</div>
          {sp.top ? <div aria-hidden style={{ height: sp.top, flex: "none" }} /> : null}
          {mounted.map((row) => (
            <div
              key={row.key}
              data-k={row.key}
              ref={observe(row.key)}
              style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${heights.get(row.key, row.type === "run" ? "run" : row.kind)}px` }}
            >
              {renderRow(row)}
            </div>
          ))}
          {sp.bottom ? <div aria-hidden style={{ height: sp.bottom, flex: "none" }} /> : null}
        </div>
      </div>
      {away && jump ? jump(toLatest) : null}
    </div>
  );
}
