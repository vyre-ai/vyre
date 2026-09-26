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
  // Wake-latency instrumentation (SPEC.md 2.8): fired once the renderer has actually repainted
  // after onOpen(), so main can time gesture-to-paint rather than gesture-to-IPC-arrival.
  paintPing: () => ipcRenderer.send("capsule:paintping"),
});
