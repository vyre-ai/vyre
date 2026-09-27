// @ts-check
// Now on a phone (docs/design/phone.md section 4), drawn by views/now.js under 760 px. The shell
// (js/app.js) draws the header and the Capsule; this is the page between them:
//
//   the setup reminder   one row when something is missing ("Add a passkey to send from this
//                        phone"), which opens that step in a sheet (js/phone-setup.js,
//                        js/first-passkey.js). The big setup cards are gone from here.
//   Needs you            one card, a row per item, oldest first: asks, held drafts, questions
//                        (js/needs.js) and Macs asking to pair (link.pending). Rows swipe
//                        (data-swipe, so the pager leaves them alone), tap opens the detail sheet
//                        (js/need-sheet.js), and real buttons carry the same actions.
//   Working              running sessions with their step count and latest step; when nothing
//                        runs, the two most recent sessions stand in.
//   From memory          one block: what memory learned today (memory.facts), in --recall-wash.
//
// The no-nag rule: approving or denying an ask, answering, Later and discarding prove nothing;
// only Send (in the sheet) asks for Face ID. Undo is honest: a deny or a discard waits out its
// 4 s toast before it is sent, and Undo cancels it; an approve goes at once, and its toast only
// says so. Later is this device only (need-rows.js snoozes).
//
// Light by default (section 13): Needs and Working follow events (the shell reloads needs.js on
// ask.* and gate.*; thread.* here). The fallback is one needs.load a minute, and none while hidden.

import { h, put, link, go } from "./dom.js";
import { attempt, on } from "./api.js";
import * as needs from "./needs.js";
import { initial, base, since } from "./fmt.js";
import { passkeyState, pushState, setupCard } from "./phone-setup.js";
import { firstPasskeyCard } from "./first-passkey.js";
import { standalone } from "./pwa.js";
import { openSheet } from "./sheet.js";
import { openNeedSheet, glyph, problem } from "./need-sheet.js";
import { titleOf, secondLine, thirdLine, ago, ariaLabel, presenceWord, swipeActions, swipeCommit, release, toastFor, deferred, snoozes,
  SWIPE_HINT, ACTION_W } from "./need-rows.js";
import { isMac } from "./machine.js";
import { threadHref } from "../chat/lib/routes.js";

const local = (() => { try { return window.localStorage; } catch { return null; } })();
const getLocal = (/** @type {string} */ k) => { try { return local?.getItem(k) ?? null; } catch { return null; } };
const setLocal = (/** @type {string} */ k, /** @type {string} */ v) => { try { local?.setItem(k, v); } catch {} };
const SWIPED_KEY = "vyre.needs.swiped";
const UNDO_MS = 4000;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** first-passkey.js's card is styled in pair.css, which pair.js loads only when it draws. */
const pairStyles = () => { if (!document.head.querySelector('link[href="/css/pair.css"]')) document.head.append(h("link", { rel: "stylesheet", href: "/css/pair.css" })); };

/** An item a push notification opened (/needs/:id): its sheet opens once Now has it. */
let wanted = /** @type {string | null} */ (null);
/** Ask Now to open this item's sheet when it next draws (views/needs.js, on a phone). */
export function wantSheet(/** @type {string} */ id) { wanted = id; window.dispatchEvent(new CustomEvent("vyre:want-need")); }

/** @param {any} ctx the view's context (views/now.js) */
export function phoneNow(ctx) {
  const word = presenceWord(navigator.userAgent, navigator.maxTouchPoints || 0);
  const later = snoozes(local);
  const remind = h("div", { class: "np-remind-slot" });
  const needsSec = h("section", { class: "np-sec np-needs", "aria-labelledby": "np-needs-h" });
  const workSec = h("section", { class: "np-sec", "aria-labelledby": "np-work-h" });
  const memSec = h("section", { class: "np-sec np-mem-sec" });
  const toastText = h("span", { class: "np-toast-t" });
  const toastUndo = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "np-toast-undo" }, "Undo"));
  const toast = h("div", { class: "np-toast", role: "status", "aria-live": "polite", hidden: true }, toastText, toastUndo);
  put(ctx.root, h("div", { class: "now np" }, remind, needsSec, workSec, memSec, toast));

  // ---- the setup reminder -----------------------------------------------------------------

  const drawRemind = async () => {
    const [keys, p, k] = await Promise.all([attempt("presence.keys"), pushState().catch(() => null), passkeyState().catch(() => null)]);
    if (!ctx.alive()) return;
    const boxHasNone = Array.isArray(keys.data) && !keys.data.some((/** @type {any} */ x) => x.kind === "passkey");
    const dismissed = !!getLocal("vyre.setup.dismissed");
    /** @type {{ text: string, open: () => void } | null} */
    let row = null;
    if (boxHasNone) row = { text: "Make your first passkey", open: () => stepSheet("Your first passkey", el => { pairStyles(); const c = firstPasskeyCard(); el.append(c.el); return c.stop; }) };
    else if (!dismissed && k && k.ok && !k.on) row = { text: "Add a passkey to send from this phone", open: setupSheet };
    else if (!dismissed && !standalone()) row = { text: "Add Vyre to your Home Screen", open: setupSheet };
    else if (!dismissed && p && p.ok && !p.on && p.permission !== "denied") row = { text: "Turn on notifications for what needs you", open: setupSheet };
    put(remind, row ? h("button", { type: "button", class: "np-remind", onclick: row.open },
      h("span", { class: "np-remind-t" }, row.text), glyph("right", 16)) : null);
  };
  /** A sheet around one setup step's own card. @param {string} title @param {(el: HTMLElement) => (() => void) | void} fill */
  const stepSheet = (title, fill) => {
    /** @type {(() => void) | void} */ let stop;
    openSheet({ title, build: body => { body.classList.add("np-step-body"); stop = fill(body); }, onClose: () => { stop?.(); drawRemind(); } });
  };
  // "Set up this phone": the card from phone-setup.js, inside the sheet. It removes itself when
  // every step is done or the user says Not now, and the sheet goes with it.
  const setupSheet = () => stepSheet("Set up this phone", body => {
    const card = setupCard();
    if (!card) return;
    body.append(card);
    const mo = new MutationObserver(() => { if (!card.isConnected) { mo.disconnect(); /** @type {any} */ (body.closest(".sheet-layer"))?.querySelector(".sheet-close")?.click(); } });
    mo.observe(body, { childList: true });
    return () => mo.disconnect();
  });
  drawRemind();
  ctx.cleanup(on("presence.enrolled", drawRemind));
  ctx.cleanup(on("presence.removed", drawRemind));

  // ---- Needs you ------------------------------------------------------------------------------

  /** Macs asking to pair, from link.pending. Empty where this machine is not a box. */
  let pairs = /** @type {any[]} */ ([]);
  const loadPairs = async () => {
    const r = await attempt("link.pending");
    if (!ctx.alive()) return;
    pairs = Array.isArray(r.data) ? r.data.map((/** @type {any} */ p) => ({ kind: "pair", id: "pair:" + p.id, at: Number(p.expires || Date.now()) - 600_000, pair: p })) : [];
    drawNeeds();
  };
  loadPairs();
  ctx.cleanup(on("link.pair-requested", loadPairs));
  ctx.cleanup(on("link.paired", loadPairs));

  /** Rows answered here and not gone yet: collapsed while their call waits or goes. */
  const hidden = new Set();
  /** The reason a commit failed, shown under line 3 until the next try. */
  const failed = new Map();
  /** Deferred calls behind an Undo toast. */
  const waiting = new Set();
  /** @type {Map<string, { el: HTMLElement, update: (n: any) => void }>} */
  const rows = new Map();
  let dragging = false, redraw = false;

  const visible = () => [...needs.current(), ...pairs]
    .filter(n => !hidden.has(n.id) && !(n.kind === "question" && later.has(n.id)))
    .sort((a, b) => a.at - b.at);

  const count = h("span", { class: "np-count" });
  const card = h("div", { class: "np-card" });
  const hint = h("p", { class: "np-hint" }, SWIPE_HINT);
  const nothing = h("p", { class: "np-nothing" }, "Nothing needs you.");
  put(needsSec, h("div", { class: "np-head" },
    h("h2", { class: "np-h", id: "np-needs-h" }, h("span", { class: "np-beacon", "aria-hidden": "true" }), "Needs you"), count));

  // The first load only: the card's shape in --hover, no shimmer (section 11).
  let loaded = needs.current().length > 0;
  const skeleton = h("div", { class: "np-card np-skel", "aria-hidden": "true" }, h("div", { class: "np-skel-row" }), h("div", { class: "np-skel-row" }));

  function drawNeeds() {
    if (dragging) { redraw = true; return; }
    const list = visible();
    if (!loaded && !list.length) { if (!skeleton.isConnected) needsSec.append(skeleton); return; }
    skeleton.remove();
    put(count, list.length ? String(list.length) : "");
    const want = new Set(list.map(n => n.id));
    for (const [id, r] of rows) if (!want.has(id)) { rows.delete(id); collapse(r.el); }
    if (!list.length) {
      // The last rows fold first; then the one line.
      setTimeout(() => { if (!visible().length) { hint.remove(); card.remove(); if (!nothing.isConnected) needsSec.append(nothing); } }, reduced() ? 0 : 190);
      return;
    }
    nothing.remove();
    if (!card.isConnected) needsSec.append(card);
    if (getLocal(SWIPED_KEY)) hint.remove(); else if (!hint.isConnected) card.after(hint);
    /** @type {Element | null} */ let prev = null;
    for (const n of list) {
      let r = rows.get(n.id);
      if (!r) { r = row(n); rows.set(n.id, r); } else r.update(n);
      const at = prev ? prev.nextElementSibling : card.firstElementChild;
      if (r.el !== at) card.insertBefore(r.el, at);
      prev = r.el;
    }
    if (wanted) { const n = list.find(x => x.id === wanted || x.id === "pair:" + wanted); if (n) { wanted = null; sheetFor(n); } }
  }

  /** Height to 0 over 180 ms, rows below move up; then gone. */
  function collapse(/** @type {HTMLElement} */ el) {
    if (reduced()) { el.remove(); return; }
    el.style.height = el.offsetHeight + "px";
    void el.offsetHeight;
    el.classList.add("np-collapsing");
    el.style.height = "0px";
    setTimeout(() => el.remove(), 200);
  }

  // ---- the toast --------------------------------------------------------------------------

  let toastTimer = 0;
  /** @type {(() => void) | null} */ let undoFn = null;
  function say(/** @type {string} */ text, /** @type {(() => void) | null} */ undo) {
    clearTimeout(toastTimer);
    put(toastText, text);
    undoFn = undo;
    toastUndo.hidden = !undo;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; undoFn = null; }, UNDO_MS);
  }
  toastUndo.addEventListener("click", () => { const f = undoFn; undoFn = null; toast.hidden = true; clearTimeout(toastTimer); f?.(); });

  /** Send every call still waiting on its toast: the page is being left, or hidden. */
  const flushAll = () => { for (const d of [...waiting]) d.flush(); };
  const onHide = () => { if (document.hidden) flushAll(); };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flushAll);
  ctx.cleanup(() => { flushAll(); document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", flushAll); });

  // ---- committing -------------------------------------------------------------------------

  const markSwiped = () => { if (!getLocal(SWIPED_KEY)) { setLocal(SWIPED_KEY, "1"); hint.remove(); } };
  const haptic = () => { try { if (/Android/.test(navigator.userAgent)) navigator.vibrate?.(10); } catch {} };
  const fail = (/** @type {any} */ n, /** @type {any} */ e) => { hidden.delete(n.id); failed.set(n.id, problem(e)); drawNeeds(); };

  /** Approve an ask at once (the owner's own act); the toast only says so. */
  function approve(/** @type {any} */ n) {
    failed.delete(n.id);
    hidden.add(n.id);
    drawNeeds();
    say(toastFor("approve").text, null);
    needs.answer(n, { label: "Approve", decision: "allow" }).then(() => { hidden.delete(n.id); }, e => fail(n, e));
  }

  /** Deny, Discard or a pair's Deny: collapsed now, sent when the toast ends, unless Undo. */
  function holdBack(/** @type {"deny"|"discard"} */ what, /** @type {any} */ n) {
    failed.delete(n.id);
    flushAll(); // one toast at a time: the one before goes now
    const run = n.kind === "pair"
      ? async () => { const r = await attempt("link.pair.deny", { id: n.pair.id }); if (r.error) throw r.error; pairs = pairs.filter(p => p.id !== n.id); }
      : () => needs.answer(n, what === "discard" ? { label: "Discard", decision: "reject" } : { label: "Deny", decision: "deny" });
    const d = deferred(run, UNDO_MS);
    waiting.add(d);
    hidden.add(n.id);
    drawNeeds();
    d.done.then(r => { waiting.delete(d); if (r.error) fail(n, r.error); else if (r.ran) { hidden.delete(n.id); drawNeeds(); } });
    say(toastFor(what).text, () => { if (d.cancel()) { hidden.delete(n.id); drawNeeds(); } });
  }

  /** Later: hidden on this device for an hour. Undo shows it again. */
  function snooze(/** @type {any} */ n) {
    later.snooze(n.id);
    drawNeeds();
    say(toastFor("later").text, () => { later.wake(n.id); drawNeeds(); });
  }

  /** @param {any} n @param {"right"|"left"} side */
  function commit(n, side) {
    haptic();
    markSwiped();
    const what = swipeCommit(n, side);
    if (what === "sheet") { sheetFor(n); return; }
    if (what === "approve") approve(n);
    else if (what === "later") snooze(n);
    else holdBack(what, n);
  }

  function sheetFor(/** @type {any} */ n) {
    openNeedSheet(n, { word,
      onDone: what => say(toastFor(what === "always" || what === "pair" ? "approve" : what).text, null),
      onLater: (what, x) => (what === "later" ? snooze(x) : holdBack(what, x)),
      onPaired: name => { say(`${name} is paired`, null); loadPairs(); } });
  }

  // ---- one row ------------------------------------------------------------------------------

  function row(/** @type {any} */ n) {
    const [rightL, leftL] = swipeActions(n);
    // A Mac session's ask (no swipe actions): a plain row that opens its sheet, no approve anywhere.
    const still = !rightL;
    const el = h("div", { class: "np-row", ...(still ? {} : { "data-swipe": "" }), "data-kind": n.kind });
    const revR = h("button", { type: "button", class: "np-rev np-rev-r", tabindex: "-1", "aria-hidden": "true" },
      h("span", { class: "np-rev-in" }, glyph(n.kind === "ask" ? "check" : n.kind === "question" ? "chat" : n.kind === "draft" ? "send" : "check", 24), h("span", null, rightL)));
    const revL = h("button", { type: "button", class: "np-rev np-rev-l", tabindex: "-1", "aria-hidden": "true" },
      h("span", { class: "np-rev-in" }, glyph("x", 24), h("span", null, leftL)));
    const tile = h("span", { class: "np-tile", "aria-hidden": "true" });
    const t1 = h("span", { class: "np-t1" }), time = h("span", { class: "np-time" });
    const t2 = h("span", { class: "np-t2" }), t3 = h("span", { class: "np-t3" });
    const err = h("span", { class: "np-err" });
    const main = h("button", { type: "button", class: "np-main" },
      tile, h("span", { class: "np-lines" }, h("span", { class: "np-l1" }, t1, time), t2, t3, err), h("span", { class: "np-chev", "aria-hidden": "true" }, glyph("right", 16)));
    const face = h("div", { class: "np-face" }, main);
    const kb = (/** @type {string} */ label, /** @type {() => void} */ fn) => h("button", { type: "button", class: "np-kb-b", onclick: fn }, label);
    const kbd = h("div", { class: "np-kb" });
    el.append(...(still ? [] : [revR, revL]), face, kbd);

    let cur = n;
    const update = (/** @type {any} */ x) => {
      cur = x;
      put(tile, x.kind === "pair" ? "m" : x.agent ? initial(x.agent) : glyph("terminal", 18));
      put(t1, titleOf(x));
      put(time, ago(x.at));
      const l2 = secondLine(x);
      put(t2, l2.text);
      t2.classList.toggle("np-mono", l2.mono);
      put(t3, thirdLine(x));
      const why = failed.get(x.id);
      put(err, why ? [h("span", { class: "np-failed" }, "failed"), " ", why] : null);
      main.setAttribute("aria-label", ariaLabel(x) + (why ? ` Failed: ${why}` : ""));
      const title = titleOf(x);
      put(kbd, still ? null : [kb(rightL, () => commit(cur, "right")), kb(leftL, () => commit(cur, "left"))], kb("Open", () => sheetFor(cur)));
      for (const b of kbd.children) b.setAttribute("aria-label", `${b.textContent}: ${title}`);
    };
    update(n);

    // The swipe: follows the finger 1:1, then springs; past 100 or a fling it commits, short of
    // that the action stays showing and a tap on it commits. Only the face's transform moves, at
    // most once a frame, and the face is promoted (np-drag, will-change) only while it moves.
    let rest = 0, x0 = 0, y0 = 0, dx = 0, v = 0, lastX = 0, lastT = 0, pid = -1, axis = /** @type {null|"x"|"y"} */ (null), moved = false, frame = 0;
    const follow = () => { frame = 0; place(dx, false); };
    const settle = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; } face.classList.remove("np-drag"); };
    face.addEventListener("transitionend", e => { if (e.target === face) face.classList.remove("np-spring"); });
    const place = (/** @type {number} */ x, /** @type {boolean} */ spring) => {
      const t = x ? `translateX(${x}px)` : "";
      // A spring only when the face really goes somewhere, so transitionend always ends it.
      face.classList.toggle("np-spring", spring && t !== face.style.transform && !reduced());
      face.style.transform = t;
      el.classList.toggle("np-show-r", x > 0);
      el.classList.toggle("np-show-l", x < 0);
    };
    face.addEventListener("pointerdown", e => {
      if (still || e.button !== 0 || pid !== -1) return;
      pid = e.pointerId; x0 = lastX = e.clientX; y0 = e.clientY; lastT = e.timeStamp; axis = null; v = 0; dx = rest; moved = false;
    });
    face.addEventListener("pointermove", e => {
      if (e.pointerId !== pid) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
        if (axis === "y") return;
        try { face.setPointerCapture(pid); } catch {}
        dragging = true; moved = true;
        face.classList.add("np-drag");
      }
      if (axis !== "x") return;
      const dt = e.timeStamp - lastT;
      if (dt > 0) v = (e.clientX - lastX) / dt;
      lastX = e.clientX; lastT = e.timeStamp;
      dx = rest + mx;
      if (!frame) frame = requestAnimationFrame(follow);
    });
    const end = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== pid) return;
      pid = -1;
      if (axis !== "x") { axis = null; return; }
      axis = null;
      dragging = false;
      settle();
      const r = release(dx, v);
      if (r === "commit-right" || r === "commit-left") { rest = 0; place(0, true); commit(cur, r === "commit-right" ? "right" : "left"); }
      else { rest = r === "open-right" ? ACTION_W : r === "open-left" ? -ACTION_W : 0; place(rest, true); }
      if (redraw) { redraw = false; drawNeeds(); }
    };
    face.addEventListener("pointerup", end);
    face.addEventListener("pointercancel", e => { if (e.pointerId === pid) { dx = rest; v = 0; end(e); } });
    // A tap: the detail sheet, or, with an action showing, closes it.
    main.addEventListener("click", e => {
      if (moved) { moved = false; e.preventDefault(); return; }
      if (rest) { rest = 0; place(0, true); return; }
      sheetFor(cur);
    });
    revR.addEventListener("click", () => { rest = 0; place(0, true); commit(cur, "right"); });
    revL.addEventListener("click", () => { rest = 0; place(0, true); commit(cur, "left"); });
    return { el, update };
  }

  ctx.cleanup(needs.watch(() => { loaded = true; drawNeeds(); }));
  drawNeeds();
  needs.load().finally(() => { loaded = true; if (ctx.alive()) drawNeeds(); });
  const onWant = () => drawNeeds();
  window.addEventListener("vyre:want-need", onWant);
  ctx.cleanup(() => window.removeEventListener("vyre:want-need", onWant));
  // The fallback: a minute, and never while hidden. The times on the rows move with it.
  const tick = window.setInterval(() => { if (!document.hidden && ctx.shown?.() !== false) { needs.load(); drawWorking(); } }, 60_000);
  ctx.cleanup(() => clearInterval(tick));

  // ---- Working ----------------------------------------------------------------------------

  /** Per running thread: tool steps this turn and the latest one, from thread.tool. */
  const steps = new Map();
  const drawWorking = async () => {
    const r = await attempt("threads.list", {});
    if (!ctx.alive()) return;
    const run = (r.data || []).filter((/** @type {any} */ t) => t.status !== "stopped");
    await Promise.all(run.filter((/** @type {any} */ t) => !steps.has(t.id) && !isMac(t)).map(async (/** @type {any} */ t) => {
      const g = await attempt("threads.get", { thread: t.id, limit: 60 });
      steps.set(t.id, stepsOf(g.data?.events || []));
    }));
    if (!ctx.alive()) return;
    const headRow = (/** @type {number | null} */ n) => h("div", { class: "np-head" }, h("h2", { class: "np-h", id: "np-work-h" }, "Working"), h("span", { class: "np-count" }, n ? String(n) : ""));
    if (run.length) { put(workSec, headRow(run.length), h("div", { class: "np-card" }, run.map(workRow))); return; }
    const c = await attempt("projects.catalog", { limit: 2 });
    if (!ctx.alive()) return;
    const recent = (c.data?.sessions || []).slice(0, 2);
    put(workSec, recent.length ? [headRow(null), h("p", { class: "np-sub" }, "Nothing is running. Your latest sessions:"), h("div", { class: "np-card" }, recent.map(recentRow))]
      : [headRow(null), h("p", { class: "np-nothing" }, "Nothing is running.")]);
  };
  const workRow = (/** @type {any} */ t) => {
    const s = steps.get(t.id) || { count: 0, last: "" };
    const href = t.agent && !isMac(t) ? `/agents/${encodeURIComponent(t.agent)}` : threadHref({ id: t.id, project: isMac(t) ? null : t.project });
    const right = t.status === "waiting" ? "Waiting on you" : s.count ? `${s.count} step${s.count === 1 ? "" : "s"}` : t.status === "starting" ? "Starting" : "";
    return link(href, { class: "np-wrow" },
      h("span", { class: "np-tile", "aria-hidden": "true" }, initial(t.agent || t.name)),
      h("span", { class: "np-lines" },
        h("span", { class: "np-l1" }, h("span", { class: "np-t1" }, t.name || t.id), h("span", { class: "np-time" }, right)),
        h("span", { class: "np-t2" }, s.last || (t.agent ? `${t.agent} is on it` : "Working")),
        t.projectName ? h("span", { class: "np-t3" }, t.projectName) : null),
      h("span", { class: "np-chev", "aria-hidden": "true" }, glyph("right", 16)));
  };
  const recentRow = (/** @type {any} */ s) => link(threadHref({ id: s.id, project: !isMac(s) ? s.projects?.[0] || null : null }), { class: "np-wrow" },
    h("span", { class: "np-tile", "aria-hidden": "true" }, glyph("chat", 16)),
    h("span", { class: "np-lines" },
      h("span", { class: "np-l1" }, h("span", { class: "np-t1" }, s.label || s.title || s.id), h("span", { class: "np-time" }, s.last ? since(s.last) : "")),
      h("span", { class: "np-t2" }, [base(s.cwd), s.turns ? `${s.turns} turn${s.turns === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "))),
    h("span", { class: "np-chev", "aria-hidden": "true" }, glyph("right", 16)));
  drawWorking();
  let wt = 0;
  const soon = () => { clearTimeout(wt); wt = window.setTimeout(drawWorking, 400); };
  ctx.on("thread.started", soon); ctx.on("thread.finished", soon); ctx.on("thread.stopped", soon);
  ctx.on("thread.sent", (/** @type {any} */ e) => { if (e.thread) steps.set(e.thread, { count: 0, last: "" }); });
  ctx.on("thread.tool", (/** @type {any} */ e) => {
    if (!e.thread || e.payload?.phase !== "started") return;
    const s = steps.get(e.thread) || { count: 0, last: "" };
    steps.set(e.thread, { count: s.count + 1, last: stepWords(e.payload) });
    soon();
  });
  ctx.cleanup(() => clearTimeout(wt));

  // ---- From memory ------------------------------------------------------------------------

  (async () => {
    const f = await attempt("memory.facts", { limit: 50 });
    if (!ctx.alive() || f.error) return;
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const fact = (f.data?.facts || []).find((/** @type {any} */ x) => (x.seen || x.since || 0) >= t0.getTime());
    if (!fact) return;
    put(memSec, link(`/find?q=${encodeURIComponent(fact.subject?.name || fact.text)}`, { class: "np-mem" },
      h("span", { class: "np-mem-h" }, glyph("history", 14), "From memory"),
      h("span", { class: "np-mem-t" }, fact.text),
      fact.source ? h("span", { class: "np-mem-s" }, `from ${fact.source}`) : null));
  })();
}

/** Tool steps in the current turn (after the last thread.sent), and the latest one, in words. */
export function stepsOf(/** @type {{ type: string, payload: any }[]} */ events) {
  let count = 0, last = "";
  for (const e of events) {
    if (e.type === "thread.sent") { count = 0; last = ""; }
    else if (e.type === "thread.tool" && e.payload?.phase === "started") { count++; last = stepWords(e.payload); }
  }
  return { count, last };
}

/** "Rendering reports/q3.pdf" is more than the box says; "Edit reports/q3.tsx" is what it says. */
function stepWords(/** @type {any} */ p) {
  const s = String(p?.summary || p?.tool || "").trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
