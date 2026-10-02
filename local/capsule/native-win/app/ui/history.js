// "Import history" (#26): what agent sessions this PC holds, in words, with a tick for each project.
// This app has no local Vyre core, so it can look and let the person choose, but not send: the
// screen says so plainly. Everything from the scan is shown as text, never as markup. The scan reads
// file names, sizes, dates and the folder each session ran in, never what was said.
const invoke = window.__TAURI_INTERNALS__.invoke;
const body = document.getElementById("body");
const err = document.getElementById("err");

const AGENTS = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", "gemini-cli": "Gemini" };
const LOOKED_IN = "Claude Code, Codex, Grok and Gemini";
const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
const size = (b) => (b >= 1048576 ? `${Math.round(b / 1048576)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const range = (a, b) => (!a || !b ? "" : day(a) === day(b) ? day(a) : `${day(a)} to ${day(b)}`);
const sub = (o) => [n(o.sessions, "session", "sessions"), size(o.bytes), range(o.from, o.to)].filter(Boolean).join(" · ");

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function show(...nodes) { body.replaceChildren(...nodes); }

function unpaired() {
  show(el("p", "Pair this PC first, then import from here."));
}

function nothing(looked) {
  const ul = el("ul", undefined, "where");
  for (const p of looked) ul.append(el("li", p));
  const again = el("button", "Look again");
  again.addEventListener("click", scan);
  show(el("p", `No sessions found. Looked in your ${LOOKED_IN} folders:`), ul, again);
}

function choose(scanResult) {
  const sources = scanResult.sources;
  const folders = sources.flatMap((s) => s.folders.map((f) => ({ s, f, id: s.id + "\u0000" + (f.cwd || "") })));
  const ticked = new Set(folders.filter((x) => x.f.suggested).map((x) => x.id));
  const total = sources.reduce((a, s) => a + s.sessions, 0);
  const boxes = new Map();
  const count = el("span", "", "grow");
  const refresh = () => {
    const picked = folders.filter((x) => ticked.has(x.id));
    count.textContent = `${picked.reduce((a, x) => a + x.f.sessions, 0)} of ${total} chosen · ${size(picked.reduce((a, x) => a + x.f.bytes, 0))}`;
  };
  const nodes = [el("p", `Found ${n(total, "session", "sessions")} on this PC across ${n(folders.length, "project", "projects")}.`)];
  for (const s of sources) {
    const h = el("h2", AGENTS[s.agent] || s.agent, "src");
    h.append(el("span", sub(s)));
    nodes.push(h);
    for (const x of folders.filter((y) => y.s === s)) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = ticked.has(x.id);
      box.addEventListener("change", () => { box.checked ? ticked.add(x.id) : ticked.delete(x.id); refresh(); });
      boxes.set(x.id, box);
      const text = el("span");
      text.append(el("span", x.f.name || "Other sessions", "name"));
      text.append(el("span", (x.f.why ? `Not suggested: ${x.f.why}. ` : "") + sub(x.f), "sub"));
      const label = document.createElement("label");
      label.append(box, text);
      nodes.push(label);
    }
  }
  const all = el("button", "All", "link"), none = el("button", "None", "link");
  const setAll = (on) => { for (const x of folders) { on ? ticked.add(x.id) : ticked.delete(x.id); boxes.get(x.id).checked = on; } refresh(); };
  all.addEventListener("click", () => setAll(true));
  none.addEventListener("click", () => setAll(false));
  const row = el("div", undefined, "row");
  row.append(count, all, none);
  const send = el("button", "Send them", "go");
  send.disabled = true;
  nodes.push(row, send,
    el("p", "Sending needs Vyre's local helper on this PC, which this app does not include yet, so nothing can be sent from here. Only file names, sizes, dates and project folders were read, and nothing has left this PC."));
  refresh();
  show(...nodes);
}

async function scan() {
  err.textContent = "";
  show(el("p", "Looking on this PC…"));
  try {
    const st = await invoke("get_state");
    if (!st.paired) return unpaired();
    const r = await invoke("scan_history");
    const total = r.sources.reduce((a, s) => a + s.sessions, 0);
    if (total === 0) nothing(r.looked_in || []);
    else choose(r);
  } catch (e) {
    show(el("p", "That did not finish."), Object.assign(el("button", "Start over"), { onclick: scan }));
    err.textContent = String(e);
  }
}

scan();
