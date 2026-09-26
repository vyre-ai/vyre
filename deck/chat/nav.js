// @ts-check
// The project/session tree Chat hands to ctx.rail(): search, projects (each disclosed to its
// sessions), "No project", agents. Pure render: index.js owns the data and calls this again on
// every relevant event. Disclosure state (which projects/agents are expanded) lives at module
// scope, so it survives a re-render but not a reload.
//
// Toggling a disclosure triangle must never cost more than a redraw of this tree: it used to
// dispatch deck:navigate, which runs the whole router again — refetching projects.list and
// threads.list, tearing down and rebuilding the session view (dropping an unsent composer draft
// and the session's own SSE subscription) just to flip one arrow (perf flagged this). It now
// calls the onChange index.js passes in, which redraws only ctx.rail() from data already in hand.

import { h, link, go } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { threadHref, projectHref } from "./lib/routes.js";
import { groupSessions, title } from "./lib/sessions.js";

const open = new Set();

/**
 * @param {{ projects: any[], rows: import("./lib/sessions.js").Row[], route: { project: string|null, thread: string|null },
 *   err: any, onChange: () => void }} p
 */
export function renderNav({ projects, rows, route, err, onChange }) {
  const list = h("div", { id: "chat-nav-list" }, groups(projects, rows, route, "", onChange));
  const q = h("input", { type: "text", placeholder: "Search sessions", "aria-label": "Search sessions",
    oninput: e => { list.replaceChildren(); for (const k of [groups(projects, rows, route, /** @type {any} */ (e.target).value, onChange)].flat(Infinity)) if (k) list.append(k); } });

  return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
    // New session and the folder browser (ADR 0024): /chat?new and /chat?folders, "n" from anywhere in Chat.
    h("div", { class: "chat-rail-actions" },
      h("button", { class: "btn btn-primary btn-sm chat-new", type: "button", title: "New session (n)",
        onclick: () => go(route.project ? `/chat?new&project=${encodeURIComponent(route.project)}` : "/chat?new") }, icon("plus", 14), "New session"),
      link("/chat?folders", { class: "rail-a chat-folders-a" }, icon("projects", 14), h("span", null, "Folders"))),
    h("label", { class: "search", style: { width: "auto" } }, icon("search", 14), q),
    err ? h("div", { class: "empty" }, "Some sessions may be missing.", h("span", { class: "code" }, err.missing ? `The ${err.module} module is not running.` : String(err.message || err))) : null,
    list,
  );
}

function groups(projects, rows, route, q, onChange) {
  const needle = q.trim().toLowerCase();
  const match = t => !needle || title(t).toLowerCase().includes(needle) || String(t.agent || "").toLowerCase().includes(needle);
  const { byProject, noProject, byAgent } = groupSessions(rows.filter(match), projects);
  const out = [];
  if (projects.length) out.push(h("div", { class: "rail-group" },
    projects.filter(p => !needle || p.name.toLowerCase().includes(needle) || byProject.get(p.slug)?.length)
      .map(p => projectGroup(p, byProject.get(p.slug) || [], route, onChange))));
  if (noProject.length) out.push(h("div", { class: "rail-group" }, disclose("no-project", "No project", noProject.length, () =>
    h("div", { class: "rail-sub" }, noProject.map(t => threadLink(t, route, null))), false, undefined, onChange)));
  if (byAgent.size) out.push(h("div", { class: "rail-group" },
    h("div", { class: "lbl", style: { padding: "0 10px 6px" } }, "Agents"),
    [...byAgent.entries()].map(([agent, list]) => disclose("agent:" + agent, agent, list.length, () =>
      h("div", { class: "rail-sub" }, list.map(t => threadLink(t, route, null))), list.some(t => t.status === "running"), undefined, onChange))));
  if (!out.length) out.push(h("div", { class: "empty" }, needle ? "No matches." : "No sessions yet."));
  return out;
}

function projectGroup(p, rows, route, onChange) {
  const isOpen = open.has("p:" + p.slug) || route.project === p.slug;
  const label = link(projectHref(p.slug), { class: "ellipsis link quiet", style: { flexGrow: "1", color: "inherit" }, onclick: e => e.stopPropagation() }, p.name);
  return disclose("p:" + p.slug, label, rows.length, () =>
    h("div", { class: "rail-sub" }, rows.length ? rows.map(t => threadLink(t, route, p.slug)) : h("div", { class: "empty", style: { padding: "4px 10px" } }, "No sessions yet")),
    false, isOpen, onChange);
}

function disclose(key, label, count, body, live, isOpen, onChange) {
  const open_ = isOpen !== undefined ? isOpen : open.has(key);
  const btn = h("button", { class: "rail-disclose", type: "button", "aria-expanded": String(open_), onclick: () => { if (open_) open.delete(key); else open.add(key); onChange(); } },
    icon("chevron", 11),
    live ? h("span", { class: "agent-dot live" }) : null,
    typeof label === "string" ? h("span", { style: { flexGrow: "1", textAlign: "left" } }, label) : label,
    count ? h("span", { class: "code" }, String(count)) : null);
  return h("div", null, btn, open_ ? body() : null);
}

function threadLink(t, route, inProject) {
  const current = route.thread === t.id && (!inProject || route.project === inProject);
  return link(threadHref(t, inProject), { class: "rail-a", "aria-current": current ? "page" : null },
    t.status === "running" ? h("span", { class: "agent-dot live" }) : h("span", { class: "agent-dot" }),
    h("span", { class: "ellipsis", style: { flexGrow: "1" } }, title(t)),
    t.asks ? h("span", { class: "count" }, String(t.asks)) : null);
}
