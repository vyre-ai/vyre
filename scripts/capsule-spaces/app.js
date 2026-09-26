// @ts-check
// One side of the Spaces check (run.js drives it). SPACES_MODE=fs is the stand-in for a terminal in
// full screen: a plain window that goes full screen and reports keys. SPACES_MODE=panel is a panel
// built like the Capsule's (local/capsule/app/main.js create()), shown with lib/present.js on "show".
import { app, BrowserWindow } from "electron";
import { present, LEVEL } from "../../local/capsule/lib/present.js";

const mode = process.env.SPACES_MODE, variant = process.env.SPACES_VARIANT || "default";
const say = o => process.stdout.write(JSON.stringify({ mode, variant, pid: process.pid, ...o }) + "\n");
const page = `data:text/html,<body style="background:%23181a20;color:%23f1eee6;font:20px -apple-system">Vyre Spaces check: ${mode} ${variant}. Safe to ignore; it closes itself.<input id=b autofocus><script>addEventListener('keydown',e=>document.title='key:'+e.key)</script>`;

app.whenReady().then(() => {
  // Never outlives the check, whatever happens to the driver.
  setTimeout(() => app.quit(), 60_000);
  if (mode === "fs") {
    const w = new BrowserWindow({ width: 640, height: 400, show: true });
    w.loadURL(page);
    w.webContents.on("page-title-updated", (_e, t) => say({ title: t }));
    w.on("enter-full-screen", () => setTimeout(() => say({ fs: true }), 1200));
    w.once("ready-to-show", () => w.setFullScreen(true));
    return;
  }
  if (app.dock) app.dock.hide();
  const w = new BrowserWindow({ width: 680, height: 160, show: false, frame: false, type: "panel", acceptFirstMouse: true, fullscreenable: false, skipTaskbar: true });
  w.setAlwaysOnTop(true, LEVEL);
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  w.loadURL(page);
  w.webContents.on("page-title-updated", (_e, t) => say({ title: t }));
  process.stdin.on("data", d => {
    const cmd = String(d).trim();
    if (cmd === "show") {
      if (variant === "stay-then-steal") { present(w, app, { stay: true }); app.focus({ steal: true }); }
      else present(w, app, { stay: variant === "stay" });
      setTimeout(() => say({ shown: true, focused: w.isFocused(), visible: w.isVisible() }), 700);
    }
    if (cmd === "quit") { w.hide(); app.quit(); }
  });
  say({ ready: true });
});
