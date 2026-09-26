// @ts-check
// Agents: every agent with what it is doing (/agents), and one agent's board (/agents/:name).
// Board: DeckAgent. Spec section 10.
//
// Tools: agents.list, agents.create, agents.update, agents.stop, agents.ask (switchboard),
// watchers.list, watchers.pause (watchers), computers.get, computers.restart, computers.limits
// (computers), threads.list for thread names and times, projects.list for project names.
// Each may be missing; each section then says which module is not running.

import { h, put, link, head, empty } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import * as needs from "../js/needs.js";
import { since, initial, count } from "../js/fmt.js";

const MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];
const EFFORT = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const SOURCE = { gmail: ["mail", "Gmail"], slack: ["chat", "Slack"], schedule: ["clock", "Schedule"], github: ["branch", "GitHub"],
  fathom: ["mic", "Fathom"], files: ["file", "Files"], web: ["search", "Web"] };
const VAULT_SUB = "claude-setup-token";
const VAULT_KEY = "anthropic-api-key";

const threadHref = (thread, project) => project ? `/projects/${encodeURIComponent(project)}/${encodeURIComponent(thread)}` : `/threads/${encodeURIComponent(thread)}`;
const agentHref = name => `/agents/${encodeURIComponent(name)}`;
const glassHref = name => `/agents/${encodeURIComponent(name)}/glass`;
const why = err => err?.missing ? `The ${err.module} module is not running on this machine.` : String(err?.message || err || "");

/** @param {any} ctx */
export default async function agents(ctx) {
  if (ctx.params.name) return board(ctx, ctx.params.name);
  return list(ctx);
}

/** Project names from projects.list, then from thread records (fixture projects may not exist live), else the slug. */
async function world() {
  const [p, t] = await Promise.all([attempt("projects.list"), attempt("threads.list", {})]);
  const names = new Map();
  for (const th of t.data || []) if (th.project && th.projectName) names.set(th.project, th.projectName);
  for (const pr of p.data?.projects || []) names.set(pr.slug, pr.name);
  const threads = new Map((t.data || []).map(th => [th.id, th]));
  return { names, threads, projects: p.data?.projects || [], threadsErr: t.error || null };
}
const nameOf = (names, slug) => names.get(slug) || slug;

/** "Working in Launch site · Hero copy pass" pieces for an agent. */
function doing(a, w) {
  if (a.state !== "working" || !a.thread) return null;
  const t = w.threads.get(a.thread);
  const project = t?.project || null;
  const label = [project ? nameOf(w.names, project) : null, t?.name || a.thread].filter(Boolean).join(" · ");
  return { href: threadHref(a.thread, project), label, started: t?.started || null };
}

function projectsText(a, names) {
  if (a.projects === "*") return ["Every project"];
  return (Array.isArray(a.projects) ? a.projects : []).map(s => nameOf(names, s));
}

// ---- /agents ---------------------------------------------------------------------------------

async function list(ctx) {
  const title = h("h1", { class: "h2" }, "Agents");
  const sub = h("p", { class: "muted" }, " ");
  const newBtn = h("button", { type: "button", class: "btn btn-primary", "aria-expanded": "false", "aria-controls": "ag-new" }, icon("plus", 14), "New agent");
  const form = h("section", { class: "ag-new", id: "ag-new", hidden: true, "aria-label": "New agent" });
  const rows = h("section", { class: "ag-list", "aria-labelledby": "ag-list-h" });
  put(ctx.root, h("div", { class: "ag" }, h("div", { class: "ag-col" },
    h("div", { class: "ag-top" }, h("div", { class: "ag-top-text" }, title, sub), newBtn),
    form, rows)));

  /** @type {any[]} */ let all = [];
  let w = await world();
  let listErr = null;

  const draw = () => {
    const headRow = head("Every agent", h("span", { class: "lbl" }, listErr ? "" : `${all.filter(a => a.state === "working").length} working`));
    /** @type {HTMLElement} */ (headRow.firstChild).id = "ag-list-h";
    if (listErr) {
      put(sub, "Agents are kept by the switchboard.");
      put(rows, headRow, empty("No agents can be listed.", listErr));
      return;
    }
    const assistant = all.find(a => a.kind === "assistant");
    const others = all.filter(a => a.kind !== "assistant");
    put(sub, assistant ? `${assistant.name} is your assistant and can see every project. ${others.length ? `${count(others.length)} other agent${others.length === 1 ? "" : "s"} work${others.length === 1 ? "s" : ""} in the projects you gave ${others.length === 1 ? "it" : "them"}.` : "No other agents yet."}`
      : "No assistant yet. Onboarding makes one.");
    put(rows, headRow, all.length ? h("div", { class: "rows" }, [assistant, ...others].filter(Boolean).map(a => agentRow(a, w))) : h("div", { class: "empty" }, "No agents yet."));
  };

  const load = async () => {
    const r = await attempt("agents.list");
    if (!ctx.alive()) return;
    listErr = r.error || null;
    all = Array.isArray(r.data) ? r.data : r.data?.agents || [];
    draw();
  };
  await load();

  newBtn.addEventListener("click", () => {
    newBtn.hidden = true;
    form.hidden = false;
    newBtn.setAttribute("aria-expanded", "true");
    put(form, newForm(w, {
      done: (a) => { form.hidden = true; newBtn.hidden = false; newBtn.setAttribute("aria-expanded", "false");
        if (a) { all = all.filter(x => x.name !== a.name).concat(a); draw(); } newBtn.focus(); },
    }));
    /** @type {HTMLElement|null} */ (form.querySelector("input"))?.focus();
  });

  let t = 0;
  const later = () => { clearTimeout(t); t = window.setTimeout(async () => { w = await world(); if (ctx.alive()) load(); }, 300); };
  for (const e of ["thread.started", "thread.finished"]) ctx.on(e, later);
  ctx.cleanup(() => clearTimeout(t));
}

function agentRow(a, w) {
  const d = doing(a, w);
  const where = projectsText(a, w.names);
  return link(agentHref(a.name), { class: "ag-row" },
    h("span", { class: "ag-tile", "aria-hidden": "true" }, initial(a.name)),
    h("span", { class: "ag-row-main" },
      h("span", { class: "ag-row-name" }, h("span", { class: "ag-name" }, a.name),
        a.kind === "assistant" ? h("span", { class: "tag" }, "Assistant") : null,
        a.role && a.role !== "Assistant" ? h("span", { class: "small muted" }, a.role) : null),
      h("span", { class: "ag-row-state small" },
        h("span", { class: "ag-dot" + (d ? " on" : ""), "aria-hidden": "true" }),
        d ? h("span", { class: "ellipsis" }, "Working in ", h("span", { class: "ag-em" }, d.label), d.started ? h("span", { class: "faint" }, ` for ${since(d.started)}`) : null)
          : h("span", { class: "faint" }, "Idle"))),
    h("span", { class: "ag-row-projects" }, where.map(p => h("span", { class: "ag-chip" }, p))),
    h("span", { class: "ag-chev", "aria-hidden": "true" }, icon("right")));
}

/** The New agent form. Auth is chosen by Vault item name; no value is ever typed here. */
function newForm(w, { done }) {
  const status = h("div", { class: "small muted", role: "status" });
  const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "na-name", required: true, autocomplete: "off", spellcheck: "false",
    placeholder: "e.g. rex", "aria-describedby": "na-name-hint" }));
  const instr = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", id: "na-job", rows: "3", placeholder: "What this agent does, and what it must ask you before doing." }));
  const slugs = [...w.names.keys()];
  const boxes = slugs.map(s => /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", value: s })));
  const auth = { kind: "sub" };
  const subVault = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: VAULT_SUB, "aria-label": "Vault item for the setup token", list: "na-vault", spellcheck: "false" }));
  const keyVault = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: VAULT_KEY, "aria-label": "Vault item for the API key", list: "na-vault", spellcheck: "false" }));
  const budget = /** @type {HTMLInputElement} */ (h("input", { class: "input na-budget", type: "number", min: "1", step: "1", value: "10", "aria-label": "Monthly budget in US dollars" }));
  const fallback = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: true }));
  const computer = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox" }));
  const vaultList = h("datalist", { id: "na-vault" });
  attempt("vault.list").then(r => {
    const items = Array.isArray(r.data) ? r.data : r.data?.items || [];
    put(vaultList, items.map(i => h("option", { value: typeof i === "string" ? i : i.name })));
  });

  const radio = (value, label, hint) => h("label", { class: "na-radio" },
    h("input", { type: "radio", name: "na-auth", value, checked: auth.kind === value, onchange: () => { auth.kind = value; drawAuth(); } }),
    h("span", null, h("span", { class: "na-radio-t" }, label), h("span", { class: "small faint" }, hint)));
  const authBox = h("div", { class: "na-auth-detail" });
  const drawAuth = () => put(authBox, auth.kind === "sub"
    ? [h("div", { class: "na-line" }, h("span", { class: "small faint na-k" }, "Vault item"), subVault),
      h("label", { class: "na-check small" }, fallback, "When the subscription limit is reached, fall back to an API key"),
      fallback.checked ? h("div", { class: "na-line" }, h("span", { class: "small faint na-k" }, "Key item"), keyVault, h("span", { class: "small faint" }, "up to $"), budget) : null]
    : [h("div", { class: "na-line" }, h("span", { class: "small faint na-k" }, "Vault item"), keyVault),
      h("div", { class: "na-line" }, h("span", { class: "small faint na-k" }, "Budget"), h("span", { class: "small faint" }, "$"), budget, h("span", { class: "small faint" }, "a month"))]);
  fallback.addEventListener("change", drawAuth);
  drawAuth();

  const create = h("button", { type: "submit", class: "btn btn-primary" }, "Create agent");
  const submit = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const n = name.value.trim();
    const projects = boxes.filter(b => b.checked).map(b => b.value);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(n)) { put(status, "A name is lowercase letters, digits and dashes, starting with a letter."); name.focus(); return; }
    if (slugs.length && !projects.length) { put(status, "Pick at least one project. An agent never sees projects outside its list."); return; }
    const b = Number(budget.value);
    /** @type {any} */ const a = auth.kind === "sub" ? { vault: subVault.value.trim() || VAULT_SUB } : { vault: keyVault.value.trim() || VAULT_KEY, budget_usd: b };
    if (auth.kind === "sub" && fallback.checked) { a.fallback = keyVault.value.trim() || VAULT_KEY; a.budget_usd = b; }
    if (a.budget_usd !== undefined && !(b > 0)) { put(status, "The budget is a number of dollars above zero."); budget.focus(); return; }
    const input = { name: n, kind: "agent", projects, instructions: instr.value.trim(), auth: a, computer: computer.checked };
    /** @type {HTMLButtonElement} */ (create).disabled = true;
    put(status, "Creating…");
    const r = await attempt("agents.create", input);
    /** @type {HTMLButtonElement} */ (create).disabled = false;
    if (r.error) { put(status, r.error.missing ? `${why(r.error)} The agent was not created.` : why(r.error)); return; }
    done({ ...input, role: "", state: "idle", skills: [], model: MODELS[1].id, ...(r.data && typeof r.data === "object" ? { name: r.data.name === "new-agent" ? n : r.data.name || n } : {}) });
  };

  return h("form", { class: "na", onsubmit: submit, novalidate: true },
    head("New agent"),
    h("div", { class: "na-grid" },
      h("label", { class: "na-k lbl", for: "na-name" }, "Name"),
      h("div", null, name, h("div", { class: "small faint na-hint", id: "na-name-hint" }, "Lowercase, one word. It signs its threads with it.")),
      h("span", { class: "na-k lbl", id: "na-where" }, "Works in"),
      h("div", { role: "group", "aria-labelledby": "na-where", class: "na-projects" },
        slugs.length ? slugs.map((s, i) => h("label", { class: "na-pick" }, boxes[i], nameOf(w.names, s)))
          : h("span", { class: "small faint" }, "No projects yet. It will see none until you add some.")),
      h("label", { class: "na-k lbl", for: "na-job" }, "Job"),
      instr,
      h("span", { class: "na-k lbl", id: "na-authl" }, "Runs on"),
      h("div", { role: "radiogroup", "aria-labelledby": "na-authl", class: "na-auth" },
        radio("sub", "Claude subscription (setup token)", "Uses your plan. The token stays in the Vault."),
        radio("key", "API key with a budget", "Stops when the budget is spent."),
        authBox, vaultList),
      h("span", { class: "na-k lbl" }, "Computer"),
      h("label", { class: "na-check small" }, computer, "Give it its own computer, from the pool")),
    h("div", { class: "na-actions" }, create, h("button", { type: "button", class: "btn btn-ghost", onclick: () => done(null) }, "Cancel"), status));
}

// ---- /agents/:name ---------------------------------------------------------------------------

async function board(ctx, agentName) {
  const [r, w] = await Promise.all([attempt("agents.list"), world()]);
  if (!ctx.alive()) return;
  const all = Array.isArray(r.data) ? r.data : r.data?.agents || [];
  let a = all.find(x => x.name === agentName);
  if (!r.error && !a) {
    put(ctx.root, h("div", { class: "ag" }, h("div", { class: "ag-col" },
      h("div", { class: "lbl" }, "Agents"),
      h("h1", { class: "h2", style: { marginTop: "10px" } }, `There is no agent called ${agentName}.`),
      h("p", { class: "muted", style: { marginTop: "8px" } }, link("/agents", { class: "link" }, "Every agent")))));
    return;
  }
  const stub = !a;
  a = a || { name: agentName, projects: [], state: "unknown" };
  const listErr = r.error || null;
  const nm = a.name;

  const headEl = h("div", { class: "ab-head" });
  const job = h("section", { class: "ab-sec", "aria-labelledby": "ab-job" });
  const talk = h("section", { class: "ab-sec ab-talk", "aria-labelledby": "ab-talk" });
  const wakes = h("section", { class: "ab-sec", "aria-labelledby": "ab-wakes" });
  const model = h("section", { class: "ab-sec", "aria-labelledby": "ab-model" });
  const comp = h("aside", { class: "ab-aside", "aria-labelledby": "ab-comp" });
  put(ctx.root, h("div", { class: "ab" }, headEl,
    h("div", { class: "ab-body" }, h("div", { class: "ab-main" }, job, talk, wakes, model), comp)));

  // Computers: fetched first so the header knows whether Glass can open.
  /** @type {{ data?: any, error?: any }} */ let cr = { data: null };
  const loadComputer = async () => { cr = a.computer ? await attempt("computers.get", { agent: nm }) : { data: null }; };
  await loadComputer();
  if (!ctx.alive()) return;

  // Header
  const pauseStatus = h("span", { class: "small muted ab-pause-status", role: "status" });
  const drawHead = () => {
    const d = doing(a, w);
    const held = needs.current().filter(n => n.agent === nm);
    const heldText = held.length ? ` ${count(held.length)} call${held.length === 1 ? "" : "s"} held${held[0].projectName ? ` in ${held[0].projectName}` : ""}.` : "";
    const status = stub ? h("div", { class: "ab-status" }, h("span", { class: "ag-dot", "aria-hidden": "true" }),
        h("span", null, `${why(listErr)} ${nm}'s state and job cannot be read.`))
      : d ? h("div", { class: "ab-status" }, h("span", { class: "ag-dot on", "aria-hidden": "true" }), "Working in ", link(d.href, { class: "link" }, d.label),
        h("span", { class: "faint" }, `${d.started ? ` for ${since(d.started)}.` : "."}${heldText}`))
      : h("div", { class: "ab-status" }, h("span", { class: "ag-dot", "aria-hidden": "true" }), h("span", { class: "faint" }, `Idle. Nothing is running.${heldText}`));
    const pause = h("button", { type: "button", class: "btn", disabled: stub || a.state !== "working",
      title: stub ? why(listErr) : a.state !== "working" ? `${nm} is not running anything.` : false,
      onclick: async () => {
        /** @type {HTMLButtonElement} */ (pause).disabled = true;
        const s = await attempt("agents.stop", { agent: nm });
        if (!ctx.alive()) return;
        if (s.error) { put(pauseStatus, why(s.error)); /** @type {HTMLButtonElement} */ (pause).disabled = false; return; }
        a.state = "idle";
        drawHead();
        put(pauseStatus, `Paused. ${nm} stopped its thread.`);
      } }, `Pause ${nm}`);
    const glassWhy = !a.computer ? (stub ? why(listErr) : `${nm} has no computer.`) : cr.error ? why(cr.error) : null;
    const glass = glassWhy
      ? h("button", { type: "button", class: "btn btn-primary", disabled: true, title: glassWhy }, icon("watch", 14), "Open Glass")
      : link(glassHref(nm), { class: "btn btn-primary" }, icon("watch", 14), "Open Glass");
    put(headEl,
      h("span", { class: "ab-tile", "aria-hidden": "true" }, initial(nm)),
      h("div", { class: "ab-id" },
        h("div", { class: "ab-name" }, h("h1", { class: "h2" }, nm),
          a.kind === "assistant" ? h("span", { class: "tag" }, "Assistant") : null,
          a.role && a.role !== "Assistant" ? h("span", { class: "muted" }, a.role) : null),
        status, pauseStatus),
      h("div", { class: "ab-acts" }, pause, glass));
  };
  drawHead();
  ctx.cleanup(needs.watch(drawHead));
  let ht = 0;
  const refresh = () => { clearTimeout(ht); ht = window.setTimeout(async () => {
    const [r2, w2] = await Promise.all([attempt("agents.list"), world()]);
    if (!ctx.alive()) return;
    const fresh = (Array.isArray(r2.data) ? r2.data : r2.data?.agents || []).find(x => x.name === nm);
    if (fresh) a.state = fresh.state, a.thread = fresh.thread;
    w.threads = w2.threads;
    drawHead();
  }, 300); };
  for (const e of ["thread.started", "thread.finished"]) ctx.on(e, refresh);
  ctx.cleanup(() => clearTimeout(ht));

  drawJob(job, a, w, stub, listErr);
  drawTalk(talk, a, ctx);
  drawWakes(wakes, a, w, ctx);
  drawModel(model, a, stub, listErr);
  const drawComp = () => drawComputer(comp, a, cr, stub, listErr, async () => { await loadComputer(); if (ctx.alive()) { drawComp(); drawHead(); } });
  drawComp();
}

function sectionHead(id, label, right) {
  const el = head(label, right || null);
  /** @type {HTMLElement} */ (el.firstChild).id = id;
  return el;
}

function drawJob(sec, a, w, stub, listErr) {
  const status = h("span", { class: "small muted", role: "status" });
  const where = a.projects === "*" ? h("span", { class: "ag-chip" }, "Every project")
    : (Array.isArray(a.projects) ? a.projects : []).map(s => link(`/projects/${encodeURIComponent(s)}`, { class: "ag-chip ag-chip-a" }, nameOf(w.names, s)));
  const view = () => {
    const edit = h("button", { type: "button", class: "link ab-edit", disabled: stub, onclick: () => editing() }, "Edit");
    put(sec, sectionHead("ab-job", "Job", stub ? null : edit),
      stub ? empty(`${a.name}'s job is kept by the switchboard.`, listErr)
        : h("p", { class: "ab-job" }, a.instructions || h("span", { class: "faint" }, "No instructions yet.")),
      stub ? null : h("div", { class: "ab-where" }, h("span", { class: "small faint" }, "Works in"), where),
      status);
  };
  const editing = () => {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input ab-job-edit", rows: "4", "aria-label": `${a.name}'s job` }));
    ta.value = a.instructions || "";
    const save = h("button", { type: "button", class: "btn", onclick: async () => {
      /** @type {HTMLButtonElement} */ (save).disabled = true;
      const r = await attempt("agents.update", { agent: a.name, instructions: ta.value.trim() });
      /** @type {HTMLButtonElement} */ (save).disabled = false;
      if (r.error) { put(status, why(r.error)); return; }
      a.instructions = ta.value.trim();
      view();
      put(status, "Saved. It applies from the next turn.");
    } }, "Save");
    put(sec, sectionHead("ab-job", "Job"), ta,
      h("div", { class: "ab-row-acts" }, save, h("button", { type: "button", class: "btn btn-ghost", onclick: view }, "Cancel"), status));
    ta.focus();
  };
  view();
}

function drawTalk(sec, a, ctx) {
  const input = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "ab-talk-in", placeholder: `Ask ${a.name} something, or give it a task`, autocomplete: "off" }));
  const status = h("div", { class: "small muted ab-talk-status", role: "status" });
  const send = h("button", { type: "submit", class: "ibtn ab-send", "aria-label": `Send to ${a.name}` }, icon("send"));
  const submit = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    /** @type {HTMLButtonElement} */ (send).disabled = true;
    put(status, "Sending…");
    const r = await attempt("agents.ask", { agent: a.name, text });
    if (!ctx.alive()) return;
    /** @type {HTMLButtonElement} */ (send).disabled = false;
    if (r.error) { put(status, `Not sent. ${why(r.error)}`); return; }
    input.value = "";
    const t = r.data?.thread;
    put(status, `Sent to ${a.name}.`, t ? [" ", link(threadHref(t, r.data?.project), { class: "link" }, "Open the thread")] : null);
  };
  put(sec, h("label", { class: "lbl", id: "ab-talk", for: "ab-talk-in" }, `Talk to ${a.name}`),
    h("form", { class: "ab-talk-form", onsubmit: submit }, input, send), status);
}

function drawWakes(sec, a, w, ctx) {
  const note = h("p", { class: "small muted ab-note", hidden: true, id: "ab-watch-note" },
    `Ask Claude or ${a.name} for one in plain words, e.g. "wake ${a.name} when mail labelled Ads arrives". Claude writes watchers with the write-a-watcher skill, and they show up here.`);
  const add = h("button", { type: "button", class: "btn btn-ghost btn-sm ab-add", "aria-expanded": "false", "aria-controls": "ab-watch-note",
    onclick: () => { note.hidden = !note.hidden; add.setAttribute("aria-expanded", String(!note.hidden)); } }, icon("plus", 13), "Add watcher");
  const body = h("div", { class: "rows" });
  put(sec, sectionHead("ab-wakes", `What wakes ${a.name}`, add), note, body);
  attempt("watchers.list", { agent: a.name }).then(r => {
    if (!ctx.alive()) return;
    if (r.error) { put(body, empty(`${a.name} wakes only when you talk to it.`, r.error)); return; }
    const list = (Array.isArray(r.data) ? r.data : r.data?.watchers || []).filter(x => !x.agent || x.agent === a.name);
    if (!list.length) { put(body, h("div", { class: "empty" }, `Nothing wakes ${a.name} yet. It works when you talk to it.`)); return; }
    put(body, list.map(x => watcherRow(x, w)));
  });
}

function watcherRow(x, w) {
  const [ic, label] = SOURCE[x.source] || ["now", String(x.source || "Watcher").replace(/^./, c => c.toUpperCase())];
  const files = Array.isArray(x.files) ? x.files.map(s => nameOf(w.names, s)).join(", ") : x.files || (x.project ? nameOf(w.names, x.project) : "Any project");
  const row = h("div", { class: "ab-w" + (x.paused ? " off" : "") });
  const status = h("span", { class: "small muted ab-w-status", role: "status" });
  const sw = h("button", { type: "button", role: "switch", class: "sw", "aria-checked": String(!x.paused), "aria-label": `${label}: ${x.trigger}` });
  sw.addEventListener("click", async () => {
    const on_ = sw.getAttribute("aria-checked") !== "true";
    /** @type {HTMLButtonElement} */ (sw).disabled = true;
    const r = await attempt("watchers.pause", on_ ? { name: x.name, off: true } : { name: x.name });
    /** @type {HTMLButtonElement} */ (sw).disabled = false;
    if (r.error) { put(status, why(r.error)); return; }
    put(status);
    x.paused = !on_;
    sw.setAttribute("aria-checked", String(on_));
    row.classList.toggle("off", !on_);
  });
  put(row, h("span", { class: "ab-w-ic", "aria-hidden": "true" }, icon(/** @type {any} */ (ic))),
    h("span", { class: "ab-w-src small" }, label),
    h("span", { class: "ab-w-trig" }, x.trigger || x.name, status),
    h("span", { class: "ab-w-files small" }, files),
    sw);
  return row;
}

function drawModel(sec, a, stub, listErr) {
  const status = h("span", { class: "small muted", role: "status" });
  if (stub) {
    put(sec, sectionHead("ab-model", "Model"), empty(`${a.name}'s model is kept by the switchboard.`, listErr));
    return;
  }
  const models = MODELS.some(m => m.id === a.model) || !a.model ? MODELS : [...MODELS, { id: a.model, name: a.model }];
  const shown = h("span", { class: "ab-model-show" });
  const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "ab-model-sel", "aria-label": `${a.name}'s model` },
    models.map(m => h("option", { value: m.id, selected: m.id === a.model }, m.name))));
  const drawShown = () => {
    const m = models.find(x => x.id === sel.value) || models[0];
    put(shown, h("span", null, m.name), m.name !== m.id ? h("span", { class: "code faint" }, m.id) : null, icon("chevron", 14));
  };
  if (!a.model) sel.value = MODELS[1].id;
  drawShown();
  const seg = h("div", { class: "seg ab-effort", role: "group", "aria-label": "Effort" });
  const drawSeg = () => put(seg, EFFORT.map(([v, l]) => h("button", { type: "button", "aria-pressed": String((a.effort || "medium") === v),
    onclick: () => { a.effort = v; drawSeg(); save(); } }, l)));
  const save = async () => {
    put(status, "Saving…");
    const r = await attempt("agents.update", { agent: a.name, model: sel.value, effort: a.effort || "medium" });
    put(status, r.error ? why(r.error) : "Saved.");
    if (!r.error) a.model = sel.value;
  };
  sel.addEventListener("change", () => { drawShown(); save(); });
  drawSeg();
  put(sec, sectionHead("ab-model", "Model"),
    h("div", { class: "ab-model" }, h("div", { class: "ab-model-pick" }, shown, sel),
      h("div", { class: "ab-effort-wrap" }, h("span", { class: "small faint" }, "Effort"), seg), status),
    h("p", { class: "ab-note small faint" }, `Memory is checked before every call. When it has the answer, ${a.name} uses it and no model runs.`));
}

// ---- computer --------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const k of kids) el.append(typeof k === "string" ? document.createTextNode(k) : k);
  return el;
}

/** A still, drawn placeholder of a desktop: a window and a terminal. Not a screenshot. */
function preview(c, name) {
  return s("svg", { viewBox: "0 0 472 295", class: "ab-pv", role: "img", "aria-label": `${name}'s screen. A still drawing, not a live picture; open Glass to watch.` },
    s("rect", { width: 472, height: 295, class: "pv-ground" }),
    s("rect", { width: 472, height: 16, class: "pv-bar" }),
    s("text", { x: 10, y: 11.5, class: "pv-t" }, c.name || name),
    s("text", { x: 462, y: 11.5, "text-anchor": "end", class: "pv-t" }, `screen ${c.screen?.index ?? "?"}`),
    s("rect", { x: 16, y: 30, width: 292, height: 248, rx: 4, class: "pv-win" }),
    s("rect", { x: 16, y: 30, width: 292, height: 18, rx: 4, class: "pv-chrome" }),
    s("rect", { x: 60, y: 34, width: 150, height: 10, rx: 3, class: "pv-field" }),
    ...[27, 36, 45].map(x => s("circle", { cx: x, cy: 39, r: 2.5, class: "pv-field" })),
    s("rect", { x: 34, y: 76, width: 200, height: 12, rx: 3, class: "pv-ink" }),
    s("rect", { x: 34, y: 96, width: 150, height: 12, rx: 3, class: "pv-ink" }),
    s("rect", { x: 34, y: 124, width: 210, height: 5, rx: 2, class: "pv-line" }),
    s("rect", { x: 34, y: 135, width: 170, height: 5, rx: 2, class: "pv-line" }),
    s("rect", { x: 34, y: 156, width: 74, height: 20, rx: 3, class: "pv-ink" }),
    s("rect", { x: 116, y: 156, width: 64, height: 20, rx: 3, class: "pv-box" }),
    ...[34, 126, 218].map((x, i) => s("rect", { x, y: 196, width: i === 2 ? 72 : 84, height: 60, rx: 3, class: "pv-box" })),
    s("rect", { x: 318, y: 30, width: 140, height: 248, rx: 4, class: "pv-term" }),
    ...[[48, 70], [66, 96], [78, 80], [98, 108], [110, 90], [130, 76]].map(([y, wd]) => s("rect", { x: 328, y, width: wd, height: 5, rx: 2, class: "pv-tline" })),
    s("rect", { x: 328, y: 142, width: 5, height: 9, class: "pv-cursor" }));
}

function spec(label, value, note) {
  return h("div", { class: "ab-spec" }, h("dt", { class: "small faint" }, label), h("dd", { class: "mono" }, value), note ? h("dd", { class: "small faint ab-spec-note" }, note) : null);
}

function drawComputer(aside, a, cr, stub, listErr, reload) {
  const status = h("div", { class: "small muted ab-comp-status", role: "status" });
  const c = cr.data;
  const right = c ? h("span", { class: "code faint" }, `${c.name}${c.host ? ` on ${c.host}` : ""}`) : null;
  if (stub) { put(aside, sectionHead("ab-comp", "Computer"), empty(`Whether ${a.name} has a computer is kept by the switchboard.`, listErr)); return; }
  if (!a.computer) {
    const give = h("button", { type: "button", class: "btn", onclick: async () => {
      /** @type {HTMLButtonElement} */ (give).disabled = true;
      const r = await attempt("agents.update", { agent: a.name, computer: true });
      /** @type {HTMLButtonElement} */ (give).disabled = false;
      if (r.error) { put(status, why(r.error)); return; }
      a.computer = true;
      await reload();
    } }, `Give ${a.name} a computer`);
    put(aside, sectionHead("ab-comp", "Computer"),
      h("p", { class: "ab-none" }, `${a.name} has no computer of its own. It works through its threads, in the projects' folders.`),
      h("p", { class: "small faint ab-note" }, "With one, it gets a desktop from the pool that you can watch in Glass, or take over."),
      h("div", { class: "ab-row-acts" }, give), status);
    return;
  }
  if (cr.error || !c) {
    put(aside, sectionHead("ab-comp", "Computer"), cr.error ? empty(`${a.name} has a computer, but it cannot be shown.`, cr.error) : h("div", { class: "empty" }, `${a.name}'s computer is not set up yet.`));
    return;
  }
  const sc = c.screen || {};
  const disk = c.disk ? `${c.disk.used_gb} of ${c.disk.total_gb} GB` : "?";
  const limits = h("button", { type: "button", class: "btn", "aria-expanded": "false", "aria-controls": "ab-limits" }, "Change limits");
  const box = h("div", { class: "ab-limits", id: "ab-limits", hidden: true });
  limits.addEventListener("click", () => {
    const open = box.hidden;
    box.hidden = !open;
    limits.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const num = (label, v, min, max) => /** @type {HTMLInputElement} */ (h("input", { class: "input", type: "number", min, max, value: v, "aria-label": label }));
    const cpu = num("Processor cores", c.cpu ?? 2, 1, 16), mem = num("Memory in GB", c.memory_gb ?? 4, 1, 64), dsk = num("Disk in GB", c.disk?.total_gb ?? 20, 5, 500);
    const save = h("button", { type: "button", class: "btn", onclick: async () => {
      const input = { agent: a.name, cpu: Number(cpu.value), memory_gb: Number(mem.value), disk_gb: Number(dsk.value) };
      const r = await attempt("computers.limits", input);
      if (r.error) { put(status, why(r.error)); return; }
      c.cpu = input.cpu; c.memory_gb = input.memory_gb; c.disk = { ...(c.disk || {}), total_gb: input.disk_gb };
      drawComputer(aside, a, cr, stub, listErr, reload);
    } }, "Save limits");
    put(box, h("div", { class: "ab-limits-grid" },
      h("label", { class: "small faint" }, "Cores", cpu), h("label", { class: "small faint" }, "Memory GB", mem), h("label", { class: "small faint" }, "Disk GB", dsk)),
      h("div", { class: "ab-row-acts" }, save, h("span", { class: "small faint" }, "Applies after a restart.")));
  });
  let armed = false;
  const restart = h("button", { type: "button", class: "btn btn-ghost", onclick: async () => {
    if (!armed) { armed = true; put(restart, "Restart now"); put(status, `This closes what is open on ${a.name}'s screen. Its threads keep going.`); return; }
    /** @type {HTMLButtonElement} */ (restart).disabled = true;
    const r = await attempt("computers.restart", { agent: a.name });
    /** @type {HTMLButtonElement} */ (restart).disabled = false;
    armed = false;
    put(restart, "Restart computer");
    put(status, r.error ? why(r.error) : `Restarting ${c.name}.`);
  } }, "Restart computer");

  put(aside, sectionHead("ab-comp", "Computer", right),
    link(glassHref(a.name), { class: "ab-screen", "aria-label": `Open ${a.name}'s screen in Glass` }, preview(c, a.name)),
    h("div", { class: "ab-live small" },
      h("span", { class: "ab-live-t" }, h("span", { class: "ag-dot on", "aria-hidden": "true" }),
        c.state && c.state !== "live" ? `${c.state[0].toUpperCase()}${c.state.slice(1)}.` : `Live. Screen ${sc.index ?? "?"} of ${sc.pool ?? "?"} from the pool.`),
      link(glassHref(a.name), { class: "link", style: { color: "var(--text-2)" } }, "Take the wheel in Glass")),
    h("dl", { class: "ab-specs" },
      spec("Processor", `${c.cpu ?? "?"} core${c.cpu === 1 ? "" : "s"}`),
      spec("Memory", `${c.memory_gb ?? "?"} GB`),
      spec("Disk", disk),
      spec("Screen", sc.w ? `${sc.w} × ${sc.h}` : "?", sc.idle_return_min ? `Returns to the pool after ${sc.idle_return_min} min idle` : null),
      spec("Network", c.network || "?"),
      spec("Rules", c.rules ? `${c.rules.count} apply to ${a.name}` : "None", c.rules?.example ? `Including: ${c.rules.example}` : null)),
    h("div", { class: "ab-row-acts ab-comp-acts" }, limits, restart), box, status);
}
