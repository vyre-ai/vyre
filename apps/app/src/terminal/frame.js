// The terminal page: xterm.js talking the term socket protocol (client.js), inside an iframe on the web and a WebView on a phone.
// One implementation on every device. The host app (Terminal.tsx) speaks to it with messages; nothing here knows React.
//
// host -> page   {t:"init", theme, fontSize, fontFamily}  colours and type, once and when the app's theme changes
//                {t:"ticket", id, url}                   the answer to a "ticket" request: a ws URL that carries from=<offset>
//                {t:"ctrl", on}  sticky ctrl armed or not   {t:"key", d}  keys from the accessory row   {t:"paste", d}  text to paste   {t:"take"}   {t:"focus"}
//                {t:"copy"}  copy the selection (answers {t:"copied"})   {t:"font", px}   {t:"nudge"}  reconnect now
// page -> host   {t:"ready"}   {t:"ticket", id, from}  a ticket for this offset please
//                {t:"state", state, offset, owner, cols, rows}   {t:"selection", text}   {t:"mode", appCursor}
//                {t:"font", px}   {t:"copied", text}   {t:"ctrl", on:false}  the armed ctrl was used   {t:"bell"}
import { Terminal } from "./xterm.js";
import { FitAddon } from "./addon-fit.js";
import { TermClient } from "./client.js";
import { applyCtrl } from "./keys.js";

const native = typeof window.ReactNativeWebView !== "undefined";
const post = (m) => { try { native ? window.ReactNativeWebView.postMessage(JSON.stringify(m)) : window.parent.postMessage(m, "*"); } catch {} };

const FONT_MIN = 8, FONT_MAX = 28;
const el = document.getElementById("t");
const term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 13, lineHeight: 1.25, allowProposedApi: true, macOptionIsMeta: true, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(el);

let pending = new Map();
let n = 0;
const client = new TermClient({
  getTicket: (from) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    post({ t: "ticket", id, from });
    setTimeout(() => { if (pending.delete(id)) reject(new Error("no ticket")); }, 15000);
  }),
  onBytes: (u8) => term.write(u8, checkMode),
  onCut: () => term.reset(),
  onSize: () => report(),
  onState: () => report(),
});

let lastMode = false;
function checkMode() {
  const app = Boolean(term.modes && term.modes.applicationCursorKeysMode);
  if (app !== lastMode) { lastMode = app; post({ t: "mode", appCursor: app }); }
}
function report() { post({ t: "state", state: client.state, offset: client.offset, owner: client.owner, cols: term.cols, rows: term.rows }); }

// Keys typed here: the first one from a screen that does not own the size takes it, so a phone is never stuck at a laptop's size.
// Sticky ctrl (armed from the accessory row) turns the next typed character into its control byte.
let ctrlOn = false;
term.onData((d) => {
  if (ctrlOn) { const r = applyCtrl({ ctrl: true }, d); ctrlOn = false; d = r.send; post({ t: "ctrl", on: false }); }
  if (client.open && !client.owner) client.take();
  client.input(d);
});
term.onBell(() => post({ t: "bell" }));
term.onSelectionChange(() => post({ t: "selection", text: term.getSelection() }));

let fitTimer = null;
function refit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    try { fit.fit(); } catch {}
    client.resize(term.cols, term.rows);
    report();
  }, 60);
}
new ResizeObserver(refit).observe(el);

function setFont(px) {
  const v = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
  if (v === term.options.fontSize) return;
  term.options.fontSize = v;
  refit();
  post({ t: "font", px: v });
}

// Pinch: two fingers scale the text. The browser's own pinch zoom is off (touch-action, viewport).
let pinch = null;
const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
el.addEventListener("touchstart", (e) => { if (e.touches.length === 2) pinch = { d: dist(e), px: term.options.fontSize }; }, { passive: true });
el.addEventListener("touchmove", (e) => {
  if (pinch && e.touches.length === 2) { e.preventDefault(); setFont(pinch.px * (dist(e) / pinch.d)); }
}, { passive: false });
el.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true });

// Desktop: Ctrl+Shift+C copies, Ctrl+Shift+V pastes (Cmd+C and Cmd+V work on their own).
term.attachCustomKeyEventHandler((e) => {
  if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC") { copy(); return false; }
  if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyV") { navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {}); return false; }
  return true;
});
function copy() {
  // The selection, or with none (touch has no easy way to select) what is on the screen now.
  let text = term.getSelection();
  if (!text) {
    const b = term.buffer.active, rows = [];
    for (let y = b.viewportY; y < b.viewportY + term.rows; y++) { const l = b.getLine(y); if (l) rows.push(l.translateToString(true)); }
    text = rows.join("\n").replace(/\s+$/, "");
  }
  if (text) { try { navigator.clipboard.writeText(text); } catch {} }
  post({ t: "copied", text });
}

function applyTheme(m) {
  if (m.theme) {
    term.options.theme = m.theme;
    document.documentElement.style.background = document.body.style.background = m.theme.background;
  }
  if (m.fontFamily) term.options.fontFamily = m.fontFamily;
  if (m.fontSize) term.options.fontSize = m.fontSize;
  refit();
}

function onMessage(ev) {
  let m = ev.data;
  if (typeof m === "string") { try { m = JSON.parse(m); } catch { return; } }
  if (!m || typeof m !== "object") return;
  if (m.t === "init") { applyTheme(m); client.connect(); }
  else if (m.t === "ticket") { const p = pending.get(m.id); pending.delete(m.id); if (p) (m.url ? p.resolve({ url: m.url }) : p.reject(new Error(m.error || "no ticket"))); }
  else if (m.t === "key") { if (client.open && !client.owner) client.take(); client.input(String(m.d)); }
  else if (m.t === "paste") term.paste(String(m.d));
  else if (m.t === "take") client.take();
  else if (m.t === "ctrl") ctrlOn = Boolean(m.on);
  else if (m.t === "focus") term.focus();
  else if (m.t === "copy") copy();
  else if (m.t === "font") setFont(Number(m.px));
  else if (m.t === "nudge") client.nudge();
  else if (m.t === "theme") applyTheme(m);
}
window.addEventListener("message", onMessage);
document.addEventListener("message", onMessage);
// A tab that comes back to the front reconnects now instead of waiting out the backoff.
document.addEventListener("visibilitychange", () => { if (!document.hidden) client.nudge(); });
window.addEventListener("online", () => client.nudge());
window.__term = { term, client };
post({ t: "ready" });
