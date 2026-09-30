// @ts-check
// popup: the extension's card. Reads the connection record the worker keeps and says, in words, whether Vyre is connected and, if not, the one fix.
import { explain } from "./shared/diag.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

async function draw() {
  /** @type {any} */ let conn = null;
  try { const r = await chrome.storage.session.get("vyre.conn"); conn = r && r["vyre.conn"]; } catch { /* no record */ }
  const e = explain(conn);
  $("dot").className = "dot " + (e.state === "connected" ? "ok" : e.state === "failing" ? "bad" : "wait");
  $("headline").textContent = e.headline;
  $("fix").textContent = e.fix || "";
  $("detail").textContent = e.detail || "";
}
/** Continue after a stop or pause: only here, in the extension's own page, which no website can reach. */
async function drawStopped() {
  try {
    const r = await chrome.runtime.sendMessage({ vyre: "state" });
    $("stopped").hidden = !(r && r.stopped);
    $("stoppedText").textContent = r && r.stopped ? "Vyre is stopped. Nothing is being done in your browser." : "";
  } catch { $("stopped").hidden = true; }
}
$("cont").addEventListener("click", async () => { try { await chrome.runtime.sendMessage({ vyre: "resume" }); } catch { /* the worker restarted */ } void drawStopped(); });
void draw(); void drawStopped();
setInterval(() => { void drawStopped(); }, 1500);
setInterval(() => { void draw(); }, 1500);
