// @ts-check
// The in-page instrumentation for the native bar, injected into every document through CDP
// (Page.addScriptToEvaluateOnNewDocument) before the Deck's own scripts run. It keeps everything on
// window.__bar:
//   es          the Deck's EventSource (wrapped: the harness's listeners run before the Deck's)
//   events      every thread.* and stream event as it arrives: {id, type, thread, at, arrive, len}
//   longtasks   PerformanceObserver longtask entries {start, duration}
//   shifts      PerformanceObserver layout-shift entries {start, value, input, nodes}
//   keys        keydown to next paint, per key (rAF, then a message-channel task after the frame)
//   timers      setInterval and setTimeout calls with their delays, for the idle check
// and helpers the harness calls with Runtime.evaluate (sampler, rows, liveRow, waitFrames).
// A test helper, not part of the product.

export const PAGE_SCRIPT = String.raw`(() => {
  if (window.__bar) return;
  const B = window.__bar = { events: [], longtasks: [], shifts: [], keys: [], keyOn: false, timers: [], es: null, esOpen: [], esError: [] };
  const now = () => performance.now();
  B.epoch = t => performance.timeOrigin + t;

  // ---- the event stream -------------------------------------------------------------------
  const Native = window.EventSource;
  if (Native) {
    const TYPES = ["thread.sent", "thread.text", "thread.tool", "thread.finished", "thread.stopped", "stream.reset"];
    class Bar extends Native {
      constructor(url, init) {
        super(url, init);
        B.es = this;
        const hear = m => {
          const arrive = now();
          let e = null; try { e = JSON.parse(m.data); } catch {}
          if (!e) return;
          const p = e.payload || {};
          B.events.push({ id: e.id, type: e.type, thread: e.thread, at: e.at, arrive, len: p.delta ? p.delta.length : 0, done: !!p.done });
        };
        for (const t of TYPES) super.addEventListener(t, hear);
        super.addEventListener("open", () => B.esOpen.push(now()));
        super.addEventListener("error", () => B.esError.push({ t: now(), state: this.readyState }));
      }
    }
    window.EventSource = Bar;
  }

  // ---- the event stream over fetch (core/resilience follow(), ADR 0029) ------------------------
  // A Deck that reads /v1/events/stream with fetch never makes an EventSource: tee each such
  // response and read the same events from it, count each fetch as an open and each end or
  // failure as an error, and keep the Deck's own "deck:stream" states beside them.
  const TYPES_F = new Set(["thread.sent", "thread.text", "thread.tool", "thread.finished", "thread.stopped", "stream.reset"]);
  B.streamStates = [];
  B.via = Native ? "eventsource" : "none";
  window.addEventListener("deck:stream", ev => B.streamStates.push({ t: now(), state: ev.detail && ev.detail.state, attempt: ev.detail && ev.detail.attempt }));
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    if (!/\/v1\/events\/stream/.test(url)) return nativeFetch(input, init);
    B.via = "fetch";
    let res;
    try { res = await nativeFetch(input, init); } catch (err) { B.esError.push({ t: now(), state: "fetch-failed" }); throw err; }
    if (!res.ok || !res.body) { B.esError.push({ t: now(), state: "status-" + res.status }); return res; }
    B.esOpen.push(now());
    const [mine, theirs] = res.body.tee();
    (async () => {
      const rd = mine.getReader(), dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
            const data = frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
            if (!data) continue;
            let e = null; try { e = JSON.parse(data); } catch {}
            if (!e || !TYPES_F.has(e.type)) continue;
            const p = e.payload || {};
            B.events.push({ id: e.id, type: e.type, thread: e.thread, at: e.at, arrive: now(), len: p.delta ? p.delta.length : 0, done: !!p.done });
          }
        }
      } catch {}
      B.esError.push({ t: now(), state: "ended" });
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  // ---- observers ----------------------------------------------------------------------------
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) B.longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) B.shifts.push({ start: e.startTime, value: e.value, input: e.hadRecentInput,
        nodes: (e.sources || []).map(s => s.node).filter(Boolean) });
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}

  // ---- Event Timing: keydown and input entries (Chrome reports only those of 16 ms or more) ----
  B.evt = [];
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (/^(keydown|keypress|beforeinput|input)$/.test(e.name))
      B.evt.push({ name: e.name, start: e.startTime, duration: e.duration, proc: e.processingEnd - e.processingStart, id: e.interactionId || 0 }); })
      .observe({ type: "event", durationThreshold: 16, buffered: true });
    B.evtOk = true;
  } catch { B.evtOk = false; }

  // ---- keydown to next paint ------------------------------------------------------------------
  document.addEventListener("keydown", e => {
    if (!B.keyOn) return;
    const t0 = e.timeStamp;
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => B.keys.push(now() - t0);
      ch.port2.postMessage(0);
    });
  }, true);

  // ---- timers, for the idle check ------------------------------------------------------------
  const si = window.setInterval, st = window.setTimeout;
  window.setInterval = function (fn, ms, ...a) { B.timers.push({ kind: "interval", ms: Number(ms) || 0, t: now(), src: String(fn).slice(0, 80) }); return si.call(this, fn, ms, ...a); };
  window.setTimeout = function (fn, ms, ...a) { if (B.timerWatch) B.timers.push({ kind: "timeout", ms: Number(ms) || 0, t: now(), src: String(fn).slice(0, 80) }); return st.call(this, fn, ms, ...a); };

  // ---- helpers for the harness -----------------------------------------------------------------
  B.timeline = () => document.querySelector(".thread-view");
  /** Rows in the timeline, spacers and controls left out. */
  B.rows = () => { const tl = B.timeline(); return tl ? [...tl.querySelectorAll(".cv-row, .msg, .day-rule, .turn-foot")].filter(el => !el.parentElement.closest(".cv-row, .msg")) : []; };
  B.liveRow = () => { const l = document.querySelectorAll(".thread-view .cv-live"); return l.length ? l[l.length - 1] : null; };
  /** The reply row that holds marker, newest first. */
  B.rowWith = marker => { const l = [...document.querySelectorAll(".thread-view .cv-text")]; for (let i = l.length - 1; i >= 0; i--) if (l[i].textContent.includes(marker)) return l[i]; return null; };
  B.frame = () => new Promise(r => requestAnimationFrame(() => r(now())));
  B.waitFrames = async n => { for (let i = 0; i < n; i++) await B.frame(); };

  /**
   * A per-frame sampler of the streaming reply: {t, len} each frame, where the row is the newest
   * live row seen since start (or, once it is swapped for its rich row, the row with the marker).
   */
  B.sampler = null;
  B.startSampler = marker => {
    const S = B.sampler = { marker, samples: [], el: null, firstPaint: null, stop: false, blank: 0, rowsMin: Infinity, anchor: null, jumps: [] };
    const before = new Set(document.querySelectorAll(".thread-view .cv-live"));
    const tick = t => {
      if (S.stop) return;
      let el = S.el;
      if (!el || !el.isConnected) {
        const live = B.liveRow();
        el = (live && !before.has(live) ? live : null) || B.rowWith(marker) || null;
        if (el) S.el = el;
      }
      const len = el ? el.textContent.length : 0;
      const at = now();
      if (len > 0 && S.firstPaint == null) S.firstPaint = at;
      if (S.samples.length && len === 0 && S.samples[S.samples.length - 1].len > 0) S.blank++;
      S.rowsMin = Math.min(S.rowsMin, B.rows().length);
      S.samples.push({ t: at, len, live: !!(el && el.classList.contains("cv-live")) });
      if (S.anchor) {
        const a = S.anchor;
        if (a.el.isConnected) { const d = Math.abs(a.el.getBoundingClientRect().top - a.top); S.jumps.push(d); if (d > 1 && S.firstJumpAt == null) S.firstJumpAt = at; }
        else S.jumps.push(-1);
        const tl = B.timeline();
        if (tl) { S.tlMove = Math.max(S.tlMove || 0, Math.abs(tl.getBoundingClientRect().top - a.tlTop)); S.stMove = Math.max(S.stMove || 0, Math.abs(tl.scrollTop - a.st)); }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  };
  /** Hold the row at the middle of the timeline as the reading anchor: the view must not move it. */
  /** Opening a session: the first frame, counted from navigation start, with 20 rows painted. */
  B.opened = null;
  const watchOpen = () => { const tick = () => { if (B.opened != null) return; if (B.rows().length >= 20) { B.opened = now(); return; } if (now() < 30000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchOpen); else watchOpen();

  B.holdAnchor = () => {
    const tl = B.timeline(); const r = tl.getBoundingClientRect();
    const rows = B.rows();
    let best = null;
    for (const el of rows) { const b = el.getBoundingClientRect(); if (b.top >= r.top && b.bottom <= r.bottom - 40) { best = el; break; } }
    if (!best) best = rows.find(el => el.getBoundingClientRect().bottom > r.top) || null;
    if (!best || !B.sampler) return false;
    B.sampler.anchor = { el: best, top: best.getBoundingClientRect().top, tlTop: tl.getBoundingClientRect().top, st: tl.scrollTop };
    return true;
  };
})();`;
