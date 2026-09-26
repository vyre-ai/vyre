// @ts-check
// The Deck's shell: the header, the rail, the phone tab bar, search, and the router that loads
// one view at a time from deck/views/. Board: DeckNow (header and rail), PhoneNow (tab bar).
//
// A view is a module in deck/views/ whose default export is `async (ctx) => void`:
//   ctx.root     the empty element to render into
//   ctx.params   route parameters ({ slug, thread, name, id })
//   ctx.query    URLSearchParams of the address
//   ctx.on(type, fn)   an event subscription that ends when the user leaves the view
//   ctx.cleanup(fn)    anything else to undo on leaving (timers)
//   ctx.alive()  false once the user has left, for guarding late async work
// Views never touch the shell; they reach vyred only through js/api.js.

import { h, put, link, go } from "./dom.js";
import { attempt, on, fromFixtures, fixturesOn } from "./api.js";
import { icon, mark, wordmark } from "./icons.js";
import * as needs from "./needs.js";
import { when, base, initials } from "./fmt.js";

/** Routes, most specific first. The name is the file in deck/views/. */
const ROUTES = [
  ["/now", "now"],
  ["/needs/:id", "needs"],
  ["/projects", "projects"],
  ["/projects/:slug", "projects"],
  ["/projects/:slug/:thread", "projects"],
  ["/threads/:thread", "projects"],
  ["/memory", "memory"],
  ["/agents", "agents"],
  ["/agents/:name", "agents"],
  ["/agents/:name/glass", "glass"],
  ["/chat", "chat"],
  ["/chat/:id", "chat"],
  ["/vault", "vault"],
  ["/vault/:place", "vault"],
  ["/vault/:place/:name", "vault"],
  ["/settings", "settings"],
  ["/ask", "ask"],
];
const PLACES = [
  { href: "/now", label: "Now", icon: "now", view: "now" },
  { href: "/projects", label: "Projects", icon: "projects", view: "projects" },
  { href: "/memory", label: "Memory", icon: "memory", view: "memory" },
  { href: "/agents", label: "Agents", icon: "agents", view: "agents" },
  { href: "/vault", label: "Vault", icon: "vault", view: "vault" },
  { href: "/settings", label: "Settings", icon: "settings", view: "settings" },
];
const TABS = [
  { href: "/now", label: "Now", icon: "clock", view: "now" },
  { href: "/projects", label: "Projects", icon: "projects", view: "projects" },
  { href: "/ask", label: "Ask", icon: "chat", view: "ask" },
  { href: "/agents", label: "Agents", icon: "agents", view: "agents" },
];

function match(pathname) {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (!parts.length) return { view: "now", params: {} };
  for (const [pattern, view] of ROUTES) {
    const p = pattern.split("/").filter(Boolean);
    if (p.length !== parts.length) continue;
    const params = {};
    if (p.every((seg, i) => seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i])) return { view, params };
  }
  return { view: "missing", params: {} };
}

// Theme: dark unless the viewer chose paper in Settings. A per-viewer convenience.
try { if (localStorage.getItem("vyre.theme") === "paper") document.documentElement.dataset.theme = "paper"; } catch {}

const deck = /** @type {HTMLElement} */ (document.getElementById("deck"));
const info = { host: "", projects: /** @type {any[]} */ ([]) };

// ---- shell ---------------------------------------------------------------------------------

const address = h("div", { class: "address" }, icon("lock", 12), h("span", null, location.host, h("b", null, "/now")));
const searchIn = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Search threads, files, people", "aria-label": "Search threads, files, people",
  autocomplete: "off", role: "combobox", "aria-expanded": "false", "aria-controls": "search-pop" }));
const pop = h("div", { class: "search-pop", id: "search-pop", role: "listbox", hidden: true });
const needsPill = link("/now", { class: "needs-pill", hidden: true }, h("span", { class: "dot beacon" }), h("span", null, ""));
const avatar = link("/settings", { class: "avatar", "aria-label": "Settings and account" }, "");
const railLinks = PLACES.map(p => link(p.href, { class: "rail-a", "data-view": p.view }, icon(p.icon), h("span", null, p.label),
  p.view === "now" ? h("span", { class: "count", hidden: true }) : null));
const pins = h("div", { class: "rail-pins" });
// A view fills this from ctx.rail(el) (e.g. Vault's places); cleared on every navigation, so a
// view that does not use it leaves the rail exactly as Projects/Agents/etc. already look.
const railLower = h("div", { class: "rail-lower" });
const foot = h("div", { class: "rail-foot" });
const view = h("main", { class: "view", id: "view" });
const tabs = TABS.map(t => link(t.href, { "data-view": t.view }, icon(t.icon, 22), h("span", null, t.label),
  t.view === "now" ? h("span", { class: "badge", hidden: true }) : null));

put(deck,
  h("header", { class: "top" },
    link("/now", { class: "brand", "aria-label": "vyre home" }, mark(20), wordmark(22)),
    address,
    h("label", { class: "search" }, icon("search", 14), searchIn, h("span", { class: "kbd" }, "⌘K"), pop),
    h("div", { style: { flexGrow: "1" } }),
    needsPill,
    avatar),
  h("div", { class: "body" },
    h("nav", { class: "rail", "aria-label": "Places" }, h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, railLinks), pins, railLower, foot),
    view),
  h("nav", { class: "tabbar", "aria-label": "Places" }, tabs));

function drawNeeds(list) {
  const n = list.length;
  needsPill.hidden = n === 0;
  put(/** @type {HTMLElement} */ (needsPill.lastChild), `${n} need${n === 1 ? "s" : ""} you`);
  for (const el of [railLinks[0].querySelector(".count"), tabs[0].querySelector(".badge")]) {
    if (!el) continue;
    /** @type {HTMLElement} */ (el).hidden = n === 0;
    put(/** @type {HTMLElement} */ (el), String(n));
  }
}
needs.watch(drawNeeds);

function pinned() {
  try { return JSON.parse(localStorage.getItem("vyre.pins") || "[]"); } catch { return []; }
}
async function drawRail() {
  const r = await attempt("projects.list");
  info.projects = r.data?.projects || [];
  const pins_ = pinned();
  const chosen = pins_.length ? pins_.map(s => info.projects.find(p => p.slug === s)).filter(Boolean)
    : [...info.projects].sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 4);
  const here = location.pathname.split("/")[2];
  put(pins, chosen.length ? h("div", { class: "lbl", style: { padding: "0 10px 8px" } }, pins_.length ? "Pinned" : "Recent") : null,
    chosen.map(p => link(`/projects/${encodeURIComponent(p.slug)}`, { class: "pin-a", "aria-current": location.pathname.startsWith("/projects/") && here === p.slug ? "page" : false },
      h("span", { class: "sq" }), h("span", { class: "ellipsis" }, p.name))));
}
window.addEventListener("deck:pins", drawRail);

async function drawFoot() {
  const r = await attempt("system.info");
  info.host = r.data?.host || location.hostname;
  put(avatar, initials(info.host).slice(0, 2) || "V");
  const onTailnet = /\.vyre\.run$|\.ts\.net$/.test(location.hostname);
  put(foot,
    h("div", { class: "code", style: { color: "var(--text-2)" } }, info.host),
    h("div", { class: "small faint" }, onTailnet ? "On your tailnet" : r.error ? "vyred is not answering" : "On this machine only"),
    fromFixtures.size ? h("div", { class: "fixture-note", title: [...fromFixtures].join(", ") }, "Sample data for modules not merged yet") : null);
}
window.addEventListener("deck:fixture", () => { clearTimeout(footT); footT = window.setTimeout(drawFoot, 200); });
let footT = 0;

// ---- search --------------------------------------------------------------------------------

let searchSeq = 0, active = -1;
/** @type {{ href: string }[]} */ let hits = [];
async function search() {
  const q = searchIn.value.trim();
  const n = ++searchSeq;
  if (q.length < 2) { pop.hidden = true; searchIn.setAttribute("aria-expanded", "false"); return; }
  const r = await attempt("recall.search", { q, limit: 8 });
  if (n !== searchSeq) return;
  active = -1;
  if (r.error) { put(pop, h("div", { class: "empty", style: { padding: "10px" } }, r.error.missing ? "Search needs the recall module, which is not running." : String(r.error.message))); }
  else if (!r.data.length) { put(pop, h("div", { class: "empty", style: { padding: "10px" } }, "Nothing said matches that.")); hits = []; }
  else {
    hits = r.data.map(t => ({ href: threadHref(t.session) }));
    put(pop, r.data.map((t, i) => link(hits[i].href, { role: "option", id: "hit-" + i, onclick: () => closeSearch() },
      h("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px" } },
        h("span", { class: "small ellipsis" }, t.name || t.title || t.session),
        h("span", { class: "code", style: { flexShrink: "0" } }, when(t.ts))),
      h("div", { class: "small muted", style: { marginTop: "2px" } }, snippet(t.snippet || t.text)),
      h("div", { class: "code faint", style: { marginTop: "2px" } }, base(t.cwd), " · ", t.role))));
  }
  pop.hidden = false;
  searchIn.setAttribute("aria-expanded", "true");
}
/** Recall marks matches with «»; shown in Bone against Stone, as text nodes only. */
export function snippet(s) {
  return String(s || "").split(/(«[^»]*»)/).map(part => part.startsWith("«") ? h("span", { style: { color: "var(--text)" } }, part.slice(1, -1)) : part);
}
const threadHref = session => `/threads/${encodeURIComponent(session)}`;
function closeSearch() { pop.hidden = true; searchIn.setAttribute("aria-expanded", "false"); searchIn.blur(); }
let st = 0;
searchIn.addEventListener("input", () => { clearTimeout(st); st = window.setTimeout(search, 180); });
searchIn.addEventListener("keydown", e => {
  const opts = [...pop.querySelectorAll("a")];
  if (e.key === "Escape") { closeSearch(); return; }
  if (!opts.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("on", i === active));
    searchIn.setAttribute("aria-activedescendant", "hit-" + active);
  }
  if (e.key === "Enter" && active >= 0) { e.preventDefault(); go(hits[active].href); closeSearch(); }
});
document.addEventListener("click", e => { if (!(/** @type {Element} */ (e.target)).closest(".search")) pop.hidden = true; });
document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchIn.focus(); searchIn.select(); } });

// ---- router --------------------------------------------------------------------------------

let leave = () => {};
async function route() {
  leave();
  const { view: name, params } = match(location.pathname);
  const offs = [];
  let alive = true;
  leave = () => { alive = false; for (const f of offs.splice(0)) { try { f(); } catch {} } };
  put(address.lastChild, location.host, h("b", null, location.pathname === "/" ? "/now" : location.pathname));
  for (const a of [...railLinks, ...tabs]) {
    const v = a.getAttribute("data-view");
    a.setAttribute("aria-current", v === name || (name === "needs" && v === "now") ? "page" : "false");
    if (a.getAttribute("aria-current") === "false") a.removeAttribute("aria-current");
  }
  drawRail();
  put(railLower);
  view.scrollTop = 0;
  put(view);
  const ctx = {
    root: view, params, query: new URLSearchParams(location.search),
    on: (type, fn) => { offs.push(on(type, fn)); },
    cleanup: fn => { offs.push(fn); },
    alive: () => alive,
    /** Fill the rail's lower group (between Recent/Pinned and the machine footer). */
    rail: (/** @type {any} */ el) => put(railLower, el),
  };
  try {
    await style(name);
    const mod = await import(`../views/${name}.js`);
    if (!alive) return;
    await mod.default(ctx);
  } catch (e) {
    if (!alive) return;
    console.error(e);
    put(view, h("div", { style: { padding: "48px 72px" } },
      h("div", { class: "lbl" }, name === "missing" ? "Not found" : "Not built yet"),
      h("h1", { class: "h2", style: { marginTop: "10px" } }, name === "missing" ? "There is nothing at this address." : "This part of the Deck is not here yet."),
      h("p", { class: "muted", style: { marginTop: "8px" } }, link("/now", { class: "link" }, "Back to Now"))));
  }
}
/** Each view has its own stylesheet, css/views/<name>.css, added once, before it first renders. */
const styled = new Map();
function style(name) {
  if (name === "missing") return Promise.resolve();
  if (!styled.has(name)) styled.set(name, new Promise(resolve => {
    const l = h("link", { rel: "stylesheet", href: `/css/views/${name}.css` });
    l.addEventListener("load", resolve);
    l.addEventListener("error", resolve);
    document.head.append(l);
  }));
  return styled.get(name);
}
window.addEventListener("popstate", route);
window.addEventListener("deck:navigate", route);

// First visit before setup is finished goes to the onboarding.
(async () => {
  const st = await attempt("onboard.status");
  if (st.data && st.data.owner === false && !fixturesOn) { location.replace("/onboard"); return; }
  drawFoot();
  route();
  needs.load();
  for (const t of ["ask.raised", "ask.answered", "gate.held", "gate.released", "gate.failed", "gate.rejected"]) on(t, () => needs.load());
  on("project.*", drawRail);
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
