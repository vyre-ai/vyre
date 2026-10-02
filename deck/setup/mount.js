// @ts-check
// mountSetup: steps 8 to 10 of the one setup flow, at the person's own address, as one self-contained module. One mount point:
//
//   const setup = mountSetup(hostElement, { call, onOpenThread, onDone });   // call(tool, input) -> Promise<any>, the Deck's tool caller
//   setup.stop();
//
// It reads onboard.status (the server's record, not the page's memory), draws the same timeline as vyre.run/setup, and calls
// onboard.you (step 8), onboard.skip and onboard.history (9 and 10) and onboard.finish. Everything a person reads goes in as text.
// The person's name is asked once, here, and never taken from the address (team/PLAN-setup-redo.md, #50).

import { h } from "../js/dom.js";
import { setupSteps } from "./steps.js";

const safeHttps = u => { try { const x = new URL(String(u)); return x.protocol === "https:" && !x.username && !x.password && x.href.length < 600 ? x.href : null; } catch { return null; } };
const msg = e => String((e && e.message) || e || "That did not work").slice(0, 200);

/**
 * @param {HTMLElement} host
 * @param {{ call: (tool: string, input?: object) => Promise<any>, onOpenThread?: (thread: string) => void, onDone?: () => void, pollMs?: number,
 *   sleep?: (ms: number) => Promise<void>, retryTool?: string }} o
 */
export function mountSetup(host, o) {
  const pollMs = o.pollMs ?? 3000;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  /** @type {any} */ let status = null;
  /** @type {{ passed: string[], error: string|null, busy: boolean, loadError: string|null, ending: null | { name: string|null, display: string|null, thread: string|null, why?: string|null }, checking: boolean, add: boolean }} */
  const ui = { passed: [], error: null, busy: false, loadError: null, ending: null, checking: false, add: false };
  let alive = true, finishing = false;
  /** The typed values survive a redraw: the form is rebuilt only when the step changes. */
  const typed = { name: null, assistant: null };

  const root = h("div", { class: "setup8" });
  host.replaceChildren(root);

  async function load() {
    try { status = await o.call("onboard.status", {}); ui.loadError = null; }
    catch (e) { ui.loadError = msg(e); }
    draw();
  }

  async function act(fn) {
    if (ui.busy) return;
    ui.busy = true; ui.error = null; draw();
    try { await fn(); } catch (e) { ui.error = msg(e); }
    ui.busy = false;
    await load();
  }

  const timeline = view => {
    const rowsFor = () => {
      const rows = [];
      let last = "";
      for (const s of view.list) {
        if (s.where !== last) { rows.push(h("li", { class: "tl-group", "aria-hidden": "true" }, s.where)); last = s.where; }
        rows.push(h("li", { class: `tl-step ${s.status}`, "aria-current": s.status === "current" ? "step" : false },
          h("span", { class: "tl-dot", "aria-hidden": "true" }, s.status === "done" ? "\u2713" : s.status === "skipped" ? "\u2013" : ""),
          h("span", { class: "tl-name" }, s.title), s.optional ? h("span", { class: "tl-opt" }, "optional") : null,
          h("span", { class: "sr" }, `, ${s.status === "current" ? "now" : s.status}`)));
      }
      return rows;
    };
    const cur = view.list[view.number - 1];
    return [
      h("ol", { class: "tl-rail", "aria-label": "Setup steps" }, rowsFor()),
      h("div", { class: "tl-bar" },
        h("div", { class: "tl-segs", "aria-hidden": "true" }, view.list.map(s => h("span", { class: `seg ${s.status}` }))),
        h("details", { class: "tl-more" }, h("summary", null, h("span", { class: "tl-now" }, `Step ${view.number} of 10 `, h("b", null, cur.title)), h("span", { class: "tl-all" }, "All steps")),
          h("ol", { class: "tl-list", "aria-label": "Setup steps" }, rowsFor()))),
    ];
  };

  const label = (view, id) => { const s = view.list.find(x => x.id === id); return `Step ${s.n} of 10${s.optional ? ", optional" : ""}`; };
  const btn = (text, cls, on, extra = {}) => h("button", { type: "button", class: `btn ${cls}`, onclick: on, disabled: ui.busy, ...extra }, text);
  const err = () => (ui.error ? h("p", { class: "warn", role: "alert" }, ui.error) : null);

  function stepAssistant(view) {
    const you = h("input", { type: "text", class: "name", name: "you", autocomplete: "name", maxlength: "60", "aria-label": "Your name", value: typed.name ?? (status.person || "") });
    const asst = h("input", { type: "text", class: "name", name: "assistant", autocomplete: "off", maxlength: "40", "aria-label": "Your assistant's name", placeholder: status.assistant || "Juno", value: typed.assistant ?? "" });
    you.addEventListener("input", () => { typed.name = you.value; });
    asst.addEventListener("input", () => { typed.assistant = asst.value; });
    const go = () => {
      const name = String(you.value || "").trim();
      if (!name) { ui.error = "Tell Vyre your name first."; return draw(); }
      return act(() => o.call("onboard.you", { name, assistant: String(asst.value || "").trim() || undefined }));
    };
    return [
      h("p", { class: "lbl" }, label(view, "assistant")), h("h1", { tabindex: "-1" }, "You and your assistant"),
      h("p", { class: "lead" }, "Steps 1 to 7 are done. Tell Vyre your name, and name the assistant that will help you."),
      h("div", { class: "fields" }, h("label", { class: "f" }, h("span", null, "Your name"), h("div", { class: "field" }, you)), h("label", { class: "f" }, h("span", null, "Your assistant's name"), h("div", { class: "field" }, asst))),
      err(), h("div", { class: "actions" }, btn("Continue", "primary", go)),
    ];
  }

  function stepComputers(view) {
    const d = (status.detail && status.detail.devices) || {};
    const mac = d.mac && d.mac.connected ? d.mac : null;
    const dl = safeHttps(d.macDownload);
    return [
      h("p", { class: "lbl" }, label(view, "computers")), h("h1", { tabindex: "-1" }, "Your computers"),
      h("p", { class: "lead" }, "Pair a Mac or a Windows PC, and get Vyre Lumen on it. Your agents can then work with that computer."),
      mac ? h("div", { class: "account" }, h("p", { class: "row-title" }, mac.name || "Your Mac"), h("p", { class: "hint" }, "Paired")) : null,
      !mac && ui.add ? h("div", { class: "account" }, h("p", { class: "hint" }, "Install Vyre Lumen on the computer and open it. This page notices when it pairs."), dl ? h("p", { class: "hint" }, h("a", { href: dl, rel: "noopener noreferrer", target: "_blank" }, "Download Vyre Lumen for Mac")) : null) : null,
      err(),
      h("div", { class: "actions" },
        mac ? btn("Continue", "primary", () => { ui.passed.push("computers"); draw(); })
          : [btn("Add a computer", "primary", () => { ui.add = true; draw(); }), btn("Skip for now", "quiet", () => act(() => o.call("onboard.skip", { step: "devices" })))]),
    ];
  }

  function stepHistory(view) {
    const hs = (status.detail && status.detail.history) || {};
    const machines = (Array.isArray(hs.machines) ? hs.machines : []).filter(m => m && Number(m.sessions) >= 0);
    const total = Number(hs.sessions) || 0;
    const names = machines.map(m => (m.source === "box" ? "your server" : String(m.machine || "your Mac").slice(0, 60)));
    const body = total > 0
      ? [h("p", { class: "lead" }, `Found ${total} session${total === 1 ? "" : "s"}${machines.length ? ` on ${names.filter((_, i) => machines[i].sessions > 0).join(" and ") || "your computers"}` : ""}.`),
        h("p", { class: "hint" }, "Open Lumen on your Mac to choose what to import. Your history stays on that computer until you choose what to send.")]
      : [h("p", { class: "lead" }, `Found nothing${names.length ? ` on ${names.join(" and ")}` : ""}. ${names.length ? "It has" : "There is"} no Claude Code, Codex or Grok history in the usual folders.`)];
    return [
      h("p", { class: "lbl" }, label(view, "history")), h("h1", { tabindex: "-1" }, "Your history"), ...body, err(),
      h("div", { class: "actions" }, btn("Continue", "primary", () => act(async () => { await o.call("onboard.history", { action: "start" }).catch(() => null); ui.passed.push("history"); }))),
    ];
  }

  function ending() {
    const a = ui.ending;
    const name = (a && (a.display || a.name)) || "Your assistant";
    if (a && a.thread) return [h("p", { class: "lbl" }, "Done"), h("h1", { tabindex: "-1" }, `${name} is ready`), h("p", { class: "lead" }, "Setup is finished. Your assistant has said hello in its first thread."),
      h("div", { class: "actions" }, btn(`Open ${name}'s thread`, "primary", () => o.onOpenThread && o.onOpenThread(String(a.thread))))];
    if (a && a.why) return [h("p", { class: "lbl" }, "Done"), h("h1", { tabindex: "-1" }, "Setup is finished"), h("p", { class: "lead" }, `${name} could not start yet.`), h("p", { class: "warn", role: "alert" }, String(a.why).slice(0, 200)),
      h("div", { class: "actions" }, btn("Try again", "primary", retry))];
    return [h("p", { class: "lbl" }, "Done"), h("h1", { tabindex: "-1" }, "Setup is finished"), h("p", { class: "lead" }, `${name} is ready when you are.`)];
  }
  async function retry() {
    if (ui.checking) return;
    ui.checking = true; draw();
    try { const r = await o.call(o.retryTool || "onboard.assistant", { retry: true }).catch(() => o.call("onboard.finish", {})); ui.ending = (r && r.assistant) || r || null; }
    catch (e) { ui.ending = { name: null, display: null, thread: null, why: msg(e) }; }
    ui.checking = false; draw();
  }

  async function finish() {
    if (finishing) return;
    finishing = true;
    try { const r = await o.call("onboard.finish", {}); ui.ending = (r && r.assistant) || { name: null, display: null, thread: null }; o.onDone && o.onDone(); }
    catch (e) { ui.ending = { name: null, display: null, thread: null, why: msg(e) }; }
    draw();
  }

  let lastKey = "";
  function draw() {
    if (!alive) return;
    if (!status) { root.replaceChildren(h("p", { class: ui.loadError ? "warn" : "status", role: "status" }, ui.loadError ? `Your server did not answer: ${ui.loadError}` : "Reading where setup stands"), ui.loadError ? btn("Try again", "primary", load) : null); return; }
    const view = setupSteps(status, { passed: ui.passed });
    if (view.finished && !status.finished && !ui.ending) finish();
    const key = JSON.stringify([view.list.map(s => s.status), view.current, ui.error, ui.busy, ui.add, ui.checking, ui.ending, status.detail && status.detail.devices && status.detail.devices.mac, status.detail && status.detail.history && status.detail.history.sessions]);
    if (key === lastKey) return;
    lastKey = key;
    const panel = view.finished ? ending()
      : view.current === "assistant" ? stepAssistant(view) : view.current === "computers" ? stepComputers(view) : stepHistory(view);
    root.replaceChildren(h("div", { class: "setup8-tl" }, timeline(view)), h("div", { class: "setup8-step" }, panel));
    const hd = root.querySelector && root.querySelector("h1"); if (hd && hd.focus) hd.focus();
  }

  (async () => {
    await load();
    // The server's record moves on its own when a computer pairs or an import finishes: ask again while this step is one of those.
    while (alive) {
      await sleep(pollMs);
      if (!alive) return;
      const v = status && setupSteps(status, { passed: ui.passed });
      if (v && (v.current === "computers" || v.current === "history") && !ui.busy) await load();
    }
  })();

  return { stop() { alive = false; }, get status() { return status; } };
}
