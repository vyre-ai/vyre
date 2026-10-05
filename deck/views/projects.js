// @ts-check
// Projects: every project, and one project's board. Board: DeckProject (with Chat for how a
// thread reads).
//
//   /projects                     every project (projects.list), with pins and New project
//   /projects/:slug               the project's page: its chats, brief and the rest. ?tab= team|brief|files|memory
//
// Projects is a shell: it lists and describes a project and never draws a conversation. Every chat opens in
// Chat (/chat/<project>/<thread>), scoped to the project, where the one real session view lives; a start
// box is the same New chat there. /projects/<slug>/<thread> and /threads/<id> still work and go to Chat
// (js/app.js). The board used to draw its own copy of a thread, which read events by the wrong fields and
// drew empty rows and a composer that sent nothing (#37, #42).

import { h, put, link, go, head, empty } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { projectAvatar, setProjects } from "../js/avatars.js";
import * as needs from "../js/needs.js";
import { when, base, initial, plural } from "../js/fmt.js";
import { createProject, createProjectInline, startThread, indexHistoryInline, offerThen } from "../js/empty-actions.js";
import { renameProject, archiveProject } from "../js/project-actions.js";
import { openGithubRepoPicker } from "../js/github-repo-picker.js";
import { showToast } from "../js/toast.js";
import { chatCounts, chatsWord } from "../js/chat-counts.js";
import { threadRow as rowOf } from "../js/thread-row.js";
import { pageHeader } from "../js/page-header.js";

const enc = encodeURIComponent;
const TABS = [["threads", "Chats"], ["team", "Team"], ["brief", "Brief"], ["files", "Files"], ["memory", "Memory"]];

/** @param {any} ctx */
export default async function projects(ctx) {
  if (ctx.params.slug) return board(ctx);
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
  const count_ = h("span", null, " ");
  const form = h("div", { class: "pl-form", hidden: true });
  const newBtn = h("button", { type: "button", class: "btn btn-primary", "aria-expanded": "false", onclick: () => toggle(true) }, icon("plus", 14), "New project");
  const ghBtn = h("button", { type: "button", class: "btn", onclick: () => fromGithub() }, icon("branch", 14), "From a GitHub repo");
  let showArchived = false;
  const arcBtn = h("button", { type: "button", class: "btn btn-ghost", "aria-pressed": "false", "data-act": "archived", onclick: () => {
    showArchived = !showArchived; arcBtn.setAttribute("aria-pressed", String(showArchived)); put(arcBtn, showArchived ? "Hide archived" : "Archived"); draw();
  } }, "Archived");
  put(ctx.root, h("div", { class: "pl" },
    pageHeader({ title: "Projects", meta: count_, actions: [arcBtn, ghBtn, newBtn] }),
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
      offerThen(status, r, () => { if (slug) go(`/projects/${enc(slug)}`); else { toggle(false); draw(); } });
    } },
      h("div", { class: "pl-fields" },
        h("label", { class: "pl-field" }, h("span", { class: "lbl" }, "Name"), name),
        h("label", { class: "pl-field" }, h("span", { class: "lbl" }, "Home folder"), home),
        h("label", { class: "pl-field wide" }, h("span", { class: "lbl" }, "People"), people)),
      h("div", { class: "pl-form-actions" }, submit,
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => { toggle(false); newBtn.focus(); } }, "Cancel"), status));
    put(form, el);
  };

  /** @type {Map<string, number>} */ let chats = new Map();
  const draw = async () => {
    const [r, counts] = await Promise.all([attempt("projects.list", showArchived ? { archived: true } : {}), chatCounts(attempt)]);
    if (!ctx.alive()) return;
    chats = counts;
    if (r.error) { put(count_, ""); put(rows, empty("Projects are not available.", r.error)); return; }
    const all = [...(r.data?.projects || [])].sort((a, b) => (b.last || 0) - (a.last || 0));
    setProjects(all); // each project's tile seed (js/avatars.js)
    const pinned = new Set(pins());
    put(count_, all.length ? `${plural(all.length, "project")}, most recent first.` : "No projects yet.");
    put(rows,
      all.length ? all.map(p => projectRow(p, pinned.has(p.slug), draw, chats))
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

function projectRow(p, pinned, redraw, counts = new Map()) {
  const pin = h("button", { type: "button", class: "ibtn pl-pin", "aria-pressed": String(pinned), "aria-label": `${pinned ? "Unpin" : "Pin"} ${p.name}`,
    title: pinned ? "Pinned to the rail" : "Pin to the rail", onclick: () => { setPin(p.slug, !pinned); redraw(); } }, icon("pin"));
  const ppl = peopleText(p.people);
  return h("div", { class: "pl-row" },
    pin,
    projectAvatar(p.slug, { size: 32, cls: "pl-av" }),
    h("div", { class: "pl-main" },
      h("div", { class: "pl-name" }, link(`/projects/${enc(p.slug)}`, { class: "link quiet pl-open" }, p.name), p.archived_at ? h("span", { class: "tag" }, "Archived") : null, p.org ? h("span", { class: "tag" }, p.org) : null),
      h("div", { class: "small muted ellipsis" }, ppl.length ? ppl.join(", ") : h("span", { class: "faint" }, "No people yet"))),
    h("div", { class: "code pl-count" }, chatsWord(p, counts)),
    h("div", { class: "code faint pl-last" }, p.last ? when(p.last) : "never"),
    p.archived_at ? h("button", { type: "button", class: "btn btn-sm", "data-act": "restore", "aria-label": `Restore ${p.name}`,
      onclick: async () => { if (await archiveProject(p, false)) redraw(); } }, "Restore") : null,
    h("span", { class: "pl-chev", "aria-hidden": "true" }, icon("right")));
}

// ---- the board: /projects/:slug(/:thread) -----------------------------------------------

async function board(ctx) {
  const slug = ctx.params.slug;
  const tab = TABS.some(t => t[0] === ctx.query.get("tab")) ? ctx.query.get("tab") : "threads";
  const [pl, pt, sw, cx] = await Promise.all([
    attempt("projects.list"), attempt("projects.threads", { project: slug }), attempt("threads.list", {}), attempt("projects.context", { project: slug })]);
  if (!ctx.alive()) return;
  const p = (pl.data?.projects || []).find(x => x.slug === slug);
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
  // A chat opens in Chat, scoped to this project: the old /projects/<slug>/<thread> address goes there.
  if (ctx.params.thread) { go(`/chat/${enc(slug)}/${enc(ctx.params.thread)}`); return; }
  const hrefFor = id => `/chat/${enc(slug)}/${enc(id)}`;
  const tabHref = t => `/projects/${enc(slug)}` + (t === "threads" ? "" : `?tab=${t}`);

  const ppl = peopleText(p.people);
  const nameEl = h("h1", { class: "pj-name" }, p.name);
  const renameBtn = h("button", { type: "button", class: "ibtn pj-edit", "aria-label": `Rename ${p.name}`, title: "Rename", "data-act": "rename",
    onclick: () => renameProject(p, nameHead, name => { p.name = name; put(nameEl, name); renameBtn.setAttribute("aria-label", `Rename ${name}`); }) }, icon("edit", 14));
  const nameHead = h("span", { class: "pj-name-row" }, nameEl, renameBtn);
  const header = h("div", { class: "pj-head" },
    h("div", { class: "pj-id" },
      link("/projects", { class: "pj-back pj-phone", "aria-label": "All projects" }, icon("right", 14), "Projects"),
      projectAvatar(slug, { size: 44, cls: "pj-emblem" }),
      nameHead,
      p.org ? h("span", { class: "lbl pj-org" }, p.org) : null,
      ppl.length ? h("span", { class: "pj-people small muted" }, ppl.join(", ")) : null),
    h("nav", { class: "pj-tabs", "aria-label": "Project" }, TABS.map(([k, label]) => link(tabHref(k), { "aria-current": k === tab ? "page" : false }, label))),
    h("div", { class: "pj-grow" }),
    agents.length ? h("span", { class: "pj-agents small faint" }, agents.map(a => h("span", { class: "initial sm", "aria-hidden": "true" }, initial(a))), agents.join(", ")) : null,
    h("button", { type: "button", class: "btn btn-ghost btn-sm pj-archive", "data-act": "archive", title: "Take it out of the list. Nothing is deleted.", onclick: () => archiveProject(p) }, "Archive"),
    link(`/chat?new&project=${enc(slug)}`, { class: "btn", "aria-label": "New chat in this project" }, icon("plus", 14), h("span", { class: "nt-label" }, "New chat")));

  const root = h("div", { class: "pj tab-" + tab });
  put(ctx.root, root);

  if (tab === "brief") { put(root, header, briefTab(ctx, p, cx, sw.error)); return; }
  if (tab === "files") { put(root, header, filesTab(ctx, p, items)); return; }
  if (tab === "memory") { put(root, header, memoryTab(ctx, p)); return; }
  if (tab === "team") { const box = h("div", { class: "pj-page" }); put(root, header, box); const m = await import("./project-team.js"); if (ctx.alive()) await m.drawTeam(box, ctx, p); return; }

  // The project's chats, newest first: each opens in Chat. Beside them, the start of the brief.
  const threadList = h("div", { class: "pj-threads" });
  const drawList = () => put(threadList,
    items.length ? items.map(it => threadItem(it, false, hrefFor(it.id), needs.current(), slug))
      : sw.error?.missing ? h("div", { class: "empty pj-none" }, "No chats yet. Sessions are not available on your server, so one cannot start here.")
      : h("div", { class: "empty pj-none" }, "No chats yet. ", link(`/chat?new&project=${enc(slug)}`, { class: "link" }, "Start one")),
    sw.error && !sw.error.missing ? h("div", { class: "code pj-none" }, String(sw.error.message)) : null);
  drawList();
  ctx.cleanup(needs.watch(drawList));
  const brief = h("section", { class: "pj-brief", "aria-labelledby": "brief-h" },
    h("div", { class: "pj-brief-top" }, h("h2", { id: "brief-h", class: "lbl" }, "Brief"), link(tabHref("brief"), { class: "link small muted" }, "Read all")),
    cx.error ? empty("", cx.error) : shortBrief(cx.data?.text).map(l => h("p", { class: l.mono ? "pj-brief-mono" : "pj-brief-p" }, l.text)));
  put(root, header, h("div", { class: "pj-page pj-chats" }, h("div", { class: "lbl pj-threads-l" }, "Chats"), threadList, brief));

  // Keep the list's states fresh when a chat starts: read the page again.
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

function threadItem(it, on, href, open, project = null) {
  const t = it.live;
  const held = t && (t.state === "waiting") && open.some(n => n.thread === t.id);
  if (project) return rowOf({ href, title: it.name, project, agent: t?.agent || null, thread: it.id, at: it.at, status: t && t.state === "running" ? "running" : null,
    asks: held ? 1 : 0, turns: it.rec?.turns || 0, human: !t?.agent, current: on });
  const who = t ? (t.agent || "you") : (it.rec?.agents ? "you with an agent" : "you");
  const state = t ? (held ? null : t.state) : plural(it.rec?.turns || 0, "turn");
  return link(href, { class: "pj-t", "aria-current": on ? "true" : false },
    h("span", { class: "pj-t-row" }, h("span", { class: "pj-t-name ellipsis" }, it.name), h("span", { class: "code faint pj-t-at" }, when(it.at))),
    h("span", { class: "pj-t-row pj-t-sub" }, h("span", { class: "ellipsis" }, who, state ? ` · ${state}` : ""),
      held ? h("span", { class: "pj-held" }, h("span", { class: "dot beacon", "aria-hidden": "true" }), "held") : null));
}


// ---- tabs ---------------------------------------------------------------------------------

function briefTab(ctx, p, cx, swErr) {
  const lines = briefLines(cx.data?.text);
  const repos = h("div", { class: "pj-repos" });
  const page = h("div", { class: "pj-page" },
    head("Brief", h("span", { class: "code faint" }, "Built from this project's threads")),
    cx.error ? empty("The brief is not available.", cx.error)
      : lines.length ? h("div", { class: "pj-brief-full" }, lines.map(l => h("p", { class: /^(People|Other threads|From this project)/.test(l.text) ? "pj-brief-h" : "" }, l.text)))
        : h("div", { class: "empty" }, "Nothing in the brief yet. It fills in as threads run.", swErr?.missing ? null : link(`/chat?new&project=${enc(p.slug)}`, { class: "link" }, " Start a chat")),
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
    put(box, all.map(f => fileRow(f, link(`/chat/${enc(p.slug)}/${enc(f.thread.id)}`, { class: "link quiet small muted ellipsis pj-file-th" }, f.thread.name))));
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
