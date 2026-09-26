// @ts-check
// The Capsule's main process: one floating panel, a menu-bar mark, the double-Control listener,
// and the link to vyred.
//
// What it carries over from the prototype, each learned the hard way:
//   - The window is an NSPanel (type "panel") at screen-saver level on every Space. Only a panel
//     joins another app's fullscreen Space; a normal window reported itself hidden behind a
//     fullscreen terminal, which is where people spend their day.
//   - Focus follows the user's gesture and nothing else. A focused box in a panel over another
//     app once swallowed what the user was typing into their terminal. So a question arriving
//     from an agent turns the menu-bar dot Beacon and waits; it never opens the Capsule and never
//     takes the keyboard (floor rule 6).
//   - Escape hides the window rather than blurring the box: blurring alone does not reliably
//     hand the keyboard back to the app behind.
//   - The event stream lives here, not in the page. A hidden window's timers are throttled, and
//     the events that matter most arrive while it is hidden.
//   - When vyred goes away, everything on screen from it is cleared and the Capsule says so.
//     A list that outlived its daemon once read as live work for half an hour.
//   - It runs from source (`vyre capsule --dev`). A packaged app runs app.asar, so an edit to the
//     source changes nothing until it is repackaged; `vyre capsule` checks for that.

import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, socketPath } from "../lib/vyred.js";
import { Bridge } from "../lib/bridge.js";
import { Launcher } from "../lib/launcher.js";
import { Apps, Frecency } from "../lib/local.js";
import { LocalHelper } from "../lib/helper.js";
import { Icons } from "../lib/icons.js";
import { Clips } from "../lib/clips.js";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV = !app.isPackaged;
const DRIVEN = DEV && Boolean(process.env.VYRE_CAPSULE_DRIVE);
const BIN = process.env.VYRE_CAPSULE_BIN || (DEV ? path.join(HERE, "..", "bin") : path.join(process.resourcesPath, "bin"));
const WIDTH = 560;
/** Room around the Capsule for the shadow the page draws; the window itself is transparent. */
const MARGIN = { x: 24, top: 8, bottom: 40 };

app.setName("Vyre");
process.title = "Vyre Capsule";
const say = obj => { if (DEV || process.env.VYRE_CAPSULE_LOG) try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch {} };

// One Capsule per user. Running it again (`vyre capsule`) is how a terminal asks to see it.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const vyred = client(socketPath());
const bridge = new Bridge(vyred);
// Local results: this Mac only, working with vyred down. What the user picks is remembered beside
// vyred's home (ids and six-letter prefixes, never whole queries), not in vyred.
const HOME = process.env.VYRE_HOME || path.join(os.homedir(), ".vyre");
const helper = new LocalHelper(path.join(BIN, "local"));
// Clipboard history: on this Mac only, in the Capsule's own app-data folder. Its watcher is the one
// thing that runs while the Capsule is hidden (one integer read every 750 ms, in the helper).
// A test run never reads the user's clipboard: it watches a private "vyre-" pasteboard and keeps
// its history beside the test's vyred home.
const clips = DRIVEN
  ? new Clips({ file: path.join(HOME, "capsule-test-clips.json"), helper, board: "vyre-drive-" + process.pid })
  : new Clips({ file: path.join(app.getPath("userData"), "clips.json"), helper });
const launcher = new Launcher({ apps: new Apps(), helper, clips,
  frecency: new Frecency(path.join(HOME, "capsule", "frecency.json")), copy: t => clipboard.writeText(t) });
/** Icons, bounded, in the Capsule's own app-data folder ("-2": the helper once drew them a quarter size). Asked for only while the page is showing results. */
let icons = /** @type {Icons|null} */ (null);
const iconsNow = () => (icons ||= new Icons({ dir: path.join(app.getPath("userData"), "icons-2"), helper }));
/** Results with the icons already known, so a row draws its picture in the same frame. */
const withIcons = r => {
  if (!r || !r.results) return r;
  const known = iconsNow().peek(r.results);
  return { ...r, results: r.results.map(x => (known[x.id] ? { ...x, icon: known[x.id] } : x)) };
};
/** The last timings, newest last: how long the Capsule took to show, and to answer a keystroke. */
const timings = [];
/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
let hotkey = { ok: false, message: "starting", child: /** @type {import("node:child_process").ChildProcess|null} */ (null) };
let stream = null;
let pinned = false;      // a reply is streaming or a hold is open: clicking away does not close it
let height = 120;

// ------------------------------------------------------------------ the window

function place() {
  const at = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(at);
  const w = WIDTH + MARGIN.x * 2;
  return { x: Math.round(workArea.x + (workArea.width - w) / 2), y: Math.round(workArea.y + workArea.height * 0.18), width: w, height: height + MARGIN.top + MARGIN.bottom };
}

function create() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    ...place(), show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, backgroundColor: "#00000000",
    type: "panel",
    // A panel never activates, so without this the first click only focuses the window and the
    // page never sees it.
    acceptFirstMouse: true,
    webPreferences: { preload: path.join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadFile(path.join(HERE, "capsule.html"));
  win.webContents.on("will-navigate", e => e.preventDefault());
  if (DEV) win.webContents.on("console-message", e => say({ page: /** @type {any} */ (e).message, level: /** @type {any} */ (e).level }));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Driven in development, focus moves to whatever runs the commands; closing on that would end
  // every scripted look at the Capsule.
  win.on("blur", () => { if (!pinned && !DRIVEN) hide(); });
  win.on("closed", () => { win = null; });
  return win;
}

/** Open ready to type. Called only for the user's own gesture. */
async function show(via, at = Date.now()) {
  const w = create();
  const refresh = bridge.refresh();
  launcher.warm().catch(() => {});
  w.setBounds(place());
  // Driven by a test, the Capsule must not take the keyboard: whoever is at the Mac keeps typing
  // into their own app, and those keys once landed in a test window instead. Test keys go to this
  // window's webContents directly and need no focus.
  if (DRIVEN) { w.showInactive(); w.setAlwaysOnTop(true, "screen-saver"); }
  else {
    w.show();
    w.setAlwaysOnTop(true, "screen-saver");
    // With another app active, focusing a panel alone does not make it key, and the keys the user
    // types next go nowhere (measured: typed over TextEdit, they reached neither). The user asked
    // for the Capsule, so this app takes the keyboard; hide() gives it back.
    app.focus({ steal: true });
    w.focus();
  }
  // On first launch the page may still be loading, and a message sent now would be lost with
  // the caret nowhere; wait for it.
  // `at` is when the user asked (for double-Control, the second release), so the page can say how
  // long it took to be on screen.
  const opened = () => tell("capsule:open", { at, via });
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", opened); else opened();
  await refresh;
  push();
  say({ shown: w.getBounds(), via, focused: w.isFocused() });
}

function hide() {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
    // Hand the keyboard back to the app that had it before the Capsule opened.
    if (app.hide) app.hide();
  }
  pinned = false;
  bridge.releaseLease().catch(() => {});
  // Nothing is followed for a DM nobody is looking at (principle 8).
  bridge.closeDm();
  paintTray();
}

function toggle(via, at) {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return hide();
  show(via, at);
}

/** Send to the page, if there still is one. A window closing mid-send must not throw. */
function tell(channel, data) {
  try { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data); } catch {}
}

function push() {
  if (!win || win.isDestroyed()) return;
  const s = bridge.snapshot();
  tell("capsule:state", { ...s, hotkey: { ok: hotkey.ok, message: hotkey.message } });
  pinned = Boolean(s.reply && !s.reply.finished) || pinned;
}

bridge.on("change", () => { push(); paintTray(); });
bridge.on("stale", () => { if (win && win.isVisible()) bridge.refresh().catch(() => {}); });

// ------------------------------------------------------------------ the menu bar

/** The 18px mark from docs/design/TOKENS.md, drawn once into images the tray can use. */
async function trayImages() {
  const svg = (dot, r) => `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 18 18" fill="none"><path d="M2.8 4.6L9 14.8L13.23 7.85" stroke="${dot === "currentColor" ? "#000" : "#F1EEE6"}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15.2" cy="4.6" r="${r}" fill="${dot === "currentColor" ? "#000" : dot}"/></svg>`;
  const draw = async markup => {
    const off = new BrowserWindow({ show: false, width: 36, height: 36, transparent: true, frame: false, webPreferences: { offscreen: true } });
    await off.loadURL("data:text/html," + encodeURIComponent(`<body style="margin:0;background:transparent">${markup}</body>`));
    const img = await off.webContents.capturePage({ x: 0, y: 0, width: 36, height: 36 });
    off.destroy();
    return nativeImage.createFromBuffer(img.toPNG(), { scaleFactor: 2 });
  };
  const idle = await draw(svg("currentColor", 1.9));
  idle.setTemplateImage(true);
  const needs = await draw(svg("#FF7A59", 2.3));
  return { idle, needs };
}
let images = null;

function paintTray() {
  if (!tray || !images) return;
  const n = bridge.waiting.length;
  tray.setImage(n ? images.needs : images.idle);
  tray.setToolTip(!bridge.up ? "Vyre: vyred is not running" : n ? `Vyre: ${n} waiting on you` : "Vyre: press Control twice");
}

function trayMenu() {
  const n = bridge.waiting.length;
  return Menu.buildFromTemplate([
    { label: "Open the Capsule", click: () => show("menu") },
    { label: n ? `Waiting on you · ${n}` : "Nothing waiting", enabled: n > 0, click: () => show("menu") },
    { type: "separator" },
    { label: hotkey.ok ? "Control twice opens it" : `Double-Control is off: ${hotkey.message}`, enabled: false },
    { label: bridge.up ? "vyred is running" : "vyred is not running · vyre up", enabled: false },
    { type: "separator" },
    { label: "Quit the Capsule", role: "quit" },
  ]);
}

// ------------------------------------------------------------------ double-Control

let hotkeyRetry = null;
function startHotkey() {
  clearTimeout(hotkeyRetry);
  const bin = path.join(BIN, "hotkey");
  if (!fs.existsSync(bin)) { hotkey = { ok: false, message: "the helper is not built (vyre capsule build)", child: null }; push(); return; }
  // stdin stays open as a lifeline: when this process dies the helper sees EOF and exits.
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
  hotkey = { ok: false, message: "starting", child };
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { hotkey = { ...hotkey, ok: true, message: "ready" }; push(); }
      if (m.gesture === "double-control") toggle("hotkey", Number(m.at) || Date.now());
      if (m.error) { hotkey = { ...hotkey, ok: false, message: m.message }; push(); }
    }
  });
  child.on("exit", code => {
    if (hotkey.child !== child) return;
    // A refused permission will be refused again right away; check back slowly, not in a loop.
    const wait = code === 2 ? 30_000 : 2000;
    hotkey = { ...hotkey, ok: false, child: null, message: hotkey.message === "ready" ? "the listener stopped; restarting" : hotkey.message };
    push();
    hotkeyRetry = setTimeout(startHotkey, wait);
  });
}

// ------------------------------------------------------------------ vyred

async function follow() {
  const h = await vyred.get("/v1/health");
  if (h.error) { await bridge.refresh(); setTimeout(follow, 3000); return; }
  // From now. The waiting list is read whole by refresh(); the stream only adds to it.
  stream = vyred.stream({
    since: h.data.last_event || 0,
    onEvent: e => {
      if (e.type === "capsule.requested") { const a = (e.payload || {}).action; a === "hide" ? hide() : a === "toggle" ? toggle("vyred") : show("vyred"); return; }
      bridge.onEvent(e);
    },
    onState: s => { say({ stream: s }); bridge.refresh().catch(() => {}); },
  });
}

// ------------------------------------------------------------------ what the page may ask

ipcMain.handle("capsule:snapshot", () => ({ ...bridge.snapshot(), hotkey: { ok: hotkey.ok, message: hotkey.message } }));
ipcMain.handle("capsule:mention", (_e, text, caret) => bridge.mention(String(text || ""), Number(caret) || 0));
ipcMain.handle("capsule:destinations", (_e, target, text) => bridge.destinations(target || null, String(text || "")));
ipcMain.handle("capsule:recall", (_e, text) => bridge.recall(String(text || "")));
ipcMain.handle("capsule:source", (_e, ref) => bridge.source(ref));
ipcMain.handle("capsule:send", async (_e, dest, text, opts) => {
  const r = await bridge.send(dest, String(text || ""), { take: Boolean(opts && opts.take) });
  if (!r.error) pinned = true;
  return r;
});
ipcMain.handle("capsule:held", (_e, id) => bridge.held(String(id || "")));
ipcMain.handle("capsule:answer", (_e, item, decision, edited) => bridge.answer(item, decision, edited));
ipcMain.on("capsule:size", (_e, h) => {
  const next = Math.max(52, Math.min(640, Math.round(Number(h) || 0)));
  if (!win || win.isDestroyed() || Math.abs(next - height) < 1) return;
  height = next;
  const b = win.getBounds();
  // The top stays where it is and the Capsule grows downward, so the box under the caret never moves.
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: height + MARGIN.top + MARGIN.bottom });
});
ipcMain.on("capsule:dismiss", () => hide());
ipcMain.handle("capsule:quick", async (_e, text) => withIcons(await launcher.quick(String(text || ""), bridge.up ? bridge.catalog : null)));
ipcMain.handle("capsule:full", async (_e, text) => withIcons(await launcher.full(String(text || ""), bridge.up ? bridge.catalog : null)));
ipcMain.handle("capsule:icons", (_e, results) => (Array.isArray(results) ? iconsNow().get(results.slice(0, 40)) : {}));
ipcMain.handle("capsule:cancel", () => bridge.cancel());
ipcMain.handle("capsule:dm-open", (_e, agent) => bridge.openDm(String(agent || "")));
ipcMain.handle("capsule:dm-close", () => bridge.closeDm());
ipcMain.handle("capsule:copy", (_e, text) => { clipboard.writeText(String(text || "")); return { ok: true }; });
ipcMain.handle("capsule:pick", async (_e, r, query) => {
  const out = await launcher.pick(r, String(query || ""));
  if (out.close) hide();
  return out;
});
ipcMain.on("capsule:timing", (_e, t) => {
  const row = { kind: String((t && t.kind) || ""), ms: Math.round(Number(t && t.ms) * 10) / 10, n: Number(t && t.n) || 0 };
  timings.push(row);
  if (timings.length > 200) timings.shift();
  say({ timing: row });
});
ipcMain.on("capsule:pin", (_e, on) => { pinned = Boolean(on); });

// ------------------------------------------------------------------ driving it in development

// `vyre capsule --dev` with VYRE_CAPSULE_DRIVE=1 reads one JSON command per line on stdin:
// {"text":"@har"}, {"key":"Enter","modifiers":["meta"]}, {"show":true}, {"shot":"/tmp/x.png"}.
// Keys go into this window's own webContents and nowhere else. Typing through System Events
// sends them to whatever app is in front, which during a test is someone's terminal.
function drive() {
  let buf = "", queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  // One command at a time, in order: a key must not overtake the text typed before it.
  process.stdin.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      queue = queue.then(() => run(line)).catch(() => {});
    }
  });
  async function run(line) {
      let c; try { c = JSON.parse(line); } catch { return; }
      const wc = win && !win.isDestroyed() ? win.webContents : null;
      if (c.show) await show("drive");
      if (c.hide) hide();
      if (wc && typeof c.text === "string") for (const ch of c.text) {
        for (const type of ["keyDown", "char", "keyUp"]) wc.sendInputEvent({ type: /** @type {any} */ (type), keyCode: ch });
        await new Promise(r => setTimeout(r, 20));
      }
      if (wc && c.key) for (const type of ["keyDown", "keyUp"]) wc.sendInputEvent({ type: /** @type {any} */ (type), keyCode: c.key, modifiers: c.modifiers || [] });
      if (wc && c.shot) {
        await new Promise(r => setTimeout(r, c.wait ?? 400));
        const img = await wc.capturePage();
        fs.writeFileSync(c.shot, img.toPNG());
      }
      // Read-only: what has the caret and what is in the box.
      const probe = wc && c.probe ? await wc.executeJavaScript("({ active: document.activeElement && document.activeElement.id, box: document.getElementById('box').value, panel: document.getElementById('panel').textContent.slice(0, 200), keys: document.getElementById('keys').textContent, area: (document.querySelector('textarea') || {}).value })") : undefined;
      if (c.timings) say({ timings });
      const js = wc && c.js ? await wc.executeJavaScript(String(c.js)).catch(e => "error: " + e.message) : undefined;
      say({ drove: c, probe, js, focused: Boolean(win && win.isFocused()), visible: Boolean(win && win.isVisible()) });
      if (c.wait && !c.shot) await new Promise(r => setTimeout(r, c.wait));
  }
}

// ------------------------------------------------------------------ lifecycle

app.on("second-instance", (_e, argv) => {
  if (argv.includes("--hidden")) return;
  if (argv.includes("--toggle")) toggle("cli"); else show("cli");
});
app.on("window-all-closed", () => {});   // the Capsule lives in the menu bar; closing the window is not quitting
app.on("will-quit", () => { try { clips.stop(); } catch {} try { launcher.close(); } catch {} try { hotkey.child && hotkey.child.kill(); } catch {} try { stream && stream.stop(); } catch {} });

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  images = await trayImages().catch(() => null);
  tray = new Tray(images ? images.idle : nativeImage.createEmpty());
  if (!images) tray.setTitle("vyre");
  tray.on("click", () => toggle("menu"));
  tray.on("right-click", () => tray && tray.popUpContextMenu(trayMenu()));
  paintTray();
  create();
  startHotkey();
  clips.start();
  await bridge.refresh();
  follow();
  if (DEV && process.env.VYRE_CAPSULE_DRIVE) drive();
  say({ ready: true, socket: vyred.socket, dev: DEV, bin: BIN });
  if (!process.argv.includes("--hidden")) show("launch");
});
