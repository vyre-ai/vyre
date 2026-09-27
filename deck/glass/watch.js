// @ts-check
// The live screen (board GlassWatch; ADR 0005 decision 1, ADR 0003). glass.open gives a one-time
// ticket for /v1/streams/computers/glass, and noVNC draws what the relay passes through.
//
// Rules this file keeps:
//  - view-only unless this surface holds the take-over; scaleViewport on, resizeSession off;
//  - quality and compression by device: laptop 6/2, phone 5/4, slow link 2/6;
//  - a relayed link (glass.open's link.path is relay or peer-relay) counts as a slow link, and the badge says "relayed";
//  - a hidden tab disconnects and keeps the last frame, dimmed; visible again, a fresh glass.open;
//  - after an unclean close, reconnect with a fresh ticket at 1, 2, 4 ... 30 s, only while
//    visible, never after 4003 (bad ticket);
//  - no timers while hidden. The only interval is the take-over clock, visible and holding only.

import { h, put, link as anchor } from "../js/dom.js";
import { attempt, call } from "../js/api.js";
import { gicon, errText, viewerCount, holderOf, surfaceKind } from "./util.js";
import { takeover } from "./takeover.js";
import { attach } from "./input.js";
import { pinchZoom, softKeyboard } from "./phone.js";

/**
 * A computer's own comings and goings. Opening Glass thaws a frozen computer only once the stream
 * connects, after glass.opened, so the state is read again on each of these too.
 */
export const LIFECYCLE = ["computer.created", "computer.checked-out", "computer.thawed", "computer.frozen", "computer.stopped"];

const EVENTS = ["computer.taken-over", "computer.handed-back", "computer.idle-warning", "computer.shielded", "computer.unshielded",
  "glass.opened", "glass.closed", "glass.taken", "glass.released", ...LIFECYCLE];

/** Is the box reaching this device through a relay? `link` is glass.open's { path, latencyMs }. */
export const relayed = link => Boolean(link && (link.path === "relay" || link.path === "peer-relay"));

/**
 * [quality, compression] for this device and link (ADR 0005 decision 1).
 * @param {boolean} phone @param {{ path?: string, latencyMs?: number|null } | null} [link]
 */
export function levels(phone, link = null) {
  const c = typeof navigator === "undefined" ? null : /** @type {any} */ (navigator).connection;
  if (c && (c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType || ""))) return [2, 6];
  if (relayed(link)) return [2, 6];
  return phone ? [5, 4] : [6, 2];
}

/**
 * @param {{ ctx: any, name: string, target: string, surface: string, info: any, phone: boolean,
 *   root: HTMLElement, slot: HTMLElement, status: HTMLElement }} o
 * slot is the header's right side (desktop); status is the phone header's live dot and word.
 */
export function mountScreen(o) {
  const { ctx, name, target, surface, phone } = o;
  let dead = false;
  /** @type {any} */ let rfb = null;
  let gen = 0, backoff = 1, retry = 0, session = /** @type {string|null} */ (null);
  let detachInput = () => {};
  let zoom = /** @type {ReturnType<typeof pinchZoom> | null} */ (null);
  let conn = "connecting";   // connecting | live | hidden | waiting | refused | ended | error | noscreen
  /** @type {{ path: string, latencyMs: number|null } | null} how the box reaches this device, from glass.open */
  let link = null;
  let why = "";
  const s = {
    name, target, surface, phone,
    info: o.info,
    holder: holderOf(o.info?.takeover),
    width: o.info?.width || 1440, height: o.info?.height || 900,
    visible: () => document.visibilityState === "visible",
    canTake: () => conn === "live" || conn === "noscreen",
  };

  // ---- elements ----------------------------------------------------------------------------
  const host = h("div", { class: "gl-rfb" });
  const zoomView = h("div", { class: "gl-zoom" }, host);
  const snap = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "gl-snap", hidden: true, "aria-hidden": "true" }));
  const over = h("div", { class: "gl-over" });
  const badge = h("div", { class: "gl-badge mono" });
  const panelSize = h("span", { class: "faint" });
  const stage = h("div", { class: "gl-stage", role: "img", "aria-label": `Live view of ${name}'s screen` },
    h("div", { class: "gl-panel mono" }, h("span", { class: "gl-panel-me" }, `${name}@box-${name}`), h("span", { style: { flexGrow: "1" } }), panelSize),
    h("div", { class: "gl-screen" }, zoomView, snap, over), badge);
  const bar = h("div", { class: "gl-barslot" });
  const notice = h("div", { class: "gl-noticeslot", "aria-live": "polite" });
  const caption = h("div", { class: "gl-caption" });
  const side = h("aside", { class: "gl-side", "aria-label": "Activity" });
  const log = h("div", { class: "gl-log" });
  const logRows = [];
  const kb = phone ? softKeyboard(() => (tk.mine() && conn === "live" ? rfb : null)) : null;
  const zoomReset = h("button", { type: "button", class: "btn btn-ghost btn-sm", hidden: true, onclick: () => zoom?.reset() }, "Fit");
  const meta = h("span", { class: "code" });
  const fullBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Full screen", title: "Full screen",
    onclick: () => { const el = /** @type {any} */ (stage); (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); } }, gicon("full", 18));
  const acts = h("div", { class: "gl-acts" });
  const watchers = h("div", { class: "gl-watchers" });

  const tk = takeover(s, {
    changed: () => { applyHolding(); draw(); },
    notice: el => put(notice, el),
  });

  // ---- layout ------------------------------------------------------------------------------
  if (phone) {
    put(o.root, h("div", { class: "gl-phone" },
      h("div", { class: "gl-phone-screen" }, stage,
        h("div", { class: "gl-meta" }, meta, h("span", { style: { flexGrow: "1" } }), zoomReset, kb?.btn, fullBtn), kb?.field),
      notice, bar, caption,
      h("section", { class: "gl-phone-log", "aria-label": "Activity" }, h("div", { class: "lbl" }, "Activity"), log),
      h("div", { class: "gl-phone-acts" }, h("p", { class: "small faint" }, ""), acts)));
  } else {
    put(o.slot, watchers, acts);
    put(o.root, notice, h("div", { class: "gl-stagewrap" },
      h("div", { class: "gl-col" }, stage, bar, caption),
      side));
  }

  // ---- drawing -----------------------------------------------------------------------------
  function draw() {
    if (dead) return;
    const n = viewerCount(s.info?.viewers);
    const others = Math.max(0, n - 1);
    put(watchers, gicon("eye", 16), h("span", { class: "small muted" },
      others === 0 ? "Only you are watching" : `You and ${others} other${others === 1 ? "" : "s"} are watching`));
    put(acts, tk.actions());
    put(bar, tk.bar() || tk.banner());
    stage.classList.toggle("gl-held", tk.mine());
    stage.classList.toggle("gl-private", !!(tk.mine() && s.holder?.private));
    put(badge, conn === "live" ? [h("span", { class: "dot signal" }), tk.mine() ? "You have control" : "Live",
      relayed(link) ? h("span", { class: "gl-badge-note", title: "The box reaches this device through a relay, so the screen sends fewer frames" }, "relayed") : null]
      : conn === "hidden" ? "Paused" : conn === "refused" || conn === "error" || conn === "ended" ? "Offline" : "Connecting");
    badge.classList.toggle("gl-badge-live", conn === "live");
    put(panelSize, conn === "live" ? `${s.width} × ${s.height}` : "");
    put(meta, conn === "live" ? `${s.width} × ${s.height} · ${tk.mine() ? "you have the keyboard" : "view only"}` : conn === "hidden" ? "paused" : "not connected");
    if (kb) kb.btn.hidden = !(tk.mine() && conn === "live");
    const word = conn === "live" ? "Live" : conn === "hidden" ? "Paused" : conn === "connecting" || conn === "waiting" || conn === "noscreen" ? "Connecting" : "Offline";
    if (o.status) put(o.status, h("span", { class: "gl-live-dot" + (conn === "live" ? " on" : "") }), h("span", { class: "lbl" }, word));
    const holdingPriv = tk.mine() && s.holder?.private;
    put(caption, h("span", { class: "lbl gl-cap-lbl" }, tk.mine() ? "You" : "Now"),
      h("p", null, tk.mine() ? (holdingPriv ? `Sign in, then hand back. ${name} cannot see this page until you do.` : "You have control. Hand it back when you're done.")
        : tk.other() ? `${name} is paused while someone else drives.` : stateLine()));
    if (!phone) {
      const hold = tk.side();
      put(side, hold || [h("div", { class: "gl-side-head" }, h("span", { class: "lbl" }, "Activity"), h("span", { class: "code" }, "while you watch")),
        log, h("div", { class: "gl-side-foot small muted" },
          `Take over pauses ${name}'s hands until you hand back. Sign in privately also hides the page from ${name}, for passwords.`)]);
    }
    if (phone) {
      const box = /** @type {HTMLElement} */ (o.root.querySelector(".gl-phone-acts"));
      if (box) { box.hidden = tk.mine(); put(/** @type {HTMLElement} */ (box.firstChild), `${name} pauses while you drive. Hand it back when you're done.`); }
    }
    if (!logRows.length) put(log, h("div", { class: "empty small" }, "Take-overs, hand-backs and who opens this screen show here while you watch."));
    drawOver();
  }

  function stateLine() {
    const st = s.info?.state;
    if (phone) return st === "working" ? `${name} is working.` : `Watching ${name}'s screen.`;
    if (st === "working") return `${name} is working. You are watching live; nothing you do here reaches the screen until you take over.`;
    if (st === "frozen" || st === "idle") return `${name}'s computer is ${st}. Watching keeps it awake.`;
    return `Watching ${name}'s screen. Nothing you do here reaches it until you take over.`;
  }

  /** [title, detail] for the overlay. */
  function overText() {
    switch (conn) {
      case "connecting": return [`Connecting to ${name}'s screen`, "Asking the box for a one-time ticket."];
      case "noscreen": return [`Connecting to ${name}'s screen`, why || "The box did not hand out a screen stream. It may still be starting."];
      case "waiting": return [`Reconnecting to ${name}'s screen`, why];
      case "hidden": return ["Paused while this tab was hidden", `Glass let go of ${name}'s screen so it can rest. It reconnects when you come back.`];
      case "refused": return ["The box refused the screen ticket", "Reload the page to ask for a new one."];
      case "ended": return [`${name}'s screen closed`, why];
      case "error": return [`Could not open ${name}'s screen`, why];
      case "failed": return [`${name}'s computer did not start`,
        `${why}. Press Restart computer on ${name}'s page, then Retry. If it fails again, the box's log says why.`];
      default: return ["", ""];
    }
  }

  function drawOver() {
    const [t, d] = overText();
    over.hidden = conn === "live";
    const retryBtn = conn === "ended" || conn === "error" || conn === "noscreen" || conn === "failed"
      ? h("button", { type: "button", class: "btn btn-sm", onclick: () => { backoff = 1; connect(); } }, conn === "failed" ? "Retry" : "Try again") : null;
    const restart = conn === "failed" ? anchor(`/agents/${encodeURIComponent(name)}`, { class: "link small" }, `Open ${name}'s page`) : null;
    put(over, h("div", { class: "gl-over-card" },
      h("span", { class: "gl-over-dot" + (conn === "connecting" || conn === "waiting" ? " on" : "") }),
      h("div", { class: "gl-over-t" }, t), d ? h("div", { class: "gl-over-d small" }, d) : null, retryBtn, restart));
  }

  function applyHolding() {
    detachInput(); detachInput = () => {};
    if (!rfb) return;
    const mine = tk.mine() && conn === "live";
    rfb.viewOnly = !mine;
    if (mine) {
      detachInput = attach(rfb, host, {
        onHandBack: () => tk.release(),
        onPaste: (sent, cut) => { if (cut) addLog(`Pasted the first ${sent} characters; Glass types at most 4 KB of a paste.`); },
      });
      if (!phone) rfb.focus({ preventScroll: true });
    }
  }

  let lastLog = { text: "", at: 0 };
  function addLog(text) {
    // A take-over arrives twice, as computer.taken-over and glass.taken (and a hand-back as
    // computer.handed-back and glass.released): one line in the log, not two.
    const now = Date.now();
    if (text === lastLog.text && now - lastLog.at < 3000) return;
    lastLog = { text, at: now };
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: phone ? undefined : "2-digit", hourCycle: "h23" });
    logRows.unshift(h("div", { class: "gl-log-row" }, h("span", { class: "code" }, t), h("span", null, text)));
    logRows.length = Math.min(logRows.length, 40);
    put(log, logRows);
  }

  // ---- connection --------------------------------------------------------------------------
  async function connect() {
    if (dead || !s.visible()) return;
    clearTimeout(retry); retry = 0;
    const my = ++gen;
    if (conn !== "waiting") { conn = "connecting"; draw(); }
    await closeSession();
    const r = await attempt("glass.open", { target, surface });
    if (dead || my !== gen) { if (r.data?.session) call("glass.close", { session: r.data.session }).catch(() => {}); return; }
    if (r.error) {
      why = errText(r.error);
      if (r.error.code === "offline") return later(why);
      conn = "error"; draw(); return;
    }
    session = r.data.session || null;
    link = r.data.link || null;
    const sc = r.data.screen;
    if (!sc || !sc.path) { conn = "noscreen"; why = ""; draw(); return; }
    if (sc.width && sc.height) { s.width = sc.width; s.height = sc.height; stage.style.setProperty("--ratio", `${sc.width} / ${sc.height}`); }
    let RFB;
    try { RFB = (await import("./vendor/novnc/core/rfb.js")).default; } catch (e) { conn = "error"; why = "The screen viewer did not load."; draw(); return; }
    if (dead || my !== gen) return;
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + sc.path;
    let r2;
    try { r2 = new RFB(host, url, { shared: true }); } catch (e) { conn = "error"; why = String(/** @type {any} */ (e)?.message || e); draw(); return; }
    rfb = r2;
    canvas = host.querySelector("canvas");
    // The relay does not take QEMU extended key events (ADR 0005): keysyms only, from event.key.
    try { Object.defineProperty(r2, "_qemuExtKeyEventSupported", { get: () => false, set: () => {}, configurable: true }); } catch {}
    r2.viewOnly = true;
    r2.scaleViewport = true;
    r2.resizeSession = false;
    r2.clipViewport = false;
    r2.focusOnClick = !phone;
    r2.background = "transparent";
    const [q, c] = levels(phone, link);
    r2.qualityLevel = q;
    r2.compressionLevel = c;
    let code = 0, reason = "";
    const sock = r2._sock;
    const orig = sock?._eventHandlers?.close;
    if (orig) sock._eventHandlers.close = (/** @type {CloseEvent} */ e) => { code = e.code; reason = e.reason || ""; orig(e); };
    r2.addEventListener("connect", () => {
      if (rfb !== r2) return;
      backoff = 1; conn = "live"; why = "";
      snap.hidden = true;
      applyHolding(); draw();
    });
    r2.addEventListener("disconnect", (/** @type {any} */ e) => {
      if (rfb !== r2) return;   // we closed it on purpose
      rfb = null; detachInput(); detachInput = () => {};
      keepFrame();
      if (code === 4003) { conn = "refused"; draw(); return; }
      // The computer did not boot: say why, and wait for a person rather than retrying a broken one.
      if (code === 4001 && reason) { conn = "failed"; why = reason; draw(); return; }
      if (code === 1000 && e.detail?.clean) { conn = "ended"; why = "The box closed the stream."; draw(); return; }
      later(code === 4001 ? `${name}'s computer is not running yet.` : code === 4008 ? "The stream hit a protocol error." : "The connection dropped.");
    });
    r2.addEventListener("securityfailure", (/** @type {any} */ e) => { why = e.detail?.reason || "The box refused the screen."; });
    if (phone) {
      zoom?.detach();
      zoom = pinchZoom(host, zoomView, z => { zoomReset.hidden = z === 1; });
    }
  }

  /** Reconnect later with a fresh ticket, backing off, only while visible. */
  function later(reason) {
    conn = "waiting"; why = `${reason} Trying again in ${backoff} s.`;
    draw();
    if (!s.visible() || dead) return;
    clearTimeout(retry);
    retry = window.setTimeout(connect, backoff * 1000);
    backoff = Math.min(30, backoff * 2);
  }

  /** Copy the last frame so a paused view is not blank. noVNC removes its canvas on disconnect, so
   * the canvas is remembered when it is made. */
  let canvas = /** @type {HTMLCanvasElement | null} */ (null);
  function keepFrame() {
    const c = canvas;
    if (!c || !c.width || !c.height) return;
    try {
      snap.width = c.width; snap.height = c.height;
      snap.getContext("2d")?.drawImage(c, 0, 0);
      snap.hidden = false;
    } catch {}
  }

  function drop() {
    gen++;
    clearTimeout(retry); retry = 0;
    const r = rfb;
    rfb = null;
    detachInput(); detachInput = () => {};
    if (r) { keepFrame(); try { r.disconnect(); } catch {} }
    put(host);
  }

  async function closeSession() {
    const sid = session;
    session = null;
    if (sid) await attempt("glass.close", { session: sid });
  }

  const onVis = () => {
    if (dead) return;
    if (document.visibilityState === "hidden") {
      drop(); tk.stop(); closeSession();
      conn = "hidden"; draw();
    } else {
      backoff = 1; tk.timer(); connect();
    }
  };
  document.addEventListener("visibilitychange", onVis);
  document.addEventListener("keydown", tk.key);

  // ---- events ------------------------------------------------------------------------------
  const agentOf = e => e.payload?.agent || (String(e.payload?.target || "").startsWith("computer:") ? e.payload.target.slice(9) : null);
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const r = await attempt("glass.targets");
    refreshing = false;
    const row = r.data?.find?.((/** @type {any} */ t) => t.target === target);
    if (row && !dead) {
      const had = tk.mine();
      s.info = row;
      if (row.takeover !== undefined) s.holder = holderOf(row.takeover);
      if (had && !tk.mine()) addLog(`The keyboard went back to ${name}.`);
      applyHolding(); draw();
    }
  }
  for (const type of EVENTS) ctx.on(type, (/** @type {any} */ e) => {
    if (dead) return;
    if (agentOf(e) !== name && e.payload?.target !== target) return;
    const p = e.payload || {};
    const who = p.surface === surface ? "You" : `Someone on ${surfaceKind(p.surface)}`;
    switch (e.type) {
      case "computer.taken-over": case "glass.taken":
        if (!s.holder || s.holder.surface !== p.surface) s.holder = { surface: p.surface, since: p.since || e.at || Date.now(), private: !!p.private };
        addLog(`${who} took the keyboard${p.private ? " to sign in privately" : ""}.`);
        break;
      case "computer.idle-warning":
        if (p.surface !== surface) return;
        // The countdown runs on this clock: the box's `at` less the event's own time is what is left.
        s.idleAt = p.at ? Date.now() + Math.max(0, Number(p.at) - Number(e.at || Date.now())) : 0;
        break;
      case "computer.handed-back": case "glass.released":
        if (s.holder && (!p.surface || s.holder.surface === p.surface)) s.holder = null;
        if (p.surface === surface) s.idleAt = 0;
        if (p.why === "idle") {
          addLog(`Handed back to ${name} after ${Math.round(Number(p.idle_ms) / 60_000)} min idle.`);
          if (p.surface === surface) tk.idled(p.idle_ms);
        } else addLog(`${p.surface === surface ? "You" : "The keyboard"} ${p.surface === surface ? "handed back" : "went back"} to ${name}.`);
        break;
      case "computer.shielded": addLog(`${name} cannot see the page while someone signs in.`); break;
      case "computer.unshielded": addLog(`${name} can see the page again${p.origin ? ` (${p.origin})` : ""}.`); break;
      case "glass.opened": if (p.surface !== surface) addLog(`Someone started watching from ${surfaceKind(p.surface)}.`); refresh(); return;
      case "glass.closed": refresh(); return;
      default: if (LIFECYCLE.includes(e.type)) { refresh(); return; }
    }
    applyHolding(); draw();
  });

  draw();
  if (s.visible()) connect(); else { conn = "hidden"; draw(); }

  return {
    unmount() {
      dead = true;
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("keydown", tk.key);
      tk.stop();
      zoom?.detach();
      drop();
      closeSession();
    },
  };
}

