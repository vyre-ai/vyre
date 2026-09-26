// @ts-check
// Vyre Chat: the shell and hash router. A Deck surface, not a separate app — it loads deck.css's
// tokens and its .shell/.top/.rail/.view/.tabbar layout (already the Deck's own convention; see
// onboard/onboard.js for the state-and-render pattern this follows). Routing is by hash
// (#/p/<project>/t/<thread>) rather than pushState for now: core/daemon's serveDeck() only falls
// back to the ROOT deck/index.html for a path that is not a real file, and that root shell does
// not exist yet. A hash never reaches the server, so a refresh or a deep link into a session
// works today; when the Deck's own router lands, this becomes one route among its others and the
// hash goes away. See docs/work/gate-chat.md.

import { h, put, empty } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { icon, wordmark } from "../js/icons.js";
import { renderNav } from "./nav.js";
import { mountSession } from "./session.js";

/** @typedef {{ slug: string, name: string, threads: number, picked: number, folder: number, last: number }} ProjectRow */

const state = {
  /** @type {ProjectRow[]} */ projects: [],
  /** @type {any[]} */ threads: [],
  projectsErr: /** @type {any} */ (null),
  threadsErr: /** @type {any} */ (null),
  needsYou: 0,
  loaded: false,
  navOpen: false,
};

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
let sessionCleanup = () => {};

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  // p/<slug>/t/<id>  |  p/<slug>  |  t/<id>  |  agents/<name>/t/<id>  |  (empty)
  if (parts[0] === "p" && parts[1] && parts[2] === "t" && parts[3]) return { view: "session", project: parts[1], thread: parts[3] };
  if (parts[0] === "p" && parts[1]) return { view: "project", project: parts[1] };
  if (parts[0] === "t" && parts[1]) return { view: "session", project: null, thread: parts[1] };
  if (parts[0] === "agents" && parts[1] === undefined) return { view: "agents" };
  if (parts[0] === "agents" && parts[2] === "t" && parts[3]) return { view: "session", project: null, thread: parts[3], agent: parts[1] };
  return { view: "home" };
}

export function go(hash) { location.hash = hash; }

async function refresh() {
  const [p, t] = await Promise.all([attempt("projects.list"), attempt("threads.list", { all: true })]);
  state.projects = p.data ? p.data.projects : [];
  state.projectsErr = p.error || null;
  state.threads = t.data || [];
  state.threadsErr = t.error || null;
  state.needsYou = state.threads.reduce((n, x) => n + (x.asks || 0), 0);
  state.loaded = true;
  render();
}

function render() {
  sessionCleanup();
  sessionCleanup = () => {};
  const r = route();
  put(app,
    h("header", { class: "top" },
      h("a", { class: "brand", href: "/" }, wordmark(20)),
      h("div", { class: "lbl" }, "Chat"),
      h("div", { style: { flexGrow: "1" } }),
      state.needsYou > 0 ? h("span", { class: "needs-pill" }, h("span", { class: "dot beacon" }), `${state.needsYou} need${state.needsYou === 1 ? "s" : ""} you`) : null,
      h("button", { class: "ibtn", "aria-label": "Toggle theme", onclick: toggleTheme }, icon("settings")),
    ),
    h("div", { class: "body" },
      h("nav", { class: "rail" + (state.navOpen ? " open" : ""), "aria-label": "Chat navigation" },
        state.loaded ? renderNav({ projects: state.projects, threads: state.threads, route: r, go, err: state.projectsErr || state.threadsErr }) : h("div", { class: "empty" }, "Loading…"),
      ),
      h("main", { class: "view", id: "chat-view" }, viewFor(r)),
    ),
    h("nav", { class: "tabbar", "aria-label": "Sections" },
      h("a", { href: "#/", "aria-current": r.view === "home" ? "page" : null }, icon("chat"), "Chat"),
      h("a", { href: "#/agents", "aria-current": r.view === "agents" ? "page" : null }, icon("agents"), "Agents"),
    ),
  );
}

function viewFor(r) {
  if (r.view === "session") {
    const container = h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" } });
    // Mount async so the shell paints first; mountSession wires SSE and returns its own cleanup.
    Promise.resolve().then(() => { sessionCleanup = mountSession(container, { thread: r.thread, project: r.project, onBack: () => go(r.project ? `#/p/${r.project}` : "#/") }); });
    return container;
  }
  if (r.view === "project") return projectView(r.project);
  if (r.view === "agents") return agentsView();
  return homeView();
}

function homeView() {
  if (!state.loaded) return empty("Loading…");
  const open = state.threads.filter(t => t.status === "running" || t.status === "idle").slice(0, 30);
  if (!open.length) return h("div", { class: "empty" }, "No sessions yet.", h("span", { class: "code" }, "Start one from the CLI (vyre start), or from a project once threads.start reaches Chat's composer."));
  return h("div", { style: { padding: "20px" } },
    h("div", { class: "section-head" }, h("h2", { class: "lbl" }, "Recent")),
    h("div", { class: "rows", style: { marginTop: "12px" } }, open.map(t => threadRow(t))),
  );
}

function projectView(slug) {
  const p = state.projects.find(x => x.slug === slug);
  const rows = state.threads.filter(t => t.project === slug);
  return h("div", { style: { padding: "20px" } },
    h("div", { class: "section-head" }, h("h2", { class: "lbl" }, p ? p.name : slug)),
    rows.length ? h("div", { class: "rows", style: { marginTop: "12px" } }, rows.map(t => threadRow(t)))
      : h("div", { class: "empty" }, "No sessions in this project yet."),
  );
}

function agentsView() {
  const byAgent = new Map();
  for (const t of state.threads) if (t.agent) { if (!byAgent.has(t.agent)) byAgent.set(t.agent, []); byAgent.get(t.agent).push(t); }
  if (!byAgent.size) return empty("No agents have run a session yet.");
  return h("div", { style: { padding: "20px", display: "flex", flexDirection: "column", gap: "20px" } },
    [...byAgent.entries()].map(([agent, rows]) => h("div", null,
      h("div", { class: "section-head" }, h("h2", { class: "lbl" }, agent)),
      h("div", { class: "rows", style: { marginTop: "12px" } }, rows.map(t => threadRow(t))),
    )),
  );
}

function threadRow(t) {
  const href = t.project ? `#/p/${t.project}/t/${t.id}` : `#/t/${t.id}`;
  return h("a", { class: "thread-row", href, "aria-current": location.hash === href ? "page" : null },
    h("div", { class: "r1" },
      h("span", { class: "av-agent" }, (t.agent || "u").slice(0, 2)),
      h("span", { class: "title ellipsis" }, t.name || t.id),
      t.status === "running" ? h("span", { class: "dot signal" }) : null,
    ),
    h("div", { class: "meta" },
      h("span", null, t.turns ? `${t.turns} turns` : "no turns yet"),
      t.asks ? h("span", { class: "needs" }, h("span", { class: "dot beacon" }), `${t.asks} need${t.asks === 1 ? "s" : ""} you`) : null,
      t.holder ? h("span", null, t.holder) : null,
    ),
  );
}

function toggleTheme() {
  const el = document.documentElement;
  el.dataset.theme = el.dataset.theme === "paper" ? "dark" : "paper";
  try { localStorage.setItem("vyre.theme", el.dataset.theme); } catch {}
}
try { const t = localStorage.getItem("vyre.theme"); if (t) document.documentElement.dataset.theme = t; } catch {}

window.addEventListener("hashchange", render);
on("thread.started", refresh);
on("thread.finished", refresh);
on("lease.changed", refresh);
on("ask.raised", refresh);
on("ask.answered", refresh);
on("project.created", refresh);
on("project.changed", refresh);
on("thread.picked", refresh);
on("thread.unpicked", refresh);

refresh();

// Offline read of recent sessions (PhoneAsk/PhoneNow parity): registration failure is silent and
// harmless, the app just has no offline cache.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/chat/sw.js").catch(() => {});
