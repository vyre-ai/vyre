// The Capsule window's only way out. It runs sandboxed with no Node, and asks the main process
// for everything; the main process is what talks to vyred. CommonJS because a sandboxed preload
// cannot be an ES module.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vyre", {
  snapshot: () => ipcRenderer.invoke("capsule:snapshot"),
  mention: (text, caret) => ipcRenderer.invoke("capsule:mention", text, caret),
  destinations: (target, text) => ipcRenderer.invoke("capsule:destinations", target, text),
  recall: text => ipcRenderer.invoke("capsule:recall", text),
  source: ref => ipcRenderer.invoke("capsule:source", ref),
  send: (dest, text, opts) => ipcRenderer.invoke("capsule:send", dest, text, opts),
  held: id => ipcRenderer.invoke("capsule:held", id),
  answer: (item, decision, edited) => ipcRenderer.invoke("capsule:answer", item, decision, edited),
  // Local results: apps, settings, the calculator, contacts (quick), then files too (full).
  quick: text => ipcRenderer.invoke("capsule:quick", text),
  full: text => ipcRenderer.invoke("capsule:full", text),
  pick: (result, query) => ipcRenderer.invoke("capsule:pick", result, query),
  timing: t => ipcRenderer.send("capsule:timing", t),
  // Pictures for result rows, as file:// URLs, fetched after the rows are drawn.
  icons: results => ipcRenderer.invoke("capsule:icons", results),
  // Stop an answer that is streaming (Esc). The first Esc stops; the next closes.
  cancel: () => ipcRenderer.invoke("capsule:cancel"),
  // Only the user's own click puts text on the clipboard.
  copy: text => ipcRenderer.invoke("capsule:copy", text),
  // A direct message with an agent: its thread as history, live while open.
  dmOpen: agent => ipcRenderer.invoke("capsule:dm-open", agent),
  dmClose: () => ipcRenderer.invoke("capsule:dm-close"),
  // Watches: tell me when a thread is done or asks. Reports come back in the state.
  watch: (thread, label) => ipcRenderer.invoke("capsule:watch", thread, label),
  unwatch: thread => ipcRenderer.invoke("capsule:unwatch", thread),
  reportRead: id => ipcRenderer.invoke("capsule:report-read", id),
  onReport: fn => ipcRenderer.on("capsule:report", (_e, id) => fn(id)),
  // The page says how tall it is; the window follows. Width never changes.
  size: h => ipcRenderer.send("capsule:size", h),
  // Escape: the window goes away, which is the only reliable way to hand the keyboard back.
  dismiss: () => ipcRenderer.send("capsule:dismiss"),
  // While a hold is open for review, clicking into another app does not throw it away.
  pin: on => ipcRenderer.send("capsule:pin", Boolean(on)),
  onState: fn => ipcRenderer.on("capsule:state", (_e, s) => fn(s)),
  // The user asked for the Capsule (double-Control, the menu bar, `vyre capsule`). Only this
  // may put the caret in the box; nothing that merely arrives from an agent does.
  onOpen: fn => ipcRenderer.on("capsule:open", (_e, d) => fn(d)),
});
