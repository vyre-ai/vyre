// "Import history" (#26): what agent sessions this PC holds, with a tick for each project, and a
// working Send. The reading and sending are done by Vyre's local helper on this PC (core_ensure,
// core_call); the page names only a fixed set of calls. If the helper cannot start, the screen
// still lists what is here from the app's own read-only scan and says why nothing can be sent.
// Everything from the helper is shown as text, never as markup.
import { AGENTS, LOOKED_IN, n, size, sub, choosable, includeOf, paceText, KEEPS, planLine, canSend, progressText, coreText, plainError } from "./history-model.js";

const invoke = window.__TAURI_INTERNALS__.invoke;
const body = document.getElementById("body");
const err = document.getElementById("err");

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function show(...nodes) { body.replaceChildren(...nodes); }
const button = (text, onclick, cls) => Object.assign(el("button", text, cls), { onclick });

let timer = null;
const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

async function ready() {
  // The helper may need a download the first time: show how far it is.
  const poll = setInterval(async () => { try { show(el("p", coreText(await invoke("core_status")))); } catch { /* the call below reports */ } }, 1000);
  try { await invoke("core_ensure"); } finally { clearInterval(poll); }
}

function unpaired() { show(el("p", "Pair this PC first, then import from here.")); }

function nothing(looked) {
  const ul = el("ul", undefined, "where");
  for (const p of looked) ul.append(el("li", p));
  show(el("p", `No sessions found. Looked in your ${LOOKED_IN} folders:`), ul, button("Look again", scan));
}

function radio(name, value, label, onpick) {
  const input = document.createElement("input");
  input.type = "radio"; input.name = name; input.value = value;
  input.addEventListener("change", () => onpick(value));
  const l = document.createElement("label");
  l.append(input, el("span", label));
  return { l, input };
}

function choose(result, sendable, whyNot) {
  const sources = result.sources;
  const folders = sources.flatMap((s) => s.folders.map((f) => ({ s, f, id: s.id + "\u0000" + (f.cwd || "") })));
  const ticked = new Set(folders.filter((x) => x.f.suggested && choosable(x.f)).map((x) => x.id));
  const total = sources.reduce((a, s) => a + s.sessions, 0);
  const boxes = new Map();
  let plan = null, mode = null, pace = null, planning = 0;

  const count = el("span", "", "grow");
  const line = el("p", "");
  const send = button("Send", doSend, "go");
  const paceBox = el("div"), modeBox = el("div");
  const refreshSend = () => { send.disabled = !(sendable && canSend(plan, mode, pace)); line.textContent = sendable ? planLine(plan, mode) : whyNot; };

  const drawChoices = () => {
    const t = plan ? paceText(plan.pace) : null;
    const m1 = radio("mode", "once", "Import now", (v) => { mode = v; refreshSend(); });
    const m2 = radio("mode", "sync", "Import now and keep them in sync. New sessions go too.", (v) => { mode = v; refreshSend(); });
    const p1 = radio("pace", "fast", t ? t.fast : "Fast", (v) => { pace = v; refreshSend(); });
    const p2 = radio("pace", "gentle", t ? t.gentle : "Gentle", (v) => { pace = v; refreshSend(); });
    m1.input.checked = mode === "once"; m2.input.checked = mode === "sync"; p1.input.checked = pace === "fast"; p2.input.checked = pace === "gentle";
    modeBox.replaceChildren(el("h2", "How"), m1.l, m2.l);
    paceBox.replaceChildren(el("h2", "How fast Vyre reads them"), p1.l, p2.l, el("p", "Search works right away at either speed.", "sub"));
  };

  const replan = async () => {
    const mine = ++planning;
    const picked = folders.filter((x) => ticked.has(x.id));
    count.textContent = `${picked.reduce((a, x) => a + x.f.sessions, 0)} of ${total} chosen · ${size(picked.reduce((a, x) => a + x.f.bytes, 0))}`;
    if (!sendable) return refreshSend();
    const include = includeOf(folders, ticked);
    if (!include.length) { plan = null; drawChoices(); return refreshSend(); }
    try {
      const p = await invoke("core_call", { tool: "import.plan", input: { include } });
      if (mine !== planning) return;
      plan = p; drawChoices(); refreshSend();
    } catch (e) { if (mine === planning) { plan = null; err.textContent = plainError(e); refreshSend(); } }
  };

  const nodes = [el("p", `Found ${n(total, "session", "sessions")} on this PC across ${n(folders.length, "project", "projects")}.`)];
  if (KEEPS(result.claude_keeps_days)) nodes.push(el("p", KEEPS(result.claude_keeps_days)));
  for (const s of sources) {
    const h = el("h2", AGENTS[s.agent] || s.agent, "src");
    h.append(el("span", sub(s)));
    nodes.push(h);
    for (const x of folders.filter((y) => y.s === s)) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.disabled = !choosable(x.f);
      box.checked = ticked.has(x.id);
      box.addEventListener("change", () => { box.checked ? ticked.add(x.id) : ticked.delete(x.id); replan(); });
      boxes.set(x.id, box);
      const text = el("span");
      text.append(el("span", x.f.name || x.f.cwd || "Other sessions", "name"));
      text.append(el("span", (x.f.why ? `Not suggested: ${x.f.why}. ` : "") + sub(x.f), "sub"));
      const label = document.createElement("label");
      label.append(box, text);
      nodes.push(label);
    }
  }
  const all = button("All", () => setAll(true), "link"), none = button("None", () => setAll(false), "link");
  const setAll = (on) => { for (const x of folders) { if (!choosable(x.f)) continue; on ? ticked.add(x.id) : ticked.delete(x.id); boxes.get(x.id).checked = on; } replan(); };
  const row = el("div", undefined, "row");
  row.append(count, all, none);
  drawChoices();
  nodes.push(row, modeBox, paceBox, line, send);
  nodes.push(el("p", "Only file names, sizes, dates and project folders were read to make this list. Nothing has left this PC yet.", "sub"));
  refreshSend();
  show(...nodes);
  replan();

  async function doSend() {
    send.disabled = true; err.textContent = "";
    try {
      await invoke("core_call", { tool: "import.start", input: { plan: plan.plan, mode, pace } });
      follow();
    } catch (e) { err.textContent = plainError(e); refreshSend(); }
  }
}

// Progress while an import runs. Asked every 5 seconds only while this window is showing and a send is running: it is the person's own
// action in front of them. It stops the moment the send ends or the window hides, and starts again when the window shows.
function follow() {
  const text = el("p", "Starting…");
  const stop = button("Stop", async () => {
    stop.disabled = true;
    try { await invoke("core_call", { tool: "import.stop", input: {} }); } catch (e) { err.textContent = plainError(e); }
    await tick();
  });
  const done = button("Done", () => { finish(); scan(); });
  done.hidden = true;
  show(el("h2", "Importing"), text, stop, done);
  let running = true;
  const finish = () => { running = false; stopTimer(); document.removeEventListener("visibilitychange", onVisible); };
  async function tick() {
    if (!running || document.visibilityState === "hidden") return;
    try {
      const s = await invoke("core_call", { tool: "import.status", input: {} });
      text.textContent = progressText(s.upload) || "Starting…";
      if (s.upload && s.upload.state !== "sending") { finish(); stop.hidden = true; done.hidden = false; }
    } catch (e) { text.textContent = plainError(e); }
  }
  const arm = () => { stopTimer(); if (running && document.visibilityState !== "hidden") { timer = setInterval(tick, 5000); tick(); } };
  const onVisible = () => (document.visibilityState === "hidden" ? stopTimer() : arm());
  document.addEventListener("visibilitychange", onVisible);
  arm();
}

async function scan() {
  err.textContent = "";
  stopTimer();
  show(el("p", "Looking on this PC…"));
  try {
    const st = await invoke("get_state");
    if (!st.paired) return unpaired();
    let result, sendable = true, whyNot = "";
    try {
      await ready();
      result = await invoke("core_call", { tool: "import.scan", input: {} });
    } catch (e) {
      // Without the helper the app can still read what is here, but cannot send it.
      sendable = false;
      whyNot = `Vyre's local helper is not running, so nothing can be sent yet. ${plainError(e)}`;
      result = await invoke("scan_history");
    }
    const total = result.sources.reduce((a, s) => a + s.sessions, 0);
    if (total === 0) nothing(result.looked_in || []);
    else choose(result, sendable, whyNot);
  } catch (e) {
    show(el("p", "That did not finish."), button("Start over", scan));
    err.textContent = plainError(e);
  }
}

scan();
