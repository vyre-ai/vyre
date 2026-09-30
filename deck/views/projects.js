// @ts-check
// Projects: every project, and one project's board. Board: DeckProject (with Chat for how a
// thread reads).
//
//   /projects                     every project (projects.list), with pins and New project
//   /projects/:slug               the board: threads + brief on the left, the thread in the
//   /projects/:slug/:thread       centre, the files it touched on the right. ?tab= brief|files|memory
//   /threads/:thread              the same thread for a session in no project, with "Add to a project"
//
// A thread is either a recorded session (recall.thread, read from its transcript) or a live
// switchboard thread (threads.get, then thread.* and ask.raised events). Everything a thread says
// is untrusted and goes in through h() as text only.
//
// On the box, the paired Mac's rows come in too (js/machine.js): its projects in the list, a Mac
// session picked into a box project in the board, a Mac thread at /threads/:thread. Each carries
// a machine chip and is read only: a Mac project has no board here, and a Mac thread opens from
// recall.thread with no reply, keyboard or Take. Picking a Mac session into a box project is fine.

import { h, put, link, go, head, empty } from "../js/dom.js";
import { attempt, queue, queued } from "../js/api.js";
import { icon } from "../js/icons.js";
import { projectAvatar, draftAvatar, setProjects, personAvatar, threadAvatar, readTeammates, readProjects } from "../js/avatars.js";
import { labelFor, readNames } from "../chat/lib/names.js";
import * as needs from "../js/needs.js";
import { when, clock, since, base, initial, plural } from "../js/fmt.js";
import { isMac, machineChip, readOnlyNote } from "../js/machine.js";
import { elsewhere } from "../js/need-rows.js";
import { createProject, createProjectInline, startThread, startThreadInline, indexHistoryInline } from "../js/empty-actions.js";
import { openGithubRepoPicker } from "../js/github-repo-picker.js";
import { showToast } from "../js/toast.js";

const enc = encodeURIComponent;
const TABS = [["threads", "Threads"], ["brief", "Brief"], ["files", "Files"], ["memory", "Memory"]];

/** @param {any} ctx */
export default async function projects(ctx) {
  if (ctx.params.slug) return board(ctx);
  if (ctx.params.thread) return loose(ctx);
  return list(ctx);
}

// ---- pins (a per-viewer convenience) -----------------------------------------------------

function pins() {
  try { const v = JSON.parse(localStorage.getItem("vyre.pins") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function setPin(slug, on) {
  const next = pins().filter(s => s !== slug);
  if (on) next.push(slug);
  try { localStorage.setItem("vyre.pins", JSON.stringify(next)); } catch {}
  window.dispatchEvent(new Event("deck:pins"));
}

const peopleText = people => (people || []).map(p => p.name || p.email).filter(Boolean);

// ---- /projects ---------------------------------------------------------------------------

async function list(ctx) {
  const rows = h("div", { class: "rows pl-rows" });
  const count_ = h("p", { class: "muted" }, " ");
  const form = h("div", { class: "pl-form", hidden: true });
  const newBtn = h("button", { type: "button", class: "btn btn-primary", "aria-expanded": "false", onclick: () => toggle(true) }, icon("plus", 14), "New project");
  const ghBtn = h("button", { type: "button", class: "btn", onclick: () => fromGithub() }, icon("branch", 14), "From a GitHub repo");
  put(ctx.root, h("div", { class: "pl" },
    h("div", { class: "pl-head" },
      h("div", { class: "pl-title" }, h("h1", { class: "h2" }, "Projects"), count_),
      h("div", { class: "pl-head-actions" }, ghBtn, newBtn)),
    form, rows));

  /** "New project" > "From a GitHub repo": pick, then github.project makes the project (clones
   * fresh, never touches an existing folder) and this navigates straight to it. */
  function fromGithub() {
    openGithubRepoPicker({
      title: "New project from a GitHub repo",
      onPick: async (repo, account) => {
        const r = await attempt("github.project", { repo: repo.full_name, account });
        if (r.error) { showToast({ text: `Could not create the project from ${repo.full_name}: ${r.error.message || r.error.code}` }); return; }
        if (r.data?.project) go(`/projects/${enc(r.data.project)}`);
      },
    });
  }

  const toggle = open => {
    form.hidden = !open;
    newBtn.setAttribute("aria-expanded", String(open));
    newBtn.hidden = open;
    if (open) { drawForm(); /** @type {HTMLElement} */ (form.querySelector("input"))?.focus(); }
  };

  const drawForm = () => {
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "np-name", required: true, autocomplete: "off", placeholder: "Your project's name" }));
    const home = /** @type {HTMLInputElement} */ (h("input", { class: "input mono-in", id: "np-home", autocomplete: "off", placeholder: "Leave empty for a new folder" }));
    const people = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "np-people", autocomplete: "off", placeholder: "Names or email addresses, separated by commas" }));
    const status = h("div", { class: "small muted", role: "status" });
    const submit = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary" }, "Create project"));
    const el = h("form", { class: "pl-form-in", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      if (!name.value.trim()) { put(status, "A project needs a name."); name.focus(); return; }
      submit.disabled = true;
      put(status, "Making the project…");
      const input = { name: name.value.trim() };
      if (home.value.trim()) input.home = home.value.trim();
      const ppl = parsePeople(people.value);
      if (ppl.length) input.people = ppl;
      const r = await createProject(input);
      submit.disabled = false;
      if (r.error) { put(status, r.error); return; }
      const slug = r.slug;
      if (slug) go(`/projects/${enc(slug)}`);
      else { toggle(false); draw(); }
    } },
      h("div", { class: "pl-fields" },
        h("label", { class: "pl-field" }, h("span", { class: "lbl" }, "Name"), name),
        h("label", { class: "pl-field" }, h("span", { class: "lbl" }, "Home folder"), home),
        h("label", { class: "pl-field wide" }, h("span", { class: "lbl" }, "People"), people)),
      h("div", { class: "pl-form-actions" }, submit,
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => { toggle(false); newBtn.focus(); } }, "Cancel"), status));
    put(form, el);
  };

  const draw = async () => {
    const r = await attempt("projects.list");
    if (!ctx.alive()) return;
    if (r.error) { put(count_, ""); put(rows, empty("Projects are not available.", r.error)); return; }
    const all = [...(r.data?.projects || [])].sort((a, b) => (b.last || 0) - (a.last || 0));
    setProjects(all); // each project's tile seed (js/avatars.js)
    const pinned = new Set(pins());
    put(count_, all.length ? `${plural(all.length, "project")}, most recent first.` : "No projects yet.");
    put(rows,
      all.length ? all.map(p => projectRow(p, pinned.has(p.slug), draw))
        : h("div", { class: "empty" }, "Name one and Vyre makes its folder. Or run vyre new in a folder you already have.", createProjectInline()),
      (r.data?.problems || []).map(pr => h("div", { class: "pl-problem small muted" }, typeof pr === "string" ? pr : (pr.message || pr.path || JSON.stringify(pr)))));
  };
  draw();
  ctx.on("project.*", draw);
}

/** "Dana Reyes <dana@x.com>, Theo Grant" → [{name, email}, {name}] */
function parsePeople(s) {
  return String(s || "").split(",").map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(x);
    if (m) return m[1] ? { name: m[1], email: m[2] } : { email: m[2] };
    return /@/.test(x) ? { email: x } : { name: x };
  });
}

function projectRow(p, pinned, redraw) {
  if (isMac(p)) return macProjectRow(p);
  const pin = h("button", { type: "button", class: "ibtn pl-pin", "aria-pressed": String(pinned), "aria-label": `${pinned ? "Unpin" : "Pin"} ${p.name}`,
    title: pinned ? "Pinned to the rail" : "Pin to the rail", onclick: () => { setPin(p.slug, !pinned); redraw(); } }, icon("pin"));
  const ppl = peopleText(p.people);
  return h("div", { class: "pl-row" },
    pin,
    projectAvatar(p.slug, { size: 32, cls: "pl-av" }),
    h("div", { class: "pl-main" },
      h("div", { class: "pl-name" }, link(`/projects/${enc(p.slug)}`, { class: "link quiet pl-open" }, p.name), p.org ? h("span", { class: "tag" }, p.org) : null),
      h("div", { class: "small muted ellipsis" }, ppl.length ? ppl.join(", ") : h("span", { class: "faint" }, "No people yet"))),
    h("div", { class: "code pl-count" }, plural(p.threads || 0, "thread")),
    h("div", { class: "code faint pl-last" }, p.last ? when(p.last) : "never"),
    h("span", { class: "pl-chev", "aria-hidden": "true" }, icon("right")));
}

/** A paired Mac's project: listed with its machine, no board, no pin. */
function macProjectRow(p) {
  return h("div", { class: "pl-row" },
    h("span", { class: "ibtn pl-pin", "aria-hidden": "true" }),
    projectAvatar(p.slug, { size: 32, cls: "pl-av" }),
    h("div", { class: "pl-main" },
      h("div", { class: "pl-name" }, h("span", null, p.name), machineChip(p)),
      h("div", { class: "readonly-note ellipsis" }, readOnlyNote(p))),
    h("div", { class: "code pl-count" }, plural(p.threads || 0, "thread")),
    h("div", { class: "code faint pl-last" }, p.last ? when(p.last) : "never"),
    h("span", { class: "pl-chev", "aria-hidden": "true" }));
}

// ---- the board: /projects/:slug(/:thread) -----------------------------------------------

async function board(ctx) {
  const slug = ctx.params.slug;
  const tab = TABS.some(t => t[0] === ctx.query.get("tab")) ? ctx.query.get("tab") : "threads";
  const [pl, pt, sw, cx] = await Promise.all([
    // The Switchboard's threads on this machine only: a Mac's threads name the Mac's own projects.
    attempt("projects.list"), attempt("projects.threads", { project: slug }), attempt("threads.list", { project: slug, machines: "local" }), attempt("projects.context", { project: slug })]);
  if (!ctx.alive()) return;
  const p = (pl.data?.projects || []).find(x => x.slug === slug && !isMac(x));
  if (!p) {
    put(ctx.root, h("div", { class: "pl" }, link("/projects", { class: "pj-back small" }, icon("right", 14), "Projects"),
      pl.error ? empty("Projects are not available.", pl.error) : h("div", { class: "empty" }, `There is no project called ${slug}.`)));
    return;
  }
  const live = (sw.data || []).filter(t => (t.project || null) === slug && (t.state === "running" || t.state === "waiting"));
  const liveIds = new Set(live.map(t => t.id));
  const recorded = (pt.data || []).filter(t => !liveIds.has(t.id));
  const agents = [...new Set(live.map(t => t.agent).filter(Boolean))];
  const items = [
    ...live.sort((a, b) => (b.last || 0) - (a.last || 0)).map(t => ({ id: t.id, name: t.name || t.id, at: t.last || t.started, live: t })),
    ...recorded.map(t => ({ id: t.id, name: t.label || t.name || t.title || t.id, at: t.last, rec: t })),
  ];
  const chosen = ctx.params.thread || null;
  const selected = chosen || items[0]?.id || null;
  const hrefFor = id => `/projects/${enc(slug)}/${enc(id)}`;
  const tabHref = t => (chosen ? hrefFor(chosen) : `/projects/${enc(slug)}`) + (t === "threads" ? "" : `?tab=${t}`);

  const ppl = peopleText(p.people);
  const header = h("div", { class: "pj-head" },
    h("div", { class: "pj-id" },
      link("/projects", { class: "pj-back pj-phone", "aria-label": "All projects" }, icon("right", 14), "Projects"),
      h("h1", { class: "pj-name" }, p.name),
      p.org ? h("span", { class: "lbl pj-org" }, p.org) : null,
      ppl.length ? h("span", { class: "pj-people small muted" }, ppl.join(", ")) : null),
    h("nav", { class: "pj-tabs", "aria-label": "Project" }, TABS.map(([k, label]) => link(tabHref(k), { "aria-current": k === tab ? "page" : false }, label))),
    h("div", { class: "pj-grow" }),
    agents.length ? h("span", { class: "pj-agents small faint" }, agents.map(a => h("span", { class: "initial sm", "aria-hidden": "true" }, initial(a))), agents.join(", ")) : null,
    newThreadButton(ctx, p, sw.error));

  const root = h("div", { class: "pj" + (chosen ? " has-thread" : "") + " tab-" + tab });
  put(ctx.root, root);

  if (tab === "brief") { put(root, header, briefTab(ctx, p, cx, sw.error)); return; }
  if (tab === "files") { put(root, header, filesTab(ctx, p, items)); return; }
  if (tab === "memory") { put(root, header, memoryTab(ctx, p)); return; }

  const threadList = h("div", { class: "pj-threads" });
  const drawList = () => put(threadList,
    h("div", { class: "lbl pj-threads-l" }, "Threads"),
    items.length ? items.map(it => threadItem(it, it.id === selected, hrefFor(it.id), needs.current()))
      : sw.error?.missing ? h("div", { class: "empty pj-none" }, "No threads yet. The switchboard module is not running, so one cannot start here.")
      : h("div", { class: "empty pj-none" }, "No threads yet.", startThreadInline(p)),
    sw.error && !sw.error.missing ? h("div", { class: "code pj-none" }, String(sw.error.message)) : null);
  drawList();
  ctx.cleanup(needs.watch(drawList));
  const brief = h("section", { class: "pj-brief", "aria-labelledby": "brief-h" },
    h("div", { class: "pj-brief-top" }, h("h2", { id: "brief-h", class: "lbl" }, "Brief"), link(tabHref("brief"), { class: "link small muted" }, "Read all")),
    cx.error ? empty("", cx.error) : shortBrief(cx.data?.text).map(l => h("p", { class: l.mono ? "pj-brief-mono" : "pj-brief-p" }, l.text)));

  const centre = h("section", { class: "pj-centre", "aria-label": "Thread" });
  const files = h("aside", { class: "pj-files", "aria-label": "Files this thread touched" });
  put(root, header, h("div", { class: "pj-body" },
    h("aside", { class: "pj-left", "aria-label": "Threads and brief" }, threadList, h("div", { class: "pj-grow" }), brief),
    centre, files));

  if (!selected) {
    put(centre, h("div", { class: "th-empty" }, h("div", { class: "empty" }, "The thread you start shows here.")));
    put(files, h("div", { class: "pj-files-head" }, h("h2", { class: "lbl" }, "Files")), h("div", { class: "pj-files-pad empty" }, "The files a thread touches show here."));
    return;
  }
  const it = items.find(x => x.id === selected);
  await threadPane(ctx, selected, { centre, files, known: it, project: p, switchboard: sw, back: `/projects/${enc(slug)}` });

  // Keep the list's states fresh when a thread starts, finishes or raises a question.
  ctx.on("thread.started", e => { if (e.project === slug) go(location.pathname + location.search); });
}

/** The brief's lines without the preamble that is addressed to the model. */
function briefLines(text) {
  return String(text || "").split("\n").map(s => s.trim()).filter(Boolean)
    .filter(s => !/^You are working in the Vyre project/.test(s) && !/^This brief is background from Vyre/.test(s))
    .map(s => ({ text: s.replace(/^- /, ""), mono: /^(Repo|Drive|Home|Folder)s?:/i.test(s) }));
}

/** The start of the brief for the left column: the lines that are not the thread list above it. */
function shortBrief(text) {
  const out = [];
  let skipping = false;
  for (const l of briefLines(text)) {
    if (/^Other threads in this project/.test(l.text)) { skipping = true; continue; }
    if (/^From this project's memory/.test(l.text)) { skipping = false; continue; }
    if (!skipping) out.push(l);
  }
  return out.slice(0, 4);
}

function threadItem(it, on, href, open) {
  const t = it.live;
  const held = t && (t.state === "waiting") && open.some(n => n.thread === t.id);
  const who = t ? (t.agent || "you") : (it.rec?.agents ? "you with an agent" : "you");
  const state = t ? (held ? null : t.state) : plural(it.rec?.turns || 0, "turn");
  return link(href, { class: "pj-t", "aria-current": on ? "true" : false },
    h("span", { class: "pj-t-row" }, h("span", { class: "pj-t-name ellipsis" }, it.name), machineChip(it.rec), h("span", { class: "code faint pj-t-at" }, when(it.at))),
    h("span", { class: "pj-t-row pj-t-sub" }, h("span", { class: "ellipsis" }, who, state ? ` · ${state}` : ""),
      held ? h("span", { class: "pj-held" }, h("span", { class: "dot beacon", "aria-hidden": "true" }), "held") : null));
}

function newThreadButton(ctx, p, swErr) {
  const wrap = h("div", { class: "nt" });
  const btn = h("button", { type: "button", class: "btn", "aria-label": "New thread", "aria-expanded": "false", "aria-haspopup": "dialog", onclick: () => toggle(pop.hidden) }, icon("plus", 14), h("span", { class: "nt-label" }, "New thread"));
  const pop = h("form", { class: "nt-pop", hidden: true, role: "dialog", "aria-label": "New thread" });
  const toggle = openIt => {
    pop.hidden = !openIt;
    btn.setAttribute("aria-expanded", String(openIt));
    if (openIt) draw();
  };
  const draw = () => {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", rows: "3", "aria-label": "What should the new thread do?", placeholder: "What should it do? You can leave this empty." }));
    const status = h("div", { class: "small muted", role: "status" });
    const go_ = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm" }, "Start"));
    pop.onsubmit = async e => {
      e.preventDefault();
      go_.disabled = true;
      put(status, "Starting…");
      const r = await startThread(p, ta.value.trim());
      go_.disabled = false;
      if (r.error) { put(status, r.error); return; }
      toggle(false);
      if (r.id) go(`/projects/${enc(p.slug)}/${enc(r.id)}`);
    };
    put(pop,
      h("div", { class: "code faint ellipsis" }, "In ", base(p.home)),
      ta,
      h("div", { class: "nt-actions" }, go_, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => toggle(false) }, "Cancel")),
      swErr?.missing ? h("div", { class: "small faint" }, "The switchboard module is not running, so this will not start yet.") : null,
      status);
    ta.focus();
  };
  pop.addEventListener("keydown", e => { if (/** @type {KeyboardEvent} */ (e).key === "Escape") { toggle(false); btn.focus(); } });
  return put(wrap, btn, pop);
}

// ---- tabs ---------------------------------------------------------------------------------

function briefTab(ctx, p, cx, swErr) {
  const lines = briefLines(cx.data?.text);
  const repos = h("div", { class: "pj-repos" });
  const page = h("div", { class: "pj-page" },
    head("Brief", h("span", { class: "code faint" }, "Built from this project's threads")),
    cx.error ? empty("The brief is not available.", cx.error)
      : lines.length ? h("div", { class: "pj-brief-full" }, lines.map(l => h("p", { class: /^(People|Other threads|From this project)/.test(l.text) ? "pj-brief-h" : "" }, l.text)))
        : h("div", { class: "empty" }, "Nothing in the brief yet. It fills in as threads run.", swErr?.missing ? null : startThreadInline(p)),
    h("div", { class: "pj-facts code" },
      h("div", null, h("span", { class: "faint" }, "Home  "), p.home || ""),
      (p.workspaces || []).filter(w => w !== p.home).map(w => h("div", null, h("span", { class: "faint" }, "Also  "), w))),
    repos);
  drawRepos(ctx, p, repos);
  return page;
}

/**
 * A project's Repos section (github's final contract, ADR 0041): github.project.detect per
 * workspace folder, and "Add a repo" (github.project.add-repo), which only ever adds a NEW
 * workspace folder, never touching an existing one. There is no "link" - the user's call, relayed
 * by the lead - so a folder that already has a matching GitHub remote just says so; nothing to
 * confirm, nothing to tap.
 */
function drawRepos(ctx, p, el) {
  put(el, h("div", { class: "lbl" }, "Looking for repos…"));
  const load = async () => {
    const r = await attempt("github.project.detect", { project: p.slug });
    if (!ctx.alive()) return;
    if (r.error) { put(el, r.error.missing ? null : h("div", { class: "small muted" }, "GitHub repos are not available here.")); return; }
    const rows = Array.isArray(r.data?.workspaces) ? r.data.workspaces : [];
    const add = h("button", { type: "button", class: "btn btn-sm", onclick: () => openGithubRepoPicker({
      title: `Add a repo to ${p.name}`,
      onPick: async (repo, account) => {
        const r2 = await attempt("github.project.add-repo", { project: p.slug, repo: repo.full_name, account });
        if (r2.error) { showToast({ text: `Could not add ${repo.full_name}: ${r2.error.message || r2.error.code}` }); return; }
        showToast({ text: `Added ${repo.full_name}` });
        go(location.pathname + location.search); // a new workspace folder: refresh the whole board
      },
    }) }, icon("plus", 12), "Add a repo");
    put(el, h("div", { class: "lbl" }, "Repos"),
      rows.length ? h("div", { class: "rows" }, rows.map(w => repoRow(w))) : h("div", { class: "small muted" }, "No folders yet."),
      h("div", { class: "pj-repos-add" }, add));
  };
  load();
  ctx.on("github.token-invalid", load);
}

function repoRow(w) {
  const folder = base(w.folder);
  const matched = (w.remotes || []).find(r => r.match);
  const named = (w.remotes || []).find(r => r.full_name);
  const status = matched
    ? h("a", { class: "link small", href: `https://github.com/${matched.full_name}`, target: "_blank", rel: "noopener noreferrer" }, `Connected to ${matched.full_name}`)
    : named
      ? h("span", { class: "small muted" }, `${named.full_name}, but the connected account can't reach it right now`)
      : w.isRepo ? h("span", { class: "small muted" }, "Git repo, not GitHub") : h("span", { class: "small faint" }, "Not a git repo");
  return h("div", { class: "pj-repo-row code" }, h("span", { class: "faint" }, folder + "  "), status);
}

function filesTab(ctx, p, items) {
  const box = h("div", { class: "rows" }, h("div", { class: "empty" }, "Looking…"));
  const page = h("div", { class: "pj-page" }, head("Files", h("span", { class: "code faint" }, "Touched by this project's threads")), box, noContents());
  (async () => {
    const ids = items.slice(0, 12);
    const rs = await Promise.all(ids.map(it => attempt("harness.touched", { session: it.id, limit: 50 })));
    if (!ctx.alive()) return;
    const err = rs.find(r => r.error)?.error;
    const all = rs.flatMap((r, i) => (r.data || []).map(f => ({ ...f, thread: ids[i] }))).sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!all.length) { put(box, err ? empty("Files are not available.", err) : h("div", { class: "empty" }, "No thread in this project has changed a file yet.")); return; }
    put(box, all.map(f => fileRow(f, link(`/projects/${enc(p.slug)}/${enc(f.thread.id)}`, { class: "link quiet small muted ellipsis pj-file-th" }, f.thread.name))));
  })();
  return page;
}

function memoryTab(ctx, p) {
  const box = h("div", { class: "rows" }, h("div", { class: "empty" }, "Looking…"));
  const page = h("div", { class: "pj-page" },
    head("Memory", link("/memory", { class: "lbl", style: { textDecoration: "none", color: "var(--text-2)" } }, "Open Memory →"), "recall"), box);
  (async () => {
    const cwds = [p.home, ...(p.workspaces || [])].filter(Boolean);
    const r = await attempt("memory.facts", { project_cwds: [...new Set(cwds)], limit: 100 });
    if (!ctx.alive()) return;
    if (r.error) { put(box, empty("Memory is not available.", r.error)); return; }
    const facts = r.data?.facts || [];
    if (!facts.length) { put(box, h("div", { class: "empty" }, "Nothing learned from this project's threads yet. Memory learns from threads once they are indexed.", indexHistoryInline())); return; }
    put(box, facts.map(f => h("div", { class: "pj-fact" },
      h("span", { class: "dot recall", "aria-hidden": "true" }),
      h("span", { class: "pj-fact-text" }, f.text),
      h("span", { class: "small faint ellipsis" }, "from ",
        f.ref?.session ? link(`/projects/${enc(p.slug)}/${enc(f.ref.session)}`, { class: "link", style: { color: "var(--text-2)" } }, f.ref.name || f.source || "a thread") : (f.source || "a thread")))));
  })();
  return page;
}

const noContents = () => h("p", { class: "small faint pj-nocontents" }, "File contents are not available from the Deck yet. Open the file on the machine that ran the thread.");

function fileRow(f, extra) {
  const path = String(f.path || "");
  const i = path.lastIndexOf("/");
  return h("div", { class: "fl-row" },
    h("span", { class: "fl-ic", "aria-hidden": "true" }, icon("file", 14)),
    h("span", { class: "fl-path code ellipsis", title: path }, i >= 0 ? h("span", { class: "faint" }, shortDir(path.slice(0, i + 1))) : null, h("span", { class: "fl-base" }, path.slice(i + 1))),
    extra || null,
    f.tool ? h("span", { class: "tag" }, f.tool) : null,
    h("span", { class: "code faint fl-at" }, f.at ? when(f.at) : ""));
}
/** The last two folders of a path, so long absolute paths stay readable. */
function shortDir(d) {
  const parts = d.split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : d.startsWith("/") ? "/" : "") + parts.slice(-2).join("/") + (parts.length ? "/" : "");
}

// ---- /threads/:thread --------------------------------------------------------------------

async function loose(ctx) {
  const id = ctx.params.thread;
  const [sw, cx, pl, rt] = await Promise.all([attempt("threads.list", {}), attempt("projects.context", { session: id }), attempt("projects.list"),
    attempt("recall.thread", { session: id, limit: 1 })]);
  const known = (sw.data || []).find(t => t.id === id);
  // A Mac thread (the box read it from the Mac): its project and folder are the Mac's, so only a
  // pick into one of this machine's projects (projects.context) says where it is here.
  const mac = isMac(known) || isMac(rt.data);
  const cwd = mac ? null : known?.cwd || rt.data?.session?.cwd;
  const of = !mac && !known?.project && !cx.data?.project && cwd ? await attempt("projects.of", { cwd }) : null;
  if (!ctx.alive()) return;
  const inProject = (mac ? null : known?.project) || cx.data?.project || of?.data?.slug || null;
  // Picking goes into this machine's projects only.
  const projectsAll = (pl.data?.projects || []).filter(x => !isMac(x));
  const owner = projectsAll.find(x => x.slug === inProject);

  const add = h("div", { class: "lt-add" });
  const drawAdd = () => {
    if (owner) { put(add, h("span", { class: "small muted" }, "In ", link(`/projects/${enc(owner.slug)}/${enc(id)}`, { class: "link" }, owner.name))); return; }
    if (inProject) { put(add, h("span", { class: "small muted" }, "In ", inProject)); return; }
    if (pl.error) { put(add, h("span", { class: "small faint" }, "Projects are not available.")); return; }
    // Made into a new project, this chat's draft tile carries over and turns solid (projects.create
    // from_thread keeps its seed); filed into an existing one, it takes that project's tile.
    const make = h("button", { type: "button", class: "btn btn-sm", onclick: () => newProject() }, icon("plus", 14), "New project from this");
    // Still offered with zero existing projects: form() falls back to "New project from a
    // GitHub repo…" alone when there's nothing to pick from the select.
    const btn = h("button", { type: "button", class: "btn btn-sm", "aria-expanded": "false", onclick: () => form() }, "Add to a project");
    put(add, draftAvatar(id, { size: 24, title: "Not in a project yet" }), h("span", { class: "small faint lt-none" }, "Not in a project."), make, btn);
  };
  const newProject = () => {
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input lt-sel", "aria-label": "Project name", placeholder: "Project name" }));
    const status = h("span", { class: "small muted", role: "status" });
    const ok = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm" }, "Make it"));
    put(add, h("form", { class: "lt-form", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      if (!name.value.trim()) { put(status, "Give it a name."); return; }
      ok.disabled = true;
      const r = await createProject({ name: name.value.trim(), from_thread: id });
      ok.disabled = false;
      if (r.error || !r.slug) { put(status, r.error || "The project was not made."); return; }
      go(`/projects/${enc(r.slug)}/${enc(id)}`);
    } }, name, ok, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: drawAdd }, "Cancel"), status));
    name.focus();
  };
  /** A newly-made project (from a GitHub repo) still needs the thread filed into it, same as
   * picking an existing one from the select. */
  const fileInto = async (/** @type {string} */ slug, /** @type {HTMLElement} */ status) => {
    const r = await attempt("projects.add-threads", { project: slug, threads: [id] });
    if (r.error) { put(status, r.error.missing ? `The ${r.error.module} module is not running.` : String(r.error.message)); return false; }
    window.dispatchEvent(new Event("deck:pins"));
    go(`/projects/${enc(slug)}/${enc(id)}`);
    return true;
  };
  const form = () => {
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "input lt-sel", "aria-label": "Project" }, projectsAll.map(x => h("option", { value: x.slug }, x.name))));
    const status = h("span", { class: "small muted", role: "status" });
    const ok = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm" }, "Add"));
    const ghBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => openGithubRepoPicker({
      title: "New project from a GitHub repo",
      onPick: async (repo, account) => {
        put(status, `Cloning ${repo.full_name}…`);
        // from_thread (github's contract, sha 9cf93817) both sets the new project's avatar_seed
        // to this chat's id and files the chat in, in the one call: the same carry-over a
        // native project-from-chat gets, and no separate projects.add-threads needed here.
        const r = await attempt("github.project", { repo: repo.full_name, account, from_thread: id });
        if (r.error) { put(status, r.error.message || "Could not create the project from that repo."); return; }
        if (r.data?.project) { window.dispatchEvent(new Event("deck:pins")); go(`/projects/${enc(r.data.project)}/${enc(id)}`); }
      },
    }) }, icon("branch", 12), "New project from a GitHub repo…");
    put(add, h("form", { class: "lt-form", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      ok.disabled = true;
      await fileInto(sel.value, status);
      ok.disabled = false;
    } }, projectsAll.length ? [sel, ok] : null, ghBtn, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: drawAdd }, "Cancel"), status));
    if (projectsAll.length) sel.focus(); else ghBtn.focus();
  };
  drawAdd();

  const centre = h("section", { class: "pj-centre", "aria-label": "Thread" });
  const files = h("aside", { class: "pj-files", "aria-label": "Files this thread touched" });
  put(ctx.root, h("div", { class: "pj has-thread lt" },
    h("div", { class: "pj-head" },
      h("div", { class: "pj-id" }, link("/now", { class: "pj-back pj-phone" }, icon("right", 14), "Now"), h("span", { class: "lbl" }, "Thread"),
        machineChip(mac ? { source: "mac", machine: known?.machine || rt.data?.machine } : null)),
      h("div", { class: "pj-grow" }), add),
    h("div", { class: "pj-body" }, centre, files)));
  await threadPane(ctx, id, { centre, files, known: known ? { live: known } : mac ? { rec: rt.data } : null, project: owner || null, switchboard: sw, back: owner ? `/projects/${enc(owner.slug)}` : "/now" });
}

// ---- one thread -----------------------------------------------------------------------------

/**
 * Load and draw a thread into centre, and the files it touched into files.
 * @param {any} ctx
 * @param {string} id
 * @param {{ centre: HTMLElement, files: HTMLElement, known: any, project: any, switchboard: any, back: string }} o
 */
async function threadPane(ctx, id, o) {
  const { centre, files } = o;
  const body = h("div", { class: "th-body", "aria-live": "polite" }, h("div", { class: "empty" }, "Opening the thread…"));
  const title = h("h2", { class: "th-title ellipsis" }, o.known?.name || o.known?.live?.name || " ");
  const meta = h("span", { class: "code faint th-meta" });
  const compose = h("div", { class: "th-compose" });
  put(centre,
    h("div", { class: "th-head" },
      link(o.back, { class: "pj-back pj-phone", "aria-label": "Back" }, icon("right", 14), o.project ? o.project.name : "Back"),
      title, meta),
    body, compose);

  // Which kind of thread is this: live on the switchboard, or a recorded session? A Mac's is only
  // ever read from its transcript, through the box, and never offered a reply.
  let fromMac = isMac(o.known?.live) || isMac(o.known?.rec);
  const isLive = !!o.known?.live && !fromMac;
  let thread = null, events = [], recorded = null, loadErr = null;
  // Who is who for the avatars and names (each read once per page; a missing one just means a
  // fallback). chat/lib/names.js's readNames reads system.info and passes it to the avatars too.
  // The thread never waits on these: it draws at once, and whoReady() redraws the avatars and the
  // reply names in place if they land after it (reviewer's nit on 6fea1c16).
  /** @type {{ assistant?: string|null, owner?: string|null }} */ let names = {};
  let identityIn = false;
  /** @type {() => void} */ let whoReady = () => {};
  Promise.all([readNames(attempt), readTeammates(attempt), readProjects(attempt)])
    .then(([nm]) => { names = nm || {}; identityIn = true; whoReady(); }, () => {});
  if (isLive) {
    const r = await attempt("threads.get", { thread: id });
    if (r.data) ({ thread, events } = { thread: r.data.thread, events: r.data.events || [] }); else loadErr = r.error;
  }
  if (!thread) {
    const r = await attempt("recall.thread", { session: id, limit: 400, ...(fromMac ? { source: "mac" } : {}) });
    if (r.data) { recorded = r.data; fromMac = fromMac || isMac(r.data); }
    else if (fromMac) loadErr = r.error;
    else {
      const g = await attempt("threads.get", { thread: id });
      if (g.data?.thread) ({ thread, events } = { thread: g.data.thread, events: g.data.events || [] }); else loadErr = loadErr || r.error;
    }
  }
  if (!ctx.alive()) return;

  const swMissing = !!(o.switchboard?.error?.missing);
  const agent = thread?.agent || o.known?.live?.agent || null;
  // ADR 0043 section 6: the person's own avatar on their messages; a reply wears the thread's
  // (the project's tile in a project, a draft tile in none, an agent's blob, a teammate's character).
  const project = o.project?.slug || thread?.project || null;
  const youAv = (/** @type {string} */ who) => personAvatar({ size: 24, cls: "th-av", title: who });
  const replyAv = (/** @type {string} */ who) => threadAvatar({ agent, project, thread: id }, { size: 24, cls: "th-av", title: who });
  const cwd = thread?.cwd || recorded?.session?.cwd || "";
  put(title, thread?.name || o.known?.name || o.known?.live?.name || recorded?.session?.name || recorded?.session?.title || (thread ? "New thread" : id));
  const machine = fromMac ? String(recorded?.machine || o.known?.live?.machine || o.known?.rec?.machine || "your Mac") : null;
  put(meta, `session ${/^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 4) : id}`, agent ? ` · ${agent}` : cwd ? ` · in ${base(cwd)}` : "", machine ? ` · on ${machine}` : "");

  if (!thread && !recorded) {
    put(body, empty("This thread could not be opened.", loadErr));
    drawFiles(ctx, files, id, []);
    drawComposer(ctx, compose, { id, agent, lease: null, swMissing: true, machine, append: () => {} });
    return;
  }

  // The stream of things said and done, in order.
  const stream = h("div", { class: "th-stream" });
  // The identity reads landed after the thread drew: the right avatars and reply names, in place.
  if (!identityIn) whoReady = () => {
    if (!ctx.alive()) return;
    for (const m of stream.querySelectorAll(".th-msg")) {
      const name = m.querySelector(".th-name");
      const user = m.classList.contains("user");
      if (!user && name) put(name, labelFor({ role: "assistant", agent }, names));
      const who = name?.textContent || "";
      m.querySelector(".th-av")?.replaceWith(user ? youAv(who) : replyAv(who));
    }
  };
  put(body, stream);
  let toolGroup = /** @type {HTMLElement|null} */ (null);
  const byMsg = new Map();
  // A live message streams as several thread.text events: partials carry only `delta` (no
  // `text`), so they are accumulated here; the final event carries the whole `text`, which
  // replaces the accumulated buffer outright rather than trusting the deltas summed to it.
  const textBuf = new Map();
  const pendingEcho = new Set();
  /** @type {any[]} */ const liveTools = [];
  // switchboard sends "started" and "done" as two separate thread.tool events sharing one id, and
  // withholds the result text by design (spec: events stay small); "done" only marks the started
  // line as failed, it never draws a second line.
  const toolLines = new Map();
  const asks = new Map();
  const scrollDown = () => { body.scrollTop = body.scrollHeight; ctx.root.scrollTop = ctx.root.scrollHeight; };

  const addTool = ev => {
    if (ev.phase === "done") { if (ev.error) toolLines.get(ev.id)?.querySelector(".tl-dot")?.classList.add("beacon"); return; }
    if (isRecall(ev.tool)) { toolGroup = null; stream.append(recalledBlock(ev, o.project)); return; }
    if (!toolGroup) { toolGroup = h("div", { class: "th-tools" }); stream.append(toolGroup); }
    const el = toolLine(ev);
    if (ev.id) toolLines.set(ev.id, el);
    toolGroup.append(el);
  };
  const addEvent = (ev, live) => {
    const type = ev.type;
    if (type === "thread.tool") { addTool(ev); }
    else if (type === "thread.text") {
      toolGroup = null;
      if (ev.recalled) { stream.append(recalledBlock({ result: ev.recalled.text || ev.text, from: ev.recalled.from, session: ev.recalled.session }, o.project)); return; }
      const key = ev.message || ev.msg || null;
      const text = typeof ev.text === "string" ? ev.text
        : key && typeof ev.delta === "string" ? textBuf.set(key, (textBuf.get(key) || "") + ev.delta).get(key)
        : ev.text || "";
      if (live && key && byMsg.has(key)) { put(byMsg.get(key), text); return; }
      if (live && ev.role === "user" && pendingEcho.has(ev.text)) { pendingEcho.delete(ev.text); return; }
      // A reply is named the way chat names it (chat/lib/names.js): the agent's name, else the assistant's, never "Claude".
      const who = ev.role === "user" ? "You" : labelFor({ role: "assistant", agent }, names);
      const m = message(ev.role === "user" ? "user" : "assistant", who, ev.at, text, ev.role === "user" ? youAv(who) : replyAv(who));
      if (key) byMsg.set(key, /** @type {HTMLElement} */ (m.querySelector(".th-text")));
      stream.append(m);
    } else if (type === "thread.sent") {
      // Another surface's own keystrokes: this surface already echoed its own (o.append, below).
      if (ev.surface === "deck") return;
      toolGroup = null;
      stream.append(message("user", ev.surface || "Another surface", ev.at, ev.text || "", youAv(ev.surface || "Another surface")));
    } else if (type === "ask.raised") {
      toolGroup = null;
      const a = normAsk(ev.ask || ev, ev.at);
      if (!a.id || asks.has(a.id)) return;
      const el = heldBlock(a, id);
      asks.set(a.id, el);
      stream.append(el);
    } else if (type === "ask.answered") {
      const aid = ev.ask?.id || ev.ask || ev.id;
      const el = asks.get(aid);
      if (el) settle(el, ev.decision || "answered");
    } else if (type === "thread.finished") {
      toolGroup = null;
      stream.append(h("div", { class: "th-finished code faint" }, `Finished${ev.at ? " · " + clock(ev.at) : ""}`, ev.text ? `  ·  ${ev.text}` : ""));
    }
  };

  if (recorded) {
    const turns = recorded.turns || [];
    if (!turns.length) stream.append(h("div", { class: "empty" }, "Nothing was said in this thread."));
    for (const t of turns) addEvent({ type: "thread.text", role: t.role, at: t.ts, text: t.text }, false);
  } else {
    if (!events.length) stream.append(h("div", { class: "empty th-wait" }, thread?.state === "running" ? "Starting. What the thread says shows here as it runs." : "Nothing in this thread yet."));
    for (const ev of events) addEvent(ev, false);
    // An open question the list knows about but the events did not carry.
    for (const n of needs.current()) if (n.kind === "ask" && n.thread === id && !asks.has(n.id)) addEvent({ type: "ask.raised", at: n.at, ask: { id: n.id, tool: n.command ? "Bash" : "", command: n.command, rule: n.rule, why: n.why, options: n.options, elsewhere: elsewhere(n) } }, false);
  }
  requestAnimationFrame(scrollDown);

  // Live: follow the thread as it runs.
  const mine = e => e.thread === id || e.payload?.thread === id || e.payload?.session === id;
  const fromEvent = e => ({ type: e.type, at: e.at, ...(e.payload || {}) });
  for (const t of ["thread.text", "thread.tool", "thread.finished", "thread.sent", "ask.raised", "ask.answered"]) {
    ctx.on(t, e => {
      if (!mine(e)) return;
      const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      stream.querySelector(".th-wait")?.remove();
      const ev = fromEvent(e);
      addEvent(ev, true);
      if (t === "thread.tool") { liveTools.push(ev); drawFilesFromEvents(); }
      if (stick) scrollDown();
    });
  }

  // Files
  const drawFilesFromEvents = () => drawFiles(ctx, files, id, [...events, ...liveTools]);
  drawFilesFromEvents();
  ctx.on("file.touched", e => { if (e.payload?.session === id) drawFilesFromEvents(); });

  drawComposer(ctx, compose, {
    id, agent, lease: thread?.holder || null, swMissing: swMissing && !thread, recorded: !!recorded, machine,
    append: text => {
      pendingEcho.add(text);
      toolGroup = null;
      stream.querySelector(".th-wait")?.remove();
      stream.append(message("user", "You", Date.now(), text, youAv("You")));
      scrollDown();
    },
  });
}

const isRecall = tool => /(^|__|\.)(recall|memory)[._]/i.test(String(tool || "")) || /^(recall|memory)$/i.test(String(tool || ""));

/** One message. `av`: its avatar (js/avatars.js), the person's for "you" and the thread's own
 * (the project tile, a draft tile, an agent's blob or a teammate's character) for a reply. */
function message(role, who, at, text, av) {
  return h("div", { class: "th-msg " + role },
    av,
    h("div", { class: "th-msg-main" },
      h("div", { class: "th-who" }, h("span", { class: "th-name" }, who), at ? h("span", { class: "code faint" }, clock(at)) : null),
      h("p", { class: "th-text" }, text)));
}

/** A tool call as the board's mono lines: "● Tool(arg)" then "⎿ result". */
function toolLine(ev) {
  const arg = toolArg(ev.tool, ev.input);
  const res = toolResult(ev.result);
  return h("div", { class: "tl" },
    h("div", { class: "tl-call" }, h("span", { class: "tl-dot", "aria-hidden": "true" }, "●"),
      h("span", { class: "tl-sig" }, h("span", { class: "tl-name" }, ev.tool || "Tool"), h("span", { class: "faint" }, "("), h("span", { class: "tl-arg" }, arg), h("span", { class: "faint" }, ")"))),
    res ? h("div", { class: "tl-res" }, h("span", { class: "faint", "aria-hidden": "true" }, "⎿"), h("span", null, res)) : null);
}
function toolArg(tool, input) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input, 160);
  const k = ["file_path", "path", "command", "pattern", "url", "query", "q", "prompt", "description"].find(k => typeof input[k] === "string");
  return clip(k ? input[k] : JSON.stringify(input), 160);
}
function toolResult(r) {
  if (r == null || r === "") return "";
  const s = typeof r === "string" ? r : (r.summary || r.text || JSON.stringify(r));
  return clip(String(s).split("\n").filter(Boolean).slice(0, 2).join("  "), 200);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function recalledBlock(ev, project) {
  const from = ev.from || ev.source?.name || ev.source || null;
  const session = ev.session || ev.source?.session || null;
  const href = session ? (project ? `/projects/${enc(project.slug)}/${enc(session)}` : `/threads/${enc(session)}`) : null;
  const text = toolResult(ev.result) || ev.text || "";
  return h("div", { class: "recalled th-recalled" },
    h("div", { class: "lbl recall th-rl" }, h("span", { class: "dot recall", "aria-hidden": "true" }), "Recalled · no model used"),
    h("div", { class: "th-rtext" }, text,
      from ? h("span", { class: "muted" }, " From ", href ? link(href, { class: "link", style: { color: "var(--text-2)" } }, String(from)) : String(from), ".") : null));
}

function normAsk(a, at) {
  return {
    id: a.id || a.ask, at: a.at || at, tool: a.tool || "", command: a.command || a.summary || "", rule: a.rule || "", why: a.why || "",
    // A Mac session's ask on a box that cannot forward the answer: no options, and the card says where.
    elsewhere: a.elsewhere || null,
    options: a.elsewhere ? [] : a.options?.length ? a.options : [{ label: "Allow once", decision: "allow" }, { label: "Deny", decision: "deny" }],
  };
}

/** A held call, in Beacon, with its actions. */
function heldBlock(a, threadId) {
  const status = h("div", { class: "small muted th-held-status", role: "status" });
  const buttons = h("div", { class: "th-held-actions" });
  const act = async opt => {
    for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
    try {
      const n = needs.current().find(x => x.id === a.id);
      if (n) await needs.answer(n, opt);
      else await queue("threads.answer", { ask: a.id, decision: opt.decision, ...(opt.input ? { input: opt.input } : {}) });
      settle(el, opt.label);
    } catch (e) {
      const err = /** @type {any} */ (e);
      put(status, err.missing ? "The switchboard module is not running, so this cannot be answered here yet." : String(err.message));
      // The box cannot forward answers to this Mac (needs.js): the line says where, no buttons.
      if (err.elsewhere) put(buttons);
      else for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = false;
    }
  };
  put(buttons, a.elsewhere ? h("span", { class: "small muted" }, `Answer it on ${a.elsewhere}`) : a.options.map((opt, i) => h("button", { type: "button",
    class: "btn" + (i === 0 ? " btn-primary" : i === a.options.length - 1 ? " btn-ghost" : ""), onclick: () => act(opt) }, opt.label)));
  const el = h("div", { class: "held th-held", role: "group", "aria-label": "Held tool call", "data-ask": a.id, "data-thread": threadId },
    h("div", { class: "th-held-top" }, h("span", { class: "lbl beacon th-rl" }, h("span", { class: "dot beacon", "aria-hidden": "true" }), "Held before it ran"),
      a.at ? h("span", { class: "code" }, clock(a.at)) : null),
    h("div", { class: "tl th-held-call" },
      h("div", { class: "tl-call" }, h("span", { class: "tl-dot beacon", "aria-hidden": "true" }, "●"),
        h("span", { class: "tl-sig" }, h("span", { class: "tl-name" }, a.tool || "Tool"), h("span", { class: "muted" }, "("), h("span", null, a.command), h("span", { class: "muted" }, ")"))),
      h("div", { class: "tl-res th-held-res" }, h("span", { "aria-hidden": "true" }, "⎿"), h("span", null, "Not run. Waiting for you."))),
    a.rule ? h("p", { class: "th-held-why" }, "Your rule: ", h("span", { class: "th-bone" }, a.rule.replace(/\.?$/, ".")))
      : a.why ? h("p", { class: "th-held-why" }, a.why) : null,
    buttons, status);
  return el;
}

function settle(el, label) {
  el.classList.add("settled");
  el.querySelector(".th-held-actions")?.replaceChildren();
  const res = el.querySelector(".th-held-res span:last-child");
  if (res) put(/** @type {HTMLElement} */ (res), `Answered: ${label}.`);
  const top = el.querySelector(".th-held-top .lbl");
  if (top) put(/** @type {HTMLElement} */ (top), "Answered");
}

// ---- files the thread touched ------------------------------------------------------------

async function drawFiles(ctx, box, id, toolEvents) {
  const r = await attempt("harness.touched", { session: id, limit: 100 });
  if (!ctx.alive()) return;
  let rows = r.data || [], from = "harness";
  if (!rows.length) {
    // The Harness has not recorded this thread (it ran elsewhere, or not yet): read the paths
    // from its own tool calls instead.
    const seen = new Map();
    for (const ev of [...toolEvents].reverse()) {
      const p = ev.input && typeof ev.input === "object" ? (ev.input.file_path || ev.input.path || ev.input.notebook_path) : null;
      if (typeof p === "string" && !seen.has(p)) seen.set(p, { path: p, tool: ev.tool, at: ev.at });
    }
    rows = [...seen.values()];
    from = rows.length ? "tools" : from;
  }
  put(box,
    h("div", { class: "pj-files-head" }, h("h2", { class: "lbl" }, "Files"), h("span", { class: "code faint" }, rows.length ? plural(rows.length, "file") : "")),
    r.error && !rows.length ? h("div", { class: "pj-files-pad" }, empty("Files are not available.", r.error))
      : rows.length ? h("div", { class: "rows pj-files-list" }, rows.map(f => fileRow(f)))
        : h("div", { class: "pj-files-pad empty" }, "This thread has not changed a file."),
    from === "tools" ? h("p", { class: "small faint pj-files-pad" }, "Read from this thread's tool calls.") : null,
    h("div", { class: "pj-files-pad" }, noContents()));
}

// ---- the composer --------------------------------------------------------------------------

/**
 * @param {any} ctx @param {HTMLElement} box
 * @param {{ id: string, agent: string|null, lease: string|null, swMissing: boolean, recorded?: boolean, machine?: string|null, append: (t: string) => void }} o
 *   machine: the thread is that Mac's, so the reply, the keyboard and Take are off, and it says where to continue it.
 */
function drawComposer(ctx, box, o) {
  const mac = o.machine ? { source: "mac", machine: o.machine } : null;
  if (mac) { put(box, h("div", { class: "th-note-row" }, h("div", { class: "readonly-note th-note", role: "status" }, readOnlyNote(mac)))); return; }
  let holder = o.lease;
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "th-in", id: "reply-" + o.id, autocomplete: "off" }));
  const send = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "ibtn", "aria-label": "Send" }, icon("send")));
  const note = h("div", { class: "small faint th-note", role: "status" });
  const take = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: async () => {
    const r = await attempt("threads.lease", { thread: o.id, surface: "deck" });
    if (r.error) { put(note, r.error.missing ? "The switchboard module is not running." : String(r.error.message)); return; }
    holder = r.data?.holder || r.data?.surface || "deck";
    draw();
    if (holder === "deck") input.focus();
  } }, "Take the keyboard");

  const draw = () => {
    const other = holder && holder !== "deck";
    input.disabled = o.swMissing || !!other;
    send.disabled = input.disabled;
    input.placeholder = o.swMissing ? "Replies are off here" : other ? `${holder} is typing` : o.agent ? `Reply to ${o.agent}` : o.recorded ? "Reply to carry this thread on" : "Reply";
    take.hidden = !other || o.swMissing;
    put(note, o.swMissing ? "The switchboard module is not running, so this thread cannot take a reply from the Deck."
      : other ? `The ${holder} has the keyboard. You can read along, or take it.` : "");
  };
  const form = h("form", { class: "th-box", onsubmit: async (/** @type {Event} */ e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    send.disabled = true;
    if (holder !== "deck") {
      const l = await attempt("threads.lease", { thread: o.id, surface: "deck" });
      if (l.error) { put(note, l.error.missing ? "The switchboard module is not running." : String(l.error.message)); send.disabled = false; return; }
      holder = l.data?.holder || l.data?.surface || "deck";
      if (holder !== "deck") { draw(); return; }
    }
    const r = await queued("threads.send", { thread: o.id, text });
    send.disabled = false;
    if (r.error) { put(note, r.error.missing ? "The switchboard module is not running." : String(r.error.message)); return; }
    // threads.send answers {sent:false,...} rather than an error when the lease was taken back
    // between the check above and this call.
    if (r.data && r.data.sent === false) { holder = r.data.holder || null; draw(); return; }
    input.value = "";
    o.append(text);
    put(note, "");
  } },
    h("label", { for: "reply-" + o.id, class: "pj-sr" }, o.agent ? `Message ${o.agent}` : "Reply"),
    input, send);
  ctx.on("lease.changed", e => {
    if (!(e.thread === o.id || e.payload?.thread === o.id)) return;
    holder = e.payload?.surface || e.payload?.holder || null;
    draw();
  });
  put(box, form, h("div", { class: "th-note-row" }, note, take));
  draw();
}
