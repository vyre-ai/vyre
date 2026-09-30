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
void draw();
setInterval(() => { void draw(); }, 1500);
