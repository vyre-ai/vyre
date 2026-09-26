// @ts-check
// The rail: search, projects (each with its sessions, disclosed), "No project", agents. Pure
// render: app.js owns the data and re-renders on every relevant event, so this file never holds
// state across a render beyond what disclosure the user has open (kept in module scope, not
// re-fetched, so expanding a project survives a refresh).

import { h, empty } from "../js/dom.js";
import { icon } from "../js/icons.js";

/** Which projects and agents are expanded. Survives re-renders (module-level), not reloads. */
const open = new Set();

/**
 * @param {{ projects: any[], threads: any[], route: any, go: (h: string) => void, err: any }} p
 */
export function renderNav({ projects, threads, route, go, err }) {
  const q = h("input", { type: "text", placeholder: "Search sessions", "aria-label": "Search", oninput: e => filter(/** @type {any} */(e.target).value) });
  const list = h("div", { id: "nav-list" }, groups(projects, threads, route, ""));
  q.addEventListener("input", e => { put2(list, groups(projects, threads, route, /** @type {any} */(e.target).value)); });

  return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", height: "100%" } },
    h("label", { class: "search" }, icon("search", 14), q),
    err ? h("div", { class: "empty" }, "Some sessions may be missing.", h("span", { class: "code" }, err.missing ? `The ${err.module} module is not running.` : String(err.message || err))) : null,
    list,
  );
}

function put2(el, kids) { el.replaceChildren(); for (const k of [kids].flat(Infinity)) if (k != null && k !== false) el.append(k); }

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
  out.push(h("div", { class: "rail-group" },
    projects.filter(p => !needle || p.name.toLowerCase().includes(needle) || byProject.get(p.slug).length)
      .map(p => projectGroup(p, byProject.get(p.slug) || [], route, needle)),
  ));
  if (noProject.length || (!needle && !projects.length))
    out.push(h("div", { class: "rail-group" }, disclose("no-project", "No project", noProject.length, () =>
      h("div", { class: "rail-sub" }, noProject.map(t => threadLink(t, route))))));
  if (byAgent.size) out.push(h("div", { class: "rail-group" },
    h("div", { class: "lbl", style: { padding: "0 10px 6px" } }, "Agents"),
    [...byAgent.entries()].map(([agent, rows]) => disclose("agent:" + agent, agent, rows.length, () =>
      h("div", { class: "rail-sub" }, rows.map(t => threadLink(t, route))), rows.some(t => t.status === "running")))));
  if (!out.some(g => g.childNodes.length)) return [h("div", { class: "empty" }, needle ? "No matches." : "Nothing yet.")];
  return out;
}

function projectGroup(p, rows, route, needle) {
  const isOpen = needle ? true : open.has("p:" + p.slug) || route.project === p.slug;
  return disclose("p:" + p.slug, p.name, rows.length, () =>
    h("div", { class: "rail-sub" }, rows.length ? rows.map(t => threadLink(t, route)) : h("div", { class: "empty", style: { padding: "4px 10px" } }, "No sessions")),
    false, isOpen, () => location.hash = `#/p/${p.slug}`);
}

function disclose(key, label, count, body, live = false, forceOpen, onLabel) {
  const isOpen = forceOpen !== undefined ? forceOpen : open.has(key);
  const btn = h("button", { class: "rail-disclose", "aria-expanded": String(isOpen), onclick: () => { if (isOpen) open.delete(key); else open.add(key); rerenderNearest(btn); } },
    icon("chevron", 11),
    live ? h("span", { class: "agent-dot live" }) : null,
    h("span", { style: { flexGrow: "1", textAlign: "left", cursor: onLabel ? "pointer" : undefined }, onclick: onLabel ? (e => { e.stopPropagation(); onLabel(); }) : null }, label),
    count ? h("span", { class: "code" }, String(count)) : null,
  );
  const wrap = h("div", null, btn, isOpen ? body() : null);
  return wrap;
}

// A disclosure button's own container is swapped in place: replaying groups() from app.js's next
// render is simpler than diffing, so on toggle we just ask the nearest render to happen again by
// dispatching the same event app.js already listens for one of (cheap: nav has no independent
// data of its own, only open-state).
function rerenderNearest(el) {
  window.dispatchEvent(new Event("hashchange"));
}

function threadLink(t, route) {
  const href = t.project ? `#/p/${t.project}/t/${t.id}` : `#/t/${t.id}`;
  const current = route.thread === t.id;
  return h("a", { class: "rail-a", href, "aria-current": current ? "page" : null },
    t.status === "running" ? h("span", { class: "agent-dot live" }) : h("span", { class: "agent-dot" }),
    h("span", { class: "ellipsis", style: { flexGrow: "1" } }, t.name || t.id.slice(0, 8)),
    t.asks ? h("span", { class: "count" }, String(t.asks)) : null,
  );
}
