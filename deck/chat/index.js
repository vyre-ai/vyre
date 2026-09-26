// @ts-check
// Vyre Chat's view module. deck/views/chat.js dynamically imports this and calls its default
// export with the Deck's real ctx (deck/js/app.js documents the contract). Mounted at /chat,
// /chat/:project, /chat/:project/:thread and /chat/thread/:thread (a project-less session).
// The shell (header, rail's upper Places, tabbar) is deck's; this file fills ctx.root with the
// session list or the session view, and ctx.rail() with the project/session tree.
//
// The list is every Claude Code session on this device (projects.catalog, from the transcripts)
// merged with the Switchboard's headless threads (threads.list): lib/sessions.js. One fetch of
// each per refresh, never one per project. A new session, a rename or a new turn arrives as
// session.indexed (Recall indexes a session when its turn completes) or thread.started, so the
// list follows the user's terminal sessions live without polling.
//
// On the box, the list takes in the paired Mac's sessions too, each with a machine chip; opening
// one reads it through the box (recall.thread) and never offers to send to it. A paired Mac that
// is away shows as one quiet chip in the list's header, from link.macs, read with each refresh.

import { h, put, empty, link, go } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when, plural } from "../js/fmt.js";
import { renderNav } from "./nav.js";
import { mountSession } from "./session.js";
import { threadHref, projectHref } from "./lib/routes.js";
import { mergeSessions, title } from "./lib/sessions.js";
import { machineChip, offlineChip, readMacs } from "../js/machine.js";

/** How many sessions the catalogue returns per refresh: the newest, which is what Chat shows. */
const CATALOG_LIMIT = 300;

// Offline read of the recent-session list: names, ids, projects and timestamps only, never a
// message's words (the same line deck's service worker already draws for /v1/, and the same
// shape as Now's own snapshot in deck/views/now.js — deck's call on what "offline read" may hold).
const SNAP_KEY = "vyre.chat.snapshot";
const saveSnapshot = (projects, rows) => { try { localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(),
  projects: projects.map(p => ({ slug: p.slug, name: p.name, threads: p.threads, last: p.last, source: p.source, machine: p.machine })),
  rows: rows.slice(0, 100).map(t => ({ id: t.id, name: t.name, projects: t.projects, project: t.project, agent: t.agent, status: t.status,
    last: t.last, turns: t.turns, asks: t.asks, human: t.human, live: t.live, source: t.source, machine: t.machine })) })); } catch {} };
const loadSnapshot = () => { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch { return null; } };

/** @param {any} ctx */
export default async function chat(ctx) {
  const project = ctx.params.project || null;
  const thread = ctx.params.thread || null;
  const state = { projects: /** @type {any[]} */ ([]), rows: /** @type {import("./lib/sessions.js").Row[]} */ ([]), err: null, offline: false, snapAt: null, loaded: false,
    macs: /** @type {any[]} */ ([]) };

  /** Fetch and fold the result into state, live or offline. Shared by boot and refresh. */
  async function load() {
    const [p, c, t, macs] = await Promise.all([attempt("projects.list"), attempt("projects.catalog", { limit: CATALOG_LIMIT }), attempt("threads.list", { all: true }),
      readMacs(attempt, state.macs)]);
    if (!ctx.alive()) return;
    state.macs = macs;
    const offline = [p, c, t].some(r => r.error?.code === "offline");
    const snap = offline ? loadSnapshot() : null;
    state.loaded = true;
    if (snap && !p.data && !c.data) {
      state.projects = snap.projects || [];
      state.rows = snap.rows || [];
    } else {
      state.projects = p.data ? p.data.projects : state.projects;
      // A module that is not running leaves the other source's sessions standing.
      if (c.data || t.data) state.rows = mergeSessions(c.data?.sessions || [], t.data || []);
    }
    // The Switchboard missing is normal on a machine that never ran a headless thread; say so only
    // when the catalogue is missing too, since that is the list the user expects.
    state.err = p.error || c.error || null;
    state.offline = offline && !!snap;
    state.snapAt = snap ? snap.at : state.snapAt;
    if (p.data && c.data) saveSnapshot(state.projects, state.rows);
  }

  put(ctx.root, h("div", { class: "chat-pad" }, h("div", { class: "empty" }, thread ? "Opening the session…" : "Reading your sessions…")));
  await load();
  if (!ctx.alive()) return;
  drawNav();
  drawMain();

  let rt = 0;
  const refresh = () => { clearTimeout(rt); rt = window.setTimeout(async () => {
    await load();
    if (!ctx.alive()) return;
    drawNav();
    if (!thread) drawMain();               // the session view follows its own events; no full redraw needed
  }, 500); };
  ctx.cleanup(() => clearTimeout(rt));
  for (const type of ["thread.started", "thread.finished", "thread.stopped", "lease.changed", "ask.raised", "ask.answered", "project.created", "project.changed", "thread.picked", "thread.unpicked", "session.indexed"])
    ctx.on(type, refresh);

  function drawNav() {
    if (!ctx.alive()) return;
    // onChange (a disclosure triangle toggled) redraws only this, from data already in hand: no
    // refetch, and drawMain/the session view are never touched just because a folder opened.
    ctx.rail(renderNav({ projects: state.projects, rows: state.rows, route: { project, thread }, err: state.err, onChange: drawNav }));
  }

  function drawMain() {
    if (!ctx.alive()) return;
    if (thread) {
      const container = h("div", { class: "chat-session" });
      put(ctx.root, container);
      // A session the list knows the Switchboard never ran opens straight from its transcript.
      const known = state.rows.find(r => r.id === thread);
      ctx.cleanup(mountSession(container, { thread, project, recorded: !!known && !known.live, source: known?.source || null, machine: known?.machine || null,
        onBack: () => go(project ? projectHref(project) : "/chat") }));
      return;
    }
    const note = state.offline ? h("div", { class: "empty chat-offline" }, `Offline. Showing the list as of ${when(state.snapAt)}.`) : null;
    if (project) {
      const proj = state.projects.find(x => x.slug === project);
      const rows = state.rows.filter(x => x.projects.includes(project));
      put(ctx.root, note, h("div", { class: "chat-pad" },
        h("div", { class: "chat-head" },
          link("/chat", { class: "chat-back", "aria-label": "All sessions" }, icon("left", 16), h("span", null, "Chat")),
          h("h1", { class: "chat-title ellipsis" }, proj ? proj.name : project),
          machineChip(proj),
          rows.length ? h("span", { class: "code faint chat-count" }, plural(rows.length, "session")) : null,
          offlineChip(state.macs)),
        rows.length ? h("div", { class: "rows chat-rows" }, rows.map(r => threadRow(r, project)))
          : !proj && state.projects.length ? h("div", { class: "empty" }, `There is no project called ${project}.`)
          : empty(state.err ? "Sessions could not be read." : "No sessions in this project yet. Pick one into it from Projects, or start one there.", state.err)));
      return;
    }
    const recent = state.rows.filter(r => r.human || r.live).slice(0, 30);
    put(ctx.root, note, h("div", { class: "chat-pad" },
      h("div", { class: "chat-head" }, h("h1", { class: "chat-title" }, "Chat"), offlineChip(state.macs)),
      // On a phone the rail is hidden, so the projects are listed here as well.
      state.projects.length ? h("section", { class: "chat-projects", "aria-labelledby": "chat-projects-h" },
        h("div", { class: "section-head" }, h("h2", { class: "lbl", id: "chat-projects-h" }, "Projects")),
        h("div", { class: "rows" }, state.projects.map(p => {
          const n = state.rows.filter(r => r.projects.includes(p.slug)).length;
          return link(projectHref(p.slug), { class: "thread-row" },
            h("div", { class: "r1" }, h("span", { class: "title ellipsis" }, p.name), machineChip(p), h("span", { class: "code faint" }, plural(n, "session")), icon("right", 14)));
        }))) : null,
      h("section", { class: "chat-recent", "aria-labelledby": "chat-recent-h" },
        h("div", { class: "section-head" }, h("h2", { class: "lbl", id: "chat-recent-h" }, "Recent")),
        recent.length ? h("div", { class: "rows" }, recent.map(r => threadRow(r, null)))
          : empty(state.err ? "Sessions could not be read." : "No sessions yet. Start Claude Code in a terminal and it shows here.", state.err))));
  }

  function threadRow(row, inProject) {
    const where = inProject ? null : state.projects.find(p => p.slug === row.project)?.name;
    return link(threadHref(row, inProject), { class: "thread-row" },
      h("div", { class: "r1" },
        h("span", { class: "av-agent", "aria-hidden": "true" }, row.agent ? row.agent.slice(0, 2) : icon("terminal", 14)),
        h("span", { class: "title ellipsis" }, title(row)),
        machineChip(row),
        row.status === "running" ? h("span", { class: "dot signal", title: "running" }) : null),
      h("div", { class: "meta" },
        h("span", null, row.last ? when(row.last) : "no activity yet"),
        h("span", null, row.turns ? plural(row.turns, "turn") : "no turns yet"),
        where ? h("span", { class: "ellipsis" }, where) : null,
        row.asks ? h("span", { class: "needs" }, h("span", { class: "dot beacon" }), `${row.asks} need${row.asks === 1 ? "s" : ""} you`) : null,
        row.holder ? h("span", null, row.holder) : null));
  }
}
