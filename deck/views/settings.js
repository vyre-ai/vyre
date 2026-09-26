// @ts-check
// Settings: one column of quiet, rule-separated sections. No board of its own; built from
// TOKENS.md and the section style of DeckAgent and DeckVault, with the onboarding's look for the
// Setup list. Route /settings, with an optional #section.
//
// Every section loads on its own and shows its own empty state, so one missing module never
// blanks the page. Tools: onboard.status, onboard.claude, onboard.tailscale (box), agents.list and
// agents.update (switchboard), recall.status, recall.index, memory.stats, memory.curate,
// learn.lessons, learn.edit, learn.retire (learning), system.info, and GET /v1/modules.

import { h, put, link, head, empty } from "../js/dom.js";
import { attempt, modules } from "../js/api.js";
import { icon, mark, wordmark } from "../js/icons.js";
import { when, since, plural } from "../js/fmt.js";

const SECTIONS = [
  ["setup", "Setup"],
  ["you", "You and your address"],
  ["assistant", "The assistant"],
  ["claude", "Claude Code"],
  ["network", "Network"],
  ["history", "History and memory"],
  ["lessons", "Lessons"],
  ["notifications", "Notifications"],
  ["modules", "Modules"],
  ["appearance", "Appearance"],
  ["machine", "This machine"],
];

/** The onboarding's steps (deck/onboard/onboard.js), each with the command that does the same. */
const STEPS = [
  { id: "you", title: "You", cmd: "vyre up" },
  { id: "claude", title: "Claude Code", cmd: "vyre up --step claude" },
  { id: "tailscale", title: "Tailscale", cmd: "vyre up --step tailscale" },
  { id: "name", title: "Your address", cmd: "vyre up --step name" },
  { id: "history", title: "Your history", cmd: "vyre index" },
  { id: "devices", title: "Your devices", cmd: "vyre up --step devices" },
];

const onTailnet = () => /\.vyre\.run$|\.ts\.net$/.test(location.hostname);

/** @param {any} ctx */
export default async function settings(ctx) {
  /** @type {Record<string, HTMLElement>} */
  const body = {};
  const secs = SECTIONS.map(([id, label]) => {
    body[id] = h("div", { class: "set-body" }, h("div", { class: "empty" }, "Loading."));
    return h("section", { class: "set-sec", id, "aria-labelledby": id + "-h" }, secHead(id, label), body[id]);
  });

  const navLinks = SECTIONS.map(([id, label]) => h("a", { href: "#" + id, class: "set-nav-a", "data-sec": id,
    onclick: (/** @type {MouseEvent} */ e) => { e.preventDefault(); jump(id, true); } }, label));

  put(ctx.root, h("div", { class: "set" },
    h("div", { class: "phone-head" }, h("span", { style: { display: "flex", gap: "8px", alignItems: "center" } }, mark(18), wordmark(20)),
      h("span", { class: "code" }, location.host)),
    h("div", { class: "set-wrap" },
      h("nav", { class: "set-nav", "aria-label": "Settings sections" }, navLinks),
      h("div", { class: "set-col" },
        h("header", { class: "set-top" },
          h("h1", { class: "h2" }, "Settings"),
          h("p", { class: "muted" }, "Everything the setup did, and everything it skipped. Each part can be finished here or with a vyre command.")),
        secs))));

  // #section: scroll there without a history entry (a hash navigation would re-run the router).
  const jump = (id, record) => {
    const el = ctx.root.querySelector("#" + CSS.escape(id));
    if (!el) return;
    if (record) history.replaceState(null, "", location.pathname + location.search + "#" + id);
    el.scrollIntoView({ block: "start" });
    mark_(id);
  };
  const mark_ = id => { for (const a of navLinks) a.getAttribute("data-sec") === id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current"); };
  const spy = () => {
    const top = ctx.root.getBoundingClientRect().top + 80;
    let cur = SECTIONS[0][0];
    for (const s of secs) if (s.getBoundingClientRect().top <= top) cur = s.id;
    if (ctx.root.scrollTop + ctx.root.clientHeight >= ctx.root.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1][0];
    mark_(cur);
  };
  ctx.root.addEventListener("scroll", spy, { passive: true });
  ctx.cleanup(() => ctx.root.removeEventListener("scroll", spy));
  mark_(SECTIONS[0][0]);

  const loads = [
    drawSetup(body.setup), drawYou(body.you), drawAssistant(body.assistant, ctx), drawClaude(body.claude),
    drawNetwork(body.network), drawHistory(body.history, ctx), drawLessons(body.lessons, ctx),
    drawNotifications(body.notifications, ctx), drawModules(body.modules),
    drawAppearance(body.appearance), drawMachine(body.machine),
  ];
  // A push notification's path is a query (?section=lessons, a plain fetchable link), not a hash.
  const hash = location.hash.slice(1) || ctx.query.get("section") || "";
  if (hash && SECTIONS.some(([id]) => id === hash)) {
    jump(hash, false);
    await Promise.all(loads);
    if (ctx.alive()) jump(hash, false);
  } else await Promise.all(loads);
}

function secHead(id, label) {
  const r = head(label);
  /** @type {HTMLElement} */ (r.firstChild).id = id + "-h";
  return r;
}

/** A settings row: a label on the left, the value or control on the right. */
function row(label, ...value) {
  return h("div", { class: "set-row" }, h("div", { class: "set-k" }, label), h("div", { class: "set-v" }, value));
}
const mono = s => h("span", { class: "mono set-mono" }, s);
const note = (...s) => h("p", { class: "set-note small muted" }, s);
const status = () => h("div", { class: "small muted set-status", role: "status" });
const foot = (...kids) => h("div", { class: "set-actions" }, kids);
const stateLbl = (text, cls = "") => h("span", { class: "set-state " + cls }, text);
/** The onboarding is its own page, not a Deck route, so its links load it. */
const toOnboard = (step, label = "Finish") => h("a", { class: "btn btn-sm", href: "/onboard#" + step }, label);
const errText = e => (e?.missing ? `The ${e.module} module is not running, so this cannot be changed here yet.` : String(e?.message || e));

// ---- 1. Setup ------------------------------------------------------------------------------

async function drawSetup(el) {
  const r = await attempt("onboard.status");
  if (r.error) {
    put(el, empty("Setup progress is kept by the box module.", r.error),
      h("div", { class: "rows" }, STEPS.map(s => stepRow(s, null))));
    return;
  }
  const steps = r.data?.steps || {};
  const left = STEPS.filter(s => (steps[s.id] || "todo") !== "done").length;
  put(el,
    note(left ? `${plural(left, "step")} left. Each opens the same screen the setup showed.` : "Every step is done."),
    h("div", { class: "rows" }, STEPS.map(s => stepRow(s, steps[s.id] || "todo"))));
}

function stepRow(s, st) {
  const label = st === "done" ? "Done" : st === "skipped" ? "Skipped" : st ? "To do" : "";
  return h("div", { class: "set-step" },
    h("span", { class: "set-check" + (st === "done" ? " done" : ""), "aria-hidden": "true" }, st === "done" ? icon("check", 12) : null),
    h("div", { class: "set-step-main" },
      h("div", { class: "set-step-title" }, s.title, label ? stateLbl(label, st === "done" ? "" : "faint") : null),
      h("code", { class: "set-mono" }, s.cmd)),
    toOnboard(s.id, st === "done" ? "Open" : "Finish"));
}

// ---- 2. You and your address ---------------------------------------------------------------

async function drawYou(el) {
  const r = await attempt("onboard.status");
  const here = row("This page", mono(location.host),
    h("div", { class: "small muted" }, onTailnet() ? "Served on your tailnet. Only your devices can open it." : "Served on this machine only, not on your tailnet."));
  if (r.error) { put(el, empty("Your name is kept by the box module.", r.error), h("div", { class: "rows" }, here)); return; }
  const name = r.data?.name || "";
  put(el, h("div", { class: "rows" },
    row("Name", name ? h("span", null, name) : h("span", { class: "muted" }, "Not chosen yet"), name ? null : toOnboard("you")),
    row("Address", name ? mono(`${name}.vyre.run`) : h("span", { class: "muted" }, "None until you pick a name"),
      r.data?.steps?.name === "done" || !name ? null : toOnboard("name")),
    here));
}

// ---- 3. The assistant ----------------------------------------------------------------------

async function drawAssistant(el, ctx) {
  const r = await attempt("agents.list");
  if (!ctx.alive()) return;
  if (r.error) { put(el, empty("The assistant is kept by the switchboard.", r.error)); return; }
  const a = (Array.isArray(r.data) ? r.data : r.data?.agents || []).find(x => x.kind === "assistant");
  if (!a) { put(el, h("div", { class: "empty" }, "There is no assistant yet. The setup makes one."), foot(toOnboard("you"))); return; }
  const show = () => put(el, h("div", { class: "rows" },
      row("Name", h("span", { class: "set-inline" }, h("span", { class: "initial", "aria-hidden": "true" }, a.name.charAt(0).toLowerCase()), link(`/agents/${encodeURIComponent(a.name)}`, { class: "link quiet" }, a.name))),
      row("Instructions", h("p", { class: "set-prose" }, a.instructions || h("span", { class: "muted" }, "None"))),
      row("Skills", a.skills?.length ? h("div", { class: "set-tags" }, a.skills.map(s => h("span", { class: "tag" }, s))) : h("span", { class: "muted" }, "None"))),
    foot(h("button", { type: "button", class: "btn", onclick: edit }, icon("edit", 14), "Edit")));
  const edit = () => {
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: a.name, "aria-label": "Assistant name", autocomplete: "off", spellcheck: "false" }));
    const ins = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", rows: "5", "aria-label": "Instructions" }));
    ins.value = a.instructions || "";
    const st = status();
    const save = h("button", { type: "submit", class: "btn btn-primary" }, "Save");
    put(el, h("form", { class: "set-form", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = { agent: a.name };
      if (name.value.trim() && name.value.trim() !== a.name) input.name = name.value.trim();
      if (ins.value !== (a.instructions || "")) input.instructions = ins.value;
      if (Object.keys(input).length === 1) { show(); return; }
      /** @type {HTMLButtonElement} */ (save).disabled = true;
      const u = await attempt("agents.update", input);
      if (u.error) { put(st, errText(u.error)); /** @type {HTMLButtonElement} */ (save).disabled = false; return; }
      Object.assign(a, u.data && u.data.name ? u.data : { name: input.name || a.name, instructions: input.instructions ?? a.instructions });
      show();
    } },
      h("div", { class: "rows" },
        row(h("label", { for: "as-name" }, "Name"), Object.assign(name, { id: "as-name" })),
        row(h("label", { for: "as-ins" }, "Instructions"), Object.assign(ins, { id: "as-ins" })),
        row("Skills", a.skills?.length ? h("div", { class: "set-tags" }, a.skills.map(s => h("span", { class: "tag" }, s))) : h("span", { class: "muted" }, "None"),
          h("div", { class: "small faint" }, "Skills are added from the assistant's page."))),
      foot(save, h("button", { type: "button", class: "btn btn-ghost", onclick: show }, "Cancel")), st));
    name.focus();
  };
  show();
}

// ---- 4. Claude Code ------------------------------------------------------------------------

async function drawClaude(el) {
  const r = await attempt("onboard.claude", { mode: "detect" });
  if (r.error) { put(el, empty("Claude Code is checked by the box module.", r.error), foot(toOnboard("claude", "Connect"))); return; }
  const c = r.data || {};
  const via = c.via === "setup-token" ? "Your Claude subscription (setup token)" : c.via === "api-key" ? "An Anthropic API key" : "Signed in";
  put(el, h("div", { class: "rows" },
      row("Installed", c.installed ? h("span", null, "Yes", c.version ? mono("  " + c.version) : null) : h("span", { class: "muted" }, "Not found on this machine"),
        c.path ? h("div", { class: "code" }, c.path) : null),
      row("Signed in", c.signedIn ? h("span", null, via) : h("span", { class: "muted" }, "Not signed in"),
        c.signedIn ? h("div", { class: "small faint" }, "Kept in the Vault. No screen shows it, this one included.") : null)),
    foot(toOnboard("claude", c.signedIn ? "Re-connect" : "Connect")));
}

// ---- 5. Network ----------------------------------------------------------------------------

async function drawNetwork(el) {
  const r = await attempt("onboard.tailscale", { action: "detect" });
  if (r.error) { put(el, empty("Tailscale is checked by the box module.", r.error), foot(toOnboard("tailscale", "Connect"))); return; }
  const t = r.data || {};
  const on = t.state === "connected" && t.node;
  put(el, h("div", { class: "rows" },
      row("Tailscale", on ? h("span", null, "Connected") : h("span", { class: "muted" }, !t.installed ? "Not installed" : t.state === "needs-login" ? "Waiting for sign-in" : "Not connected")),
      on ? row("Node", mono(t.node.dns || t.node.name || "")) : null,
      on ? row("Tailnet IP", mono(t.node.ip || "")) : null),
    on ? null : foot(toOnboard("tailscale", "Connect")));
}

// ---- 6. History and memory -----------------------------------------------------------------

async function drawHistory(el, ctx) {
  const recallBox = h("div");
  const memBox = h("div", { class: "set-sub" });
  put(el, recallBox, memBox);

  const drawRecall = async () => {
    const r = await attempt("recall.status");
    if (!ctx.alive()) return;
    if (r.error) { put(recallBox, h("h3", { class: "set-h3" }, "History"), empty("History search is not available.", r.error)); return; }
    const s = r.data || {};
    const st = status();
    const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", disabled: !!s.indexing }, s.indexing ? "Indexing" : "Re-index now"));
    btn.addEventListener("click", async () => {
      btn.disabled = true; put(btn, "Indexing");
      const x = await attempt("recall.index");
      if (!ctx.alive()) return;
      if (x.error) { put(st, errText(x.error)); btn.disabled = false; put(btn, "Re-index now"); return; }
      drawRecall();
    });
    const last = s.last;
    const v = s.vectors || {};
    put(recallBox,
      h("h3", { class: "set-h3" }, "History"),
      h("div", { class: "rows" },
        row("Indexed", h("span", null, plural(s.sessions || 0, "session"), h("span", { class: "faint" }, " · "), plural(s.turns || 0, "turn"))),
        row("Folders", (s.folders || []).length ? h("div", { class: "set-list" }, s.folders.map(f => h("code", { class: "set-mono", title: f }, f))) : h("span", { class: "muted" }, "None")),
        row("Last pass", last?.at ? h("span", null, `${since(last.at)} ago`, h("span", { class: "faint" }, ` · ${when(last.at)}`)) : h("span", { class: "muted" }, "Not yet"),
          last?.at ? h("div", { class: "small faint" }, [last.added ? `${last.added} added` : "", last.appended ? `${last.appended} appended` : "",
            `${last.skipped || 0} unchanged`, last.failed ? `${last.failed} failed` : ""].filter(Boolean).join(" · ")) : null,
          s.every ? h("div", { class: "small faint" }, `Checks for new sessions every ${s.every} min.`) : null),
        row("Vectors", v.on ? h("span", null, "On", h("span", { class: "faint" }, ` · ${v.embedded || 0} embedded, ${v.pending || 0} waiting`))
          : h("span", null, "Off", v.why ? h("div", { class: "small faint" }, cap(v.why) + ".") : null)),
        s.error ? row("Problem", h("span", null, String(s.error))) : null),
      foot(btn, h("span", { class: "small faint" }, "Reads new and changed sessions now.")), st);
  };

  const drawMemory = async () => {
    const r = await attempt("memory.stats");
    if (!ctx.alive()) return;
    if (r.error) { put(memBox, h("h3", { class: "set-h3" }, "Memory"), empty("Memory is not available.", r.error)); return; }
    const m = r.data || {};
    const st = status();
    const actions = h("div", { class: "set-actions" });
    const idle = () => put(actions, h("button", { type: "button", class: "btn", onclick: confirm_ }, "Rebuild memory"),
      h("span", { class: "small faint" }, "Rereads every turn from the start."));
    const confirm_ = () => put(actions,
      h("span", { class: "small" }, `This rereads all ${plural(m.turns || m.lastRun?.turns || 0, "turn")} and rebuilds the graph. Pins and mutes stay.`),
      h("button", { type: "button", class: "btn", onclick: run }, "Rebuild"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: idle }, "Cancel"));
    const run = async () => {
      put(actions, h("span", { class: "small muted" }, "Rebuilding memory."));
      const x = await attempt("memory.curate", { full: true });
      if (!ctx.alive()) return;
      if (x.error) { put(st, errText(x.error)); idle(); return; }
      drawMemory();
    };
    idle();
    put(memBox,
      h("h3", { class: "set-h3" }, "Memory"),
      h("div", { class: "rows" },
        row("Holds", h("span", null, plural(m.nodes || 0, "node"), h("span", { class: "faint" }, " · "), plural(m.facts || 0, "fact"),
          h("span", { class: "faint" }, " · "), plural(m.edges || 0, "link"))),
        row("Last curator run", m.lastRun?.at ? h("span", null, `${since(m.lastRun.at)} ago`, h("span", { class: "faint" }, ` · ${when(m.lastRun.at)}`))
          : h("span", { class: "muted" }, "Not yet"),
          m.lastRun?.at ? h("div", { class: "small faint" }, `${plural(m.lastRun.turns || 0, "turn")} read in ${m.lastRun.ms || 0} ms`) : null)),
      actions, st);
  };

  let t1 = 0, t2 = 0;
  ctx.on("session.indexed", () => { clearTimeout(t1); t1 = window.setTimeout(drawRecall, 400); });
  ctx.on("memory.curated", () => { clearTimeout(t2); t2 = window.setTimeout(drawMemory, 400); });
  ctx.cleanup(() => { clearTimeout(t1); clearTimeout(t2); });
  await Promise.all([drawRecall(), drawMemory()]);
}
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// ---- 7. Lessons ----------------------------------------------------------------------------

const LEVELS = ["remind", "ask", "block"];
const SCOPES = [["all", "Everywhere"], ["project", "One project"], ["agent", "One agent"]];

async function drawLessons(el, ctx) {
  const draw = async () => {
    const [r, p] = await Promise.all([attempt("learn.lessons", {}), attempt("projects.list")]);
    for (const x of p.data?.projects || []) projectNames.set(x.slug, x.name);
    if (!ctx.alive()) return;
    if (r.error) { put(el, empty("Lessons are kept by the learning module.", r.error)); return; }
    const list = Array.isArray(r.data) ? r.data : r.data?.lessons || [];
    if (!list.length) { put(el, h("div", { class: "empty" }, "No lessons yet. When you correct Vyre, what it learned shows here.")); return; }
    put(el,
      note("What Vyre learned from your corrections. A lesson with a check is enforced by hooks; one broken again moves up a level."),
      h("div", { class: "rows set-lessons" }, list.map(l => lessonRow(l, () => draw()))));
  };
  ctx.on("lesson.learned", draw);
  ctx.on("lesson.escalated", draw);
  await draw();
}

const projectNames = new Map();
function scopeText(l) {
  if (l.scope === "project") return l.target ? `Only in ${projectNames.get(l.target) || l.target}` : "One project";
  if (l.scope === "agent") return l.target ? `Only for ${l.target}` : "One agent";
  return "Everywhere";
}
const SOURCE = { correction: "your correction", remember: "you asked me to remember", "draft-edit": "your edit to a draft", denied: "a call you denied", revert: "a change you reverted" };

function lessonRow(l, reload) {
  const el = h("div", { class: "set-lesson" });
  const st = status();
  const show = () => {
    const src = l.source || {};
    const from = SOURCE[src.kind] || src.kind || "a thread";
    put(el,
      h("div", { class: "set-lesson-main" },
        h("div", { class: "set-lesson-rule" }, l.rule),
        h("div", { class: "set-lesson-meta small" },
          h("span", { class: "tag set-level" + (l.level === "block" ? " strong" : "") }, l.level),
          l.check ? h("span", { class: "tag" }, "check") : null,
          h("span", { class: "muted" }, scopeText(l)),
          l.when ? h("span", { class: "faint" }, `when ${l.when}`) : null),
        h("div", { class: "set-lesson-meta small faint" },
          h("span", null, `Applied ${l.applied || 0}, broken ${l.broken || 0}`),
          h("span", null, "From ", src.thread ? link(`/threads/${encodeURIComponent(src.thread)}`, { class: "link", style: { color: "var(--text-2)" } }, from) : from,
            src.at ? `, ${when(src.at)}` : ""))),
      h("div", { class: "set-lesson-act" },
        h("button", { type: "button", class: "ibtn", "aria-label": "Edit lesson: " + l.rule, onclick: edit }, icon("edit")),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: retire }, "Retire")),
      st);
  };
  const retire = () => put(el,
    h("div", { class: "set-lesson-main" }, h("div", { class: "set-lesson-rule" }, l.rule),
      h("div", { class: "small muted" }, "Retire this lesson? Vyre stops applying it.")),
    h("div", { class: "set-lesson-act" },
      h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        const x = await attempt("learn.retire", { id: l.id });
        if (x.error) { show(); put(st, errText(x.error)); return; }
        el.remove(); reload();
      } }, "Retire"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel")), st);
  const edit = () => {
    const rule = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", rows: "2", "aria-label": "Rule" }));
    rule.value = l.rule;
    let level = l.level;
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Level" });
    const drawSeg = () => put(seg, LEVELS.map(v => h("button", { type: "button", "aria-pressed": String(v === level), onclick: () => { level = v; drawSeg(); } }, cap(v))));
    drawSeg();
    const scope = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", "aria-label": "Scope" },
      SCOPES.map(([v, t]) => h("option", { value: v, selected: v === l.scope }, v === l.scope && l.target ? scopeText(l) : t))));
    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm" }, "Save"));
    put(el, h("form", { class: "set-lesson-edit", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = { id: l.id };
      if (rule.value.trim() && rule.value.trim() !== l.rule) input.rule = rule.value.trim();
      if (level !== l.level) input.level = level;
      if (scope.value !== l.scope) input.scope = scope.value;
      if (Object.keys(input).length === 1) { show(); return; }
      save.disabled = true;
      const x = await attempt("learn.edit", input);
      if (x.error) { save.disabled = false; put(st, errText(x.error)); return; }
      Object.assign(l, x.data && x.data.id ? x.data : input);
      if (input.scope && input.scope !== "all" && !(x.data && x.data.id)) delete l.target;
      show();
    } },
      rule,
      h("div", { class: "set-lesson-fields" }, seg, scope),
      h("div", { class: "set-actions" }, save, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel")), st));
    rule.focus();
  };
  show();
  return el;
}

// ---- notifications ---------------------------------------------------------------------------

/** base64url (as push.key gives it) to the raw bytes pushManager.subscribe wants. */
const b64 = s => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = () => !!(window.matchMedia?.("(display-mode: standalone)").matches || /** @type {any} */ (window.navigator).standalone);
/** push.devices never gives back an endpoint to match against, so this device's id is kept here,
 * set once from push.subscribe's own answer. */
const DEVICE_KEY = "vyre.push.device";
const myDevice = () => { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } };
const setMyDevice = id => { try { id ? localStorage.setItem(DEVICE_KEY, id) : localStorage.removeItem(DEVICE_KEY); } catch {} };

async function drawNotifications(el, ctx) {
  // iOS only delivers Web Push to an installed (Home Screen) app; asking for permission from an
  // ordinary Safari tab silently cannot work, so say so instead of showing a button that fails.
  if (isIOS() && !isStandalone()) {
    put(el, note('iOS only delivers notifications to an installed app. Add Vyre to your Home Screen first — the Share button, then "Add to Home Screen" — then open it from there and come back here.'));
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    put(el, note("This browser does not support push notifications."));
    return;
  }
  const deviceBox = h("div");
  const settingsBox = h("div");
  const st = status();
  put(el, deviceBox, settingsBox, st);

  const draw = async () => {
    const [devicesR, settingsR] = await Promise.all([attempt("push.devices"), attempt("push.settings")]);
    if (!ctx.alive()) return;
    if (devicesR.error) { put(deviceBox, empty("Push is kept by its own module.", devicesR.error)); return; }
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    const devices = devicesR.data || [];

    const subscribe = async () => {
      put(st, "Asking for permission…");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { put(st, "Notifications were not allowed."); return; }
      const key = await attempt("push.key");
      if (key.error) { put(st, errText(key.error)); return; }
      put(st, "Turning on…");
      let newSub;
      try { newSub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key.data.public_key) }); }
      catch (e) { put(st, String(/** @type {any} */ (e)?.message || e)); return; }
      const label = isIOS() ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "This browser";
      const r = await attempt("push.subscribe", { subscription: newSub.toJSON(), label });
      if (r.error) { put(st, errText(r.error)); newSub.unsubscribe().catch(() => {}); return; }
      setMyDevice(r.data?.device || null);
      put(st, "");
      draw();
    };
    // "This device" unsubscribes by the id push.subscribe gave; if that was lost (another tab,
    // cleared storage) but the browser still holds a live subscription, the endpoint still
    // identifies it server-side. A listed device unsubscribes by its id, browser-side or not.
    const unsubscribe = async (device, endpoint) => {
      put(st, "Turning off…");
      const r = await attempt("push.unsubscribe", device ? { device } : { endpoint });
      if (r.error) { put(st, errText(r.error)); return; }
      if (device && device === myDevice()) setMyDevice(null);
      if (sub && (device === myDevice() || endpoint === sub.endpoint)) await sub.unsubscribe().catch(() => {});
      put(st, "");
      draw();
    };

    const mine = myDevice();
    put(deviceBox, h("div", { class: "rows" },
      sub
        ? row("This device", stateLbl("On"), h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => unsubscribe(mine, sub.endpoint) }, "Turn off"))
        : row("This device", h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: subscribe }, "Turn on notifications")),
      ...devices.filter(d => d.device !== mine).map(d => row(d.label || "A device",
        h("span", { class: "small faint" }, d.fails ? "failing" : d.last_ok ? `last delivered ${since(d.last_ok)} ago` : "not tried yet"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => unsubscribe(d.device) }, "Remove")))));

    if (settingsR.error) { put(settingsBox); return; }
    const s = settingsR.data || {};
    const quietOn = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: !!s.quiet }));
    const start = /** @type {HTMLInputElement} */ (h("input", { type: "time", class: "input", value: s.quiet?.start || "22:00" }));
    const end = /** @type {HTMLInputElement} */ (h("input", { type: "time", class: "input", value: s.quiet?.end || "07:00" }));
    const syncQuiet = () => { start.disabled = end.disabled = !quietOn.checked; };
    const saveQuiet = () => attempt("push.settings", { quiet: quietOn.checked
      ? { start: start.value, end: end.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null });
    syncQuiet();
    for (const el2 of [quietOn, start, end]) el2.addEventListener("change", () => { syncQuiet(); saveQuiet(); });
    const KINDS = [["ask", "Permission questions"], ["draft", "Held drafts"], ["watch", "Threads you're watching"], ["lesson", "Lessons"]];
    put(settingsBox, h("div", { class: "rows" },
      row("Quiet hours", quietOn, start, h("span", { class: "small faint" }, "to"), end)),
      h("div", { class: "rows" }, KINDS.map(([k, label]) => {
        const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: s.kinds?.[k] !== false,
          onchange: () => attempt("push.settings", { kinds: { [k]: box.checked } }) }));
        return row(label, box);
      })),
      sub ? foot(h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        put(st, "Sending…"); const t = await attempt("push.test");
        put(st, t.error ? errText(t.error) : t.data?.sent ? "Sent." : "Not sent.");
      } }, "Send a test")) : null);
  };
  draw();
}

// ---- 8. Modules ----------------------------------------------------------------------------

const STATE = { running: "running", failed: "failed", invalid: "failed", off: "disabled", disabled: "disabled", pending: "starting" };

async function drawModules(el) {
  const list = await modules();
  if (!list.length) { put(el, h("div", { class: "empty" }, "vyred did not list its modules.", h("span", { class: "code" }, "It may not be running. Start it with vyre up."))); return; }
  const order = { failed: 0, starting: 1, running: 2, disabled: 3 };
  const rows = [...list].sort((a, b) => (order[STATE[a.state] || "disabled"] - order[STATE[b.state] || "disabled"]) || a.name.localeCompare(b.name));
  const bad = rows.filter(m => STATE[m.state] === "failed").length;
  put(el,
    note(`${plural(rows.filter(m => m.state === "running").length, "module")} running${bad ? `, ${bad} failed` : ""}. A module that fails is turned off and reported here; it never stops vyred.`),
    h("table", { class: "set-table" },
      h("thead", null, h("tr", null, h("th", { class: "lbl", scope: "col" }, "Module"), h("th", { class: "lbl", scope: "col" }, "Version"), h("th", { class: "lbl", scope: "col" }, "State"))),
      h("tbody", null, rows.map(m => {
        const s = STATE[m.state] || m.state || "unknown";
        return h("tr", null,
          h("td", null, h("div", { class: "mono set-mod" }, m.name), m.error ? h("div", { class: "small muted set-problem" }, m.error) : null),
          h("td", { class: "code" }, m.version || ""),
          h("td", null, stateLbl(s, s === "running" ? "" : "faint")));
      }))));
}

// ---- 9. Appearance -------------------------------------------------------------------------

function drawAppearance(el) {
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Theme" });
  const cur = () => document.documentElement.dataset.theme === "paper" ? "paper" : "dark";
  const set = v => {
    if (v === "paper") document.documentElement.dataset.theme = "paper"; else delete document.documentElement.dataset.theme;
    try { if (v === "paper") localStorage.setItem("vyre.theme", "paper"); else localStorage.removeItem("vyre.theme"); } catch {}
    draw();
  };
  const draw = () => put(seg, [["dark", "Dark"], ["paper", "Paper"]].map(([v, t]) =>
    h("button", { type: "button", "aria-pressed": String(cur() === v), onclick: () => set(v) }, t)));
  draw();
  put(el, h("div", { class: "rows" },
    row("Theme", seg, h("div", { class: "small faint" }, "Kept in this browser only. Your other devices keep their own."))));
}

// ---- 10. This machine ----------------------------------------------------------------------

async function drawMachine(el) {
  const r = await attempt("system.info");
  if (r.error) { put(el, empty("vyred did not say what it runs on.", r.error)); return; }
  const s = r.data || {};
  put(el, h("div", { class: "rows" },
    row("Host", mono(s.host || "")),
    row("Role", h("span", null, s.role === "box" ? "Box" : s.role === "local" ? "Local" : s.role || ""),
      h("div", { class: "small faint" }, s.role === "box" ? "Always on. Runs the agents and serves your address." : "Your own computer. Connects to your box over the tailnet.")),
    row("Vyre", mono(s.version || "")),
    row("Platform", mono(s.platform || "")),
    row("Node", mono(s.node || ""))));
}

