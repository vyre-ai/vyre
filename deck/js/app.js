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
import * as pwa from "./pwa.js";
// Loaded with the shell, not with Now, so it hears Chrome's one beforeinstallprompt.
import "./phone-setup.js";
import { isMac, machineChip } from "./machine.js";

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
  ["/glass/:name", "glass"],
  ["/chat", "chat"],
  ["/chat/thread/:thread", "chat"],
  ["/chat/:project", "chat"],
  ["/chat/:project/:thread", "chat"],
  ["/vault", "vault"],
  ["/vault/:place", "vault"],
  ["/vault/:place/:name", "vault"],
  ["/settings", "settings"],
  ["/ask", "ask"],
  ["/find", "find"],
  ["/planner", "planner"],
  // A planner push notification opens /planner/<firing> (ADR 0025).
  ["/planner/:firing", "planner"],
];
const PLACES = [
  { href: "/now", label: "Now", icon: "now", view: "now" },
  { href: "/projects", label: "Projects", icon: "projects", view: "projects" },
  { href: "/memory", label: "Memory", icon: "memory", view: "memory" },
  { href: "/agents", label: "Agents", icon: "agents", view: "agents" },
  { href: "/chat", label: "Chat", icon: "chat", view: "chat" },
  { href: "/vault", label: "Vault", icon: "vault", view: "vault" },
  { href: "/settings", label: "Settings", icon: "settings", view: "settings" },
];
const TABS = [
  { href: "/now", label: "Now", icon: "clock", view: "now" },
  { href: "/projects", label: "Projects", icon: "projects", view: "projects" },
  { href: "/chat", label: "Chat", icon: "chat", view: "chat" },
  // Find is the phone's Capsule: one box for files, sessions, agents, memory and asking juno.
  { href: "/find", label: "Find", icon: "search", view: "find" },
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
// A view may take the rail's lower group while it is open (the Vault's places): it dispatches
// deck:rail with the nodes, and the router gives the group back to the pins on the next route.
let railOwned = false;
window.addEventListener("deck:rail", e => { railOwned = true; put(pins, /** @type {CustomEvent} */ (e).detail); });
async function drawRail() {
  const r = await attempt("projects.list");
  if (railOwned) return;
  // Pins open a board on this machine, so a paired Mac's projects (on the box) are not pinned here.
  info.projects = (r.data?.projects || []).filter(p => !isMac(p));
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
  // The owner's own initials when onboarding saved a name, else the machine's.
  put(avatar, initials(r.data?.owner?.name || info.host).slice(0, 2) || "V");
  if (r.data?.owner?.name) avatar.setAttribute("title", r.data.owner.name);
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
        h("span", { class: "small ellipsis", style: { flexGrow: "1" } }, t.name || t.title || t.session),
        machineChip(t),
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
//
// Views stay mounted. Each address gets its own page (a scroller inside #view); leaving it hides
// the page instead of tearing it down, so going back is one frame: the page as it was, scrolled
// where it was, still following its events. A view that wants fresh data on a revisit passes
// ctx.onShow(fn). At most KEEP pages are kept (least recently shown goes first), and a few views
// are never kept: Glass streams a screen, and the Vault can hold a revealed secret on screen.

const KEEP = 8;
const NEVER_KEEP = new Set(["glass", "vault", "missing"]);
/** @type {Map<string, { page: HTMLElement, name: string, leave: () => void, shows: (() => void)[], rail: any, alive: boolean }>} */
const pages = new Map();
let current = "";

/** Off screen but laid out, so coming back costs a paint, not a layout; inert, so no tap or
 * screen reader reaches it. */
function away(/** @type {HTMLElement} */ page, /** @type {boolean} */ off) {
  page.classList.toggle("away", off);
  page.inert = off;
  if (off) page.setAttribute("aria-hidden", "true"); else page.removeAttribute("aria-hidden");
}

function drop(/** @type {string} */ key) {
  const p = pages.get(key);
  if (!p) return;
  pages.delete(key);
  p.alive = false;
  p.leave();
  p.page.remove();
}

async function route() {
  const { view: name, params } = match(location.pathname);
  const key = location.pathname + location.search;
  put(address.lastChild, location.host, h("b", null, location.pathname === "/" ? "/now" : location.pathname));
  for (const a of [...railLinks, ...tabs]) {
    const v = a.getAttribute("data-view");
    a.setAttribute("aria-current", v === name || (name === "needs" && v === "now") || (name === "ask" && v === "find") ? "page" : "false");
    if (a.getAttribute("aria-current") === "false") a.removeAttribute("aria-current");
  }
  pwa.remember(key);
  // The page being left: hidden if kept, else ended. Tapping the tab you are on scrolls it to the top.
  const again = current === key;
  const was = pages.get(current);
  if (was && current !== key) { if (NEVER_KEEP.has(was.name)) drop(current); else away(was.page, true); }
  current = key;
  railOwned = false;
  // The rail is not drawn on a phone (no rail there), which saves a projects.list per tap.
  if (!phone()) drawRail();

  const kept = pages.get(key);
  if (kept) {
    // A revisit: the page as it was, at once; then whatever it asked to refresh, behind it.
    pages.delete(key); pages.set(key, kept); // most recent last
    away(kept.page, false);
    if (again) { kept.page.scrollTo({ top: 0, behavior: "smooth" }); return; }
    put(railLower, kept.rail ?? null);
    for (const f of kept.shows) { try { f(); } catch (e) { console.error(e); } }
    return;
  }

  put(railLower);
  await mount(key, name, params, new URLSearchParams(location.search));
}

/**
 * Make the page for an address and run its view in it. `hidden` mounts it off screen (warm).
 * @param {string} key @param {string} name @param {Record<string, string>} params @param {URLSearchParams} query
 */
async function mount(key, name, params, query, hidden = false) {
  const page = h("div", { class: "page", "data-page": name });
  away(page, hidden);
  view.append(page);
  const offs = /** @type {(() => void)[]} */ ([]);
  const entry = { page, name, shows: /** @type {(() => void)[]} */ ([]), rail: /** @type {any} */ (null), alive: true,
    leave: () => { for (const f of offs.splice(0)) { try { f(); } catch {} } } };
  pages.set(key, entry);
  while (pages.size > KEEP) drop(/** @type {string} */ ([...pages.keys()].find(k => k !== current)));
  const ctx = {
    root: page, params, query,
    on: (type, fn) => { offs.push(on(type, fn)); },
    cleanup: fn => { offs.push(fn); },
    alive: () => entry.alive,
    /** False while the page is kept but not on screen. */
    shown: () => entry.alive && !page.classList.contains("away"),
    /** Run fn each time the user comes back to this page (not on the first visit). */
    onShow: (/** @type {() => void} */ fn) => { entry.shows.push(fn); },
    /** Fill the rail's lower group (between Recent/Pinned and the machine footer). */
    rail: (/** @type {any} */ el) => { entry.rail = el; if (current === key) put(railLower, el); },
  };
  try {
    await style(name);
    const mod = await import(`../views/${name}.js`);
    if (!entry.alive) return;
    await mod.default(ctx);
  } catch (e) {
    if (!entry.alive) return;
    console.error(e);
    put(page, h("div", { style: { padding: "48px 72px" } },
      h("div", { class: "lbl" }, name === "missing" ? "Not found" : "Not built yet"),
      h("h1", { class: "h2", style: { marginTop: "10px" } }, name === "missing" ? "There is nothing at this address." : "This part of the Deck is not here yet."),
      h("p", { class: "muted", style: { marginTop: "8px" } }, link("/now", { class: "link" }, "Back to Now"))));
  }
}
const phone = () => matchMedia("(max-width: 760px)").matches;
// The phone's five tabs, made once while the phone is idle after the first screen, one after
// another, each hidden: the first tap on a tab is then a revisit, one frame. Only on a phone, and
// only for tabs not open yet; each view reads its data once, then follows events as it would.
async function warm() {
  if (!phone()) return;
  for (const t of TABS) {
    if ([...pages.values()].some(p => p.name === t.view) || pages.has(t.href)) continue;
    await mount(t.href, t.view, {}, new URLSearchParams(), true);
    await new Promise(r => setTimeout(r, 50));
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
// onboard.status can be slow (it asks Tailscale and Claude Code on a cold cache), so the Deck waits
// for it at most a moment and never leaves the phone on a blank screen: a late answer that says
// there is no owner yet still sends the page to the onboarding.
(async () => {
  const status = attempt("onboard.status");
  const first = await Promise.race([status, new Promise(r => setTimeout(r, 800, null))]);
  const toOnboard = (/** @type {any} */ st) => st?.data && st.data.owner === false && !fixturesOn;
  if (toOnboard(first)) { location.replace("/onboard"); return; }
  if (!first) status.then(st => { if (toOnboard(st)) location.replace("/onboard"); });
  drawFoot();
  pwa.start({ view, deck });
  route();
  // After the first view has its data: fetch the other tabs' code while the phone is idle.
  ("requestIdleCallback" in window ? /** @type {any} */ (window).requestIdleCallback : (/** @type {any} */ f) => setTimeout(f, 1500))(warm);
  needs.load();
  for (const t of ["ask.raised", "ask.answered", "gate.held", "gate.released", "gate.failed", "gate.rejected"]) on(t, () => needs.load());
  on("project.*", drawRail);
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // A notification tap on an already-open tab: the SW posts the path rather than reloading it.
  navigator.serviceWorker.addEventListener("message", e => {
    if (e.data?.type !== "vyre:navigate" || !e.data.path) return;
    history.pushState(null, "", e.data.path);
    window.dispatchEvent(new Event("deck:navigate"));
  });
}
