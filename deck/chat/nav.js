// @ts-check
// The project/session tree Chat hands to ctx.rail(): search, projects (each disclosed to its
// sessions), "No project", agents. Pure render: index.js owns the data and calls this again on
// every relevant event. Disclosure state (which projects/agents are expanded) lives at module
// scope, so it survives a re-render but not a reload.

import { h, link } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { threadHref, projectHref } from "./lib/routes.js";

const open = new Set();

/**
 * @param {{ projects: any[], threads: any[], route: { project: string|null, thread: string|null }, err: any }} p
 */
export function renderNav({ projects, threads, route, err }) {
  const list = h("div", { id: "chat-nav-list" }, groups(projects, threads, route, ""));
  const q = h("input", { type: "text", placeholder: "Search sessions", "aria-label": "Search sessions",
    oninput: e => { list.replaceChildren(); for (const k of [groups(projects, threads, route, /** @type {any} */ (e.target).value)].flat(Infinity)) if (k) list.append(k); } });

  return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
    h("label", { class: "search", style: { width: "auto" } }, icon("search", 14), q),
    err ? h("div", { class: "empty" }, "Some sessions may be missing.", h("span", { class: "code" }, err.missing ? `The ${err.module} module is not running.` : String(err.message || err))) : null,
    list,
  );
}

function groups(projects, threads, route, q) {
  const needle = q.trim().toLowerCase();
  const match = t => !needle || String(t.name || t.id).toLowerCase().includes(needle) || String(t.agent || "").toLowerCase().includes(needle);
  const byProject = new Map(projects.map(p => [p.slug, []]));
  const noProject = [], byAgent = new Map();
  for (const t of threads) {
    if (!match(t)) continue;
    if (t.project && byProject.has(t.project)) byProject.get(t.project).push(t);
    else if (!t.project) noProject.push(t);
    if (t.agent) { if (!byAgent.has(t.agent)) byAgent.set(t.agent, []); byAgent.get(t.agent).push(t); }
  }
  const out = [];
  if (projects.length) out.push(h("div", { class: "rail-group" },
    projects.filter(p => !needle || p.name.toLowerCase().includes(needle) || byProject.get(p.slug).length)
      .map(p => projectGroup(p, byProject.get(p.slug) || [], route))));
  if (noProject.length) out.push(h("div", { class: "rail-group" }, disclose("no-project", "No project", noProject.length, () =>
    h("div", { class: "rail-sub" }, noProject.map(t => threadLink(t, route))))));
  if (byAgent.size) out.push(h("div", { class: "rail-group" },
    h("div", { class: "lbl", style: { padding: "0 10px 6px" } }, "Agents"),
    [...byAgent.entries()].map(([agent, rows]) => disclose("agent:" + agent, agent, rows.length, () =>
      h("div", { class: "rail-sub" }, rows.map(t => threadLink(t, route))), rows.some(t => t.status === "running")))));
  if (!out.length) out.push(h("div", { class: "empty" }, needle ? "No matches." : "Nothing yet."));
  return out;
}

function projectGroup(p, rows, route) {
  const isOpen = open.has("p:" + p.slug) || route.project === p.slug;
  const label = link(projectHref(p.slug), { class: "ellipsis", style: { flexGrow: "1" }, onclick: e => e.stopPropagation() }, p.name);
  return disclose("p:" + p.slug, label, rows.length, () =>
    h("div", { class: "rail-sub" }, rows.length ? rows.map(t => threadLink(t, route)) : h("div", { class: "empty", style: { padding: "4px 10px" } }, "No sessions")),
    false, isOpen);
}

function disclose(key, label, count, body, live, isOpen) {
  const btn = h("button", { class: "rail-disclose", type: "button", "aria-expanded": String(isOpen), onclick: () => { if (isOpen) open.delete(key); else open.add(key); rerender(); } },
    icon("chevron", 11),
    live ? h("span", { class: "agent-dot live" }) : null,
    typeof label === "string" ? h("span", { style: { flexGrow: "1", textAlign: "left" } }, label) : label,
    count ? h("span", { class: "code" }, String(count)) : null);
  return h("div", null, btn, isOpen ? body() : null);
}

// Toggling disclosure has no data of its own to change, so the cheapest correct redraw is asking
// the router to run this view's render again (index.js listens for the same events already).
function rerender() { window.dispatchEvent(new Event("deck:navigate")); }

function threadLink(t, route) {
  const current = route.thread === t.id;
  return link(threadHref(t), { class: "rail-a", "aria-current": current ? "page" : null },
    t.status === "running" ? h("span", { class: "agent-dot live" }) : h("span", { class: "agent-dot" }),
    h("span", { class: "ellipsis", style: { flexGrow: "1" } }, t.name || t.id.slice(0, 8)),
    t.asks ? h("span", { class: "count" }, String(t.asks)) : null);
}
