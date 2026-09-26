// @ts-check
// Vyre Chat's view module. deck/views/chat.js dynamically imports this and calls its default
// export with the Deck's real ctx (deck/js/app.js documents the contract). Mounted at /chat,
// /chat/:project, /chat/:project/:thread and /chat/thread/:thread (a project-less session).
// The shell (header, rail's upper Places, tabbar) is deck's; this file fills ctx.root with the
// session list or the session view, and ctx.rail() with the project/session tree.

import { h, put, empty, link, go } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { when } from "../js/fmt.js";
import { renderNav } from "./nav.js";
import { mountSession } from "./session.js";
import { threadHref, projectHref } from "./lib/routes.js";

// Offline read of the recent-session list: names, ids, projects and timestamps only, never a
// message's words (the same line deck's service worker already draws for /v1/, and the same
// shape as Now's own snapshot in deck/views/now.js — deck's call on what "offline read" may hold).
const SNAP_KEY = "vyre.chat.snapshot";
const saveSnapshot = (projects, threads) => { try { localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(),
  projects: projects.map(p => ({ slug: p.slug, name: p.name, threads: p.threads, last: p.last })),
  threads: threads.map(t => ({ id: t.id, name: t.name, project: t.project, agent: t.agent, status: t.status, last: t.last, asks: t.asks })) })); } catch {} };
const loadSnapshot = () => { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch { return null; } };

/** @param {any} ctx */
export default async function chat(ctx) {
  const project = ctx.params.project || null;
  const thread = ctx.params.thread || null;
  const state = { projects: [], threads: [], err: null, offline: false, snapAt: null };

  /** Fetch and fold the result into state, live or offline. Shared by boot and refresh. */
  async function load() {
    const [p, t] = await Promise.all([attempt("projects.list"), attempt("threads.list", { all: true })]);
    if (!ctx.alive()) return;
    const offline = p.error?.code === "offline" || t.error?.code === "offline";
    const snap = offline ? loadSnapshot() : null;
    state.projects = p.data ? p.data.projects : (snap ? snap.projects : state.projects);
    state.threads = t.data || (snap ? snap.threads : state.threads);
    state.err = p.error || t.error;
    state.offline = offline && !!snap;
    state.snapAt = snap ? snap.at : state.snapAt;
    if (p.data && t.data) saveSnapshot(state.projects, state.threads);
  }

  await load();
  if (!ctx.alive()) return;
  drawNav();
  drawMain();

  for (const type of ["thread.started", "thread.finished", "thread.stopped", "lease.changed", "ask.raised", "ask.answered", "project.created", "project.changed", "thread.picked", "thread.unpicked"])
    ctx.on(type, refresh);

  async function refresh() {
    await load();
    if (!ctx.alive()) return;
    drawNav();
    if (!thread) drawMain();               // the session view follows its own SSE; no full redraw needed
  }

  function drawNav() {
    if (!ctx.alive()) return;
    // onChange (a disclosure triangle toggled) redraws only this, from data already in hand: no
    // refetch, and drawMain/the session view are never touched just because a folder opened.
    ctx.rail(renderNav({ projects: state.projects, threads: state.threads, route: { project, thread }, err: state.err, onChange: drawNav }));
  }

  function drawMain() {
    if (!ctx.alive()) return;
    if (thread) {
      const container = h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" } });
      put(ctx.root, container);
      ctx.cleanup(mountSession(container, { thread, project, onBack: () => go(project ? projectHref(project) : "/chat") }));
      return;
    }
    if (project) {
      const rows = state.threads.filter(x => x.project === project);
      const proj = state.projects.find(x => x.slug === project);
      put(ctx.root, h("div", { style: { padding: "20px" } },
        h("div", { class: "section-head" }, h("h2", { class: "lbl" }, proj ? proj.name : project)),
        rows.length ? h("div", { class: "rows", style: { marginTop: "12px" } }, rows.map(threadRow))
          : h("div", { class: "empty" }, "No sessions in this project yet.")));
      return;
    }
    const open = state.threads.slice(0, 30);
    put(ctx.root, state.offline ? h("div", { class: "empty", style: { padding: "12px 20px 0" } }, `Offline, showing what was cached as of ${when(state.snapAt)}.`) : null,
      open.length
        ? h("div", { style: { padding: "20px" } }, h("div", { class: "section-head" }, h("h2", { class: "lbl" }, "Recent")),
          h("div", { class: "rows", style: { marginTop: "12px" } }, open.map(threadRow)))
        : empty("No sessions yet.", state.err));
  }

  function threadRow(row) {
    return link(threadHref(row), { class: "thread-row" },
      h("div", { class: "r1" },
        h("span", { class: "av-agent" }, (row.agent || "u").slice(0, 2)),
        h("span", { class: "title ellipsis" }, row.name || row.id),
        row.status === "running" ? h("span", { class: "dot signal" }) : null),
      h("div", { class: "meta" },
        h("span", null, row.turns ? `${row.turns} turns` : "no turns yet"),
        row.asks ? h("span", { class: "needs" }, h("span", { class: "dot beacon" }), `${row.asks} need${row.asks === 1 ? "s" : ""} you`) : null,
        row.holder ? h("span", null, row.holder) : null));
  }
}
