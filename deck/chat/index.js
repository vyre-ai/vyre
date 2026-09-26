// @ts-check
// Vyre Chat's view module. deck/views/chat.js dynamically imports this and calls its default
// export with the Deck's real ctx (deck/js/app.js documents the contract). Mounted at /chat,
// /chat/:project/:thread and, since the router has no route for a project-less thread yet,
// /chat/_/:thread (project "_" means none — see the note to deck in docs/work/gate-chat.md).
// The shell (header, rail's upper Places, tabbar) is deck's; this file fills ctx.root with the
// session list or the session view, and ctx.rail() with the project/session tree.

import { h, put, empty, link, go } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { renderNav } from "./nav.js";
import { mountSession } from "./session.js";
import { threadHref, projectHref } from "./lib/routes.js";

/** @param {any} ctx */
export default async function chat(ctx) {
  const project = ctx.params.project && ctx.params.project !== "_" ? ctx.params.project : null;
  const thread = ctx.params.thread || null;

  const [p, t] = await Promise.all([attempt("projects.list"), attempt("threads.list", { all: true })]);
  if (!ctx.alive()) return;
  const state = { projects: p.data ? p.data.projects : [], threads: t.data || [], err: p.error || t.error };

  drawNav();
  drawMain();

  for (const type of ["thread.started", "thread.finished", "thread.stopped", "lease.changed", "ask.raised", "ask.answered", "project.created", "project.changed", "thread.picked", "thread.unpicked"])
    ctx.on(type, refresh);

  async function refresh() {
    const [p2, t2] = await Promise.all([attempt("projects.list"), attempt("threads.list", { all: true })]);
    if (!ctx.alive()) return;
    state.projects = p2.data ? p2.data.projects : state.projects;
    state.threads = t2.data || state.threads;
    drawNav();
    if (!thread) drawMain();               // the session view follows its own SSE; no full redraw needed
  }

  function drawNav() {
    if (!ctx.alive()) return;
    ctx.rail(renderNav({ projects: state.projects, threads: state.threads, route: { project, thread }, err: state.err }));
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
    put(ctx.root, open.length
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
