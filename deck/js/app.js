// @ts-check
// The Deck's shell: the header, the rail, search, and the router that loads one view at a time
// from deck/views/. Board: DeckNow (header and rail). On a phone (under 760 px, docs/design/phone.md
// section 3) there is no rail and no tab bar: a 48 tall header with the three page labels (Now,
// Chats, Agents), the three pages side by side in a pager you swipe, the Capsule floating at the
// bottom, and every other address pushed over them from the right.
//
// A view is a module in deck/views/ whose default export is `async (ctx) => void`:
//   ctx.root     the empty element to render into
//   ctx.params   route parameters ({ slug, thread, name, id })
//   ctx.query    URLSearchParams of the address
//   ctx.on(type, fn)   an event subscription that ends when the user leaves the view
//   ctx.cleanup(fn)    anything else to undo on leaving (timers)
//   ctx.alive()  false once the user has left, for guarding late async work
// Views never touch the shell; they reach vyred only through js/api.js.

import { h, put, link, go, back, empty, isPhone, PHONE_QUERY } from "./dom.js";
import { attempt, on, fromFixtures, fixturesOn } from "./api.js";
import { icon, mark, wordmark } from "./icons.js";
import * as needs from "./needs.js";
import { when, base, initials } from "./fmt.js";
import * as pwa from "./pwa.js";
// Loaded with the shell, not with Now, so it hears Chrome's one beforeinstallprompt.
import "./phone-setup.js";
import { isMac, machineChip } from "./machine.js";
import { capsule, assistantName } from "./capsule.js";
import { openSheet } from "./sheet.js";
import { installPersonHandler } from "./person.js";
import { badge } from "./status-mark.js";

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
  // `vyre phone add --tailscale-only` points the phone here (views/pair.js).
  ["/pair", "pair"],
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
// The phone's three pages, in pager order. Every other address is pushed over them.
const PAGER = [
  { href: "/now", label: "Now", view: "now" },
  { href: "/chat", label: "Chats", view: "chat" },
  { href: "/agents", label: "Agents", view: "agents" },
];
/** Which page of the pager an address is (0, 1, 2), or -1 for a pushed screen. */
export const slotOf = (/** @type {string} */ key) => PAGER.findIndex(p => p.href === key);

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
  p.view === "now" ? h("span", { class: "count sm-badge", hidden: true }) : null));
const pins = h("div", { class: "rail-pins" });
// A view fills this from ctx.rail(el) (e.g. Vault's places); cleared on every navigation, so a
// view that does not use it leaves the rail exactly as Projects/Agents/etc. already look.
const railLower = h("div", { class: "rail-lower" });
const foot = h("div", { class: "rail-foot" });
const view = h("main", { class: "view", id: "view" });
// ---- the phone's header, pager and Capsule ---------------------------------------------------

const phLabels = PAGER.map((p, i) => h("a", { href: p.href, class: "ph-tab", "data-view": p.view,
  onclick: (/** @type {MouseEvent} */ e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); toPage(i); } }, p.label));
const phBackLabel = h("span", { class: "ph-back-to" }, "Now");
const phBack = h("button", { type: "button", class: "ph-back", "aria-label": "Back", onclick: () => back(lastPage) }, icon("left", 22), phBackLabel);
const phInitial = h("span", { class: "ph-initial", "aria-hidden": "true" }, "V");
const phAvatar = h("button", { type: "button", class: "ph-avatar", "aria-label": "Settings and account", onclick: () => openSettings() }, phInitial);
const phPlus = h("button", { type: "button", class: "ph-plus", "aria-label": "New agent", hidden: true,
  onclick: () => window.dispatchEvent(new Event("deck:new-agent")) }, icon("plus", 22));
const phHead = h("header", { class: "ph-head" },
  h("span", { class: "ph-mark" }, mark(22)), phBack,
  h("nav", { class: "ph-tabs", "aria-label": "Pages" }, phLabels),
  h("div", { class: "ph-grow" }), phPlus, phAvatar);
const slots = PAGER.map(p => h("div", { class: "pager-slot", "data-slot": p.view }));
const pager = h("div", { class: "pager" }, slots);
view.append(pager);
const cap = capsule({ open: words => openFind(words) });

put(deck,
  phHead,
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
  cap.el);

function drawNeeds(list) {
  const n = list.length;
  needsPill.hidden = n === 0;
  put(/** @type {HTMLElement} */ (needsPill.lastChild), `${n} need${n === 1 ? "s" : ""} you`);
  const count = /** @type {HTMLElement | null} */ (railLinks[0].querySelector(".count"));
  if (count) badge(n, count);
  // The phone: the mark's dot takes the attention colour, and Now says how many.
  phHead.toggleAttribute("data-needs", n > 0);
  phLabels[0].setAttribute("aria-label", n ? `Now, ${n} need${n === 1 ? "s" : ""} you` : "Now");
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
  // The phone's avatar is one letter: the owner's initial.
  put(phInitial, initials(r.data?.owner?.name || info.host).slice(0, 1) || "V");
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

const phone = () => isPhone();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- the phone's modes ----------------------------------------------------------------------
//
// "page": one of the three pages, in the pager; the header shows the labels and the Capsule floats.
// "pushed": any other address, slid in from the right over the pager with a back chevron (or the
//   view's own back, see OWN_BACK), no labels and no Capsule.
// "find": the Capsule opened, a full-height sheet risen from the bottom, no header and no Capsule.
// "desk": not the phone layout (wider than 760 px, and not a sideways phone); none of the above applies.

/** Pushed screens that draw their own back control, so the shell's back row stays out of the way. */
function ownBack(/** @type {string} */ name, /** @type {Record<string, string>} */ params) {
  return (name === "chat" && !!(params.thread || params.project)) || name === "needs" || name === "find"
    || (name === "projects" && !!(params.slug || params.thread));
}
/** The page under the pushed screens: where Back goes when history has nothing of the Deck's. */
let lastPage = "/now";
let mode = "desk";
/** The history depth last routed (dom.js go() counts it), to tell a push from a Back. */
let depth = history.state?.deck || 0;
/** Set by the pager when a swipe (not a tap) changed the page: it is already where it should be. */
let fromSwipe = false;
/** Pushed screens stack by z-index, so a page kept from before still lands on top when pushed. */
let z = 2;
/** Hides the screen a push covers, once the push has finished sliding in. */
let covered = /** @type {(() => void) | null} */ (null);

function setMode(/** @type {string} */ m, /** @type {string} */ name, /** @type {Record<string, string>} */ params, /** @type {string} */ key) {
  mode = m;
  deck.dataset.at = m;
  deck.toggleAttribute("data-own-back", m === "pushed" && ownBack(name, params));
  const slot = slotOf(key);
  if (slot >= 0) lastPage = PAGER[slot].href;
  mark_(slot >= 0 ? slot : slotOf(lastPage));
  put(phBackLabel, PAGER[slotOf(lastPage)]?.label || "Now");
  phPlus.hidden = slot !== 2;
  phAvatar.hidden = slot === 2;
}
function mark_(/** @type {number} */ i) {
  phLabels.forEach((a, j) => { if (i === j) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
}

/** Run fn once when el's animation ends (or at once when there is none to wait for). */
function afterAnim(/** @type {HTMLElement} */ el, /** @type {() => void} */ fn) {
  let done = false;
  const once = () => { if (done) return; done = true; fn(); };
  el.addEventListener("animationend", once, { once: true });
  // A page that is hidden or has no animation never fires animationend.
  setTimeout(once, 450);
}

/** Show a page coming in: pushed from the right, Find risen from the bottom, a crossfade under
 * Reduce Motion. A page coming back under a Back is already there, beneath the one leaving. */
function enter(/** @type {HTMLElement} */ page, /** @type {string} */ m, /** @type {boolean} */ backward, /** @type {boolean} */ crossfade) {
  if (m === "pushed" || m === "find") { if (!backward) page.style.zIndex = String(++z); }
  const cls = !phone() ? "" : reduced() ? (m === "page" && !crossfade ? "" : "ph-fade")
    : backward || m === "page" ? "" : m === "find" ? "ph-rise" : "ph-push";
  const hide = covered; covered = null;
  if (!cls) { hide?.(); return; }
  page.classList.add(cls);
  afterAnim(page, () => { page.classList.remove(cls); hide?.(); });
}

/** The screen being left: hidden (or ended) now, or once its own exit or the push over it ends. */
function leave(/** @type {string} */ key, /** @type {{ page: HTMLElement, name: string }} */ was, /** @type {string} */ from, /** @type {string} */ to, /** @type {boolean} */ backward) {
  const hide = () => {
    if (current === key || !pages.has(key)) return;
    was.page.style.transform = "";
    delete was.page.dataset.gone;
    if (NEVER_KEEP.has(was.name)) drop(key); else away(was.page, true);
  };
  const moving = phone() && !reduced() && !was.page.dataset.gone;
  if (moving && backward && (from === "pushed" || from === "find")) {
    // Back from a pushed screen (or Find): it slides away, and what was under it is already there.
    was.page.inert = true;
    const cls = from === "find" ? "ph-sink" : "ph-pop";
    was.page.classList.add(cls);
    afterAnim(was.page, () => { was.page.classList.remove(cls); hide(); });
  } else if (moving && !backward && from === "pushed" && (to === "pushed" || to === "find")) {
    // A push over a push: the one below stays drawn until the new one covers it.
    was.page.inert = true;
    covered = hide;
  } else hide();
}

async function route() {
  // One address per page: "/" is Now, and the header's "+" asks Agents for its form by event.
  if (location.pathname === "/") history.replaceState(history.state, "", "/now" + location.search + location.hash);
  let newAgent = false;
  if (phone() && location.pathname === "/agents" && new URLSearchParams(location.search).get("new") === "1") {
    history.replaceState(history.state, "", "/agents" + location.hash);
    newAgent = true;
  }
  const { view: name, params } = match(location.pathname);
  const key = location.pathname + location.search;
  put(address.lastChild, location.host, h("b", null, location.pathname));
  for (const a of railLinks) {
    const v = a.getAttribute("data-view");
    a.setAttribute("aria-current", v === name || (name === "needs" && v === "now") ? "page" : "false");
    if (a.getAttribute("aria-current") === "false") a.removeAttribute("aria-current");
  }
  pwa.remember(key);
  const d = history.state?.deck || 0;
  const backward = d < depth;
  depth = d;
  const swiped = fromSwipe; fromSwipe = false;
  const slot = slotOf(key);
  const from = mode;
  const to = !phone() ? "desk" : slot >= 0 ? "page" : name === "find" ? "find" : "pushed";
  // The page being left: hidden if kept, else ended. Tapping the label you are on scrolls it to the top.
  const again = current === key;
  const wasKey = current;
  const was = pages.get(current);
  if (was && !again) leave(wasKey, was, from, to, backward);
  // Agents is where the assistant is made or renamed: the Capsule reads its name again after.
  if (wasKey === "/agents" && !again && phone()) drawAssistantName();
  current = key;
  setMode(to, name, params, key);
  railOwned = false;
  // The rail is not drawn on a phone (no rail there), which saves a projects.list per tap.
  if (!phone()) drawRail();
  // The keyboard the Capsule raised belongs to Find; anywhere else it goes down.
  if (to !== "find" && document.activeElement?.classList.contains("cap-proxy")) /** @type {HTMLElement} */ (document.activeElement).blur();
  // Back on the pager: slide (or jump) it to the page. A swipe put it there already.
  if (to === "page" && !swiped) toSlot(slot, from === "page" && !again && !reduced());
  const crossfade = to === "page" && from === "page" && !again && !swiped;

  const kept = pages.get(key);
  if (kept) {
    // A revisit: the page as it was, at once; then whatever it asked to refresh, behind it.
    pages.delete(key); pages.set(key, kept); // most recent last
    away(kept.page, false);
    if (again) { kept.page.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); return; }
    if (to === "pushed" || to === "find" || crossfade) enter(kept.page, to, backward, crossfade);
    else { covered?.(); covered = null; }
    put(railLower, kept.rail ?? null);
    for (const f of kept.shows) { try { f(); } catch (e) { console.error(e); } }
    if (newAgent) window.dispatchEvent(new Event("deck:new-agent"));
    return;
  }

  put(railLower);
  const made = mount(key, name, params, new URLSearchParams(location.search), false, newAgent);
  const entry = pages.get(key);
  if (entry && (to === "pushed" || to === "find" || crossfade)) enter(entry.page, to, backward, crossfade);
  await made;
}

/**
 * Make the page for an address and run its view in it. `hidden` mounts it off screen (warm).
 * @param {string} key @param {string} name @param {Record<string, string>} params @param {URLSearchParams} query
 */
async function mount(key, name, params, query, hidden = false, newAgent = false) {
  const page = h("div", { class: "page", "data-page": name });
  away(page, hidden);
  place(key, page);
  const offs = /** @type {(() => void)[]} */ ([]);
  const entry = { page, name, shows: /** @type {(() => void)[]} */ ([]), rail: /** @type {any} */ (null), alive: true,
    leave: () => { for (const f of offs.splice(0)) { try { f(); } catch {} } } };
  pages.set(key, entry);
  // The three pages are never the ones let go on a phone: they sit side by side in the pager.
  while (pages.size > KEEP) {
    const k = [...pages.keys()].find(k => k !== current && !(phone() && slotOf(k) >= 0));
    if (!k) break;
    drop(k);
  }
  const ctx = {
    root: page, params, query: newAgent ? new URLSearchParams("new=1") : query,
    on: (type, fn) => { offs.push(on(type, fn)); },
    cleanup: fn => { offs.push(fn); },
    alive: () => entry.alive,
    /** False while the page is kept but not on screen (a page beside it in the pager included). */
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

/** Where a page lives: its slot in the pager on a phone, else straight in #view. */
function place(/** @type {string} */ key, /** @type {HTMLElement} */ page) {
  const slot = slotOf(key);
  const parent = phone() && slot >= 0 ? slots[slot] : view;
  if (page.parentElement !== parent) parent.append(page);
}

// ---- the pager -------------------------------------------------------------------------------
//
// Native horizontal scroll with snapping: it follows the finger and snaps as the platform does.
// A swipe that settles on another page swaps the address in place (replaceState: pages are not
// history). A gesture that starts in a row that swipes ([data-swipe]), a field, or anything that
// scrolls sideways itself locks the pager for that touch. Under Reduce Motion the pager does not
// slide at all: a clear horizontal flick crossfades to the next page instead.

function toSlot(/** @type {number} */ i, /** @type {boolean} */ smooth) {
  const left = i * pager.clientWidth;
  if (Math.abs(pager.scrollLeft - left) < 2) return;
  pager.scrollTo({ left, behavior: smooth ? "smooth" : /** @type {ScrollBehavior} */ ("instant") });
}
/** A label tap: the page, without a history entry. */
function toPage(/** @type {number} */ i) {
  const href = PAGER[i].href;
  if (location.pathname + location.search !== href) history.replaceState(history.state, "", href);
  route();
}
function settle() {
  if (mode !== "page" || !pager.clientWidth) return;
  const i = Math.max(0, Math.min(PAGER.length - 1, Math.round(pager.scrollLeft / pager.clientWidth)));
  if (PAGER[i].href === current) return;
  fromSwipe = true;
  history.replaceState(history.state, "", PAGER[i].href);
  route();
}
let settleT = 0;
pager.addEventListener("scroll", () => {
  // The label under the finger lights as the pages move.
  if (mode === "page" && pager.clientWidth) mark_(Math.round(pager.scrollLeft / pager.clientWidth));
  if (!("onscrollend" in window)) { clearTimeout(settleT); settleT = window.setTimeout(settle, 120); }
}, { passive: true });
pager.addEventListener("scrollend", settle, { passive: true });
new ResizeObserver(() => { if (mode === "page") toSlot(slotOf(current), false); }).observe(pager);

/** True when the touch began somewhere that swipes sideways on its own. */
function ownsSideways(/** @type {EventTarget | null} */ t) {
  const el = /** @type {HTMLElement | null} */ (t instanceof Element ? t : null);
  if (!el) return false;
  if (el.closest("[data-swipe], input, textarea, select, [contenteditable], .no-page-swipe")) return true;
  for (let n = /** @type {HTMLElement | null} */ (el); n && n !== pager; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && n.classList.contains("page") === false) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}
/** @type {{ x: number, y: number } | null} */ let flick = null;
pager.addEventListener("touchstart", e => {
  flick = null;
  if (e.touches.length !== 1) return;
  if (ownsSideways(e.target)) { pager.classList.add("locked"); return; }
  flick = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
const unlock = (/** @type {TouchEvent} */ e) => {
  pager.classList.remove("locked");
  const f = flick; flick = null;
  if (!f || !reduced() || e.type !== "touchend" || mode !== "page") return;
  const t = e.changedTouches[0];
  const dx = t.clientX - f.x, dy = t.clientY - f.y;
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const i = slotOf(current) + (dx < 0 ? 1 : -1);
  if (i >= 0 && i < PAGER.length) toPage(i);
};
pager.addEventListener("touchend", unlock, { passive: true });
pager.addEventListener("touchcancel", unlock, { passive: true });

// ---- edge swipe back -------------------------------------------------------------------------
// A pushed screen follows a finger that starts at the left edge, and goes back past a third of
// the width (or on a quick flick); short of that it springs back.

/** @type {{ x: number, y: number, t: number, page: HTMLElement, dx: number, axis: string } | null} */ let edge = null;
view.addEventListener("touchstart", e => {
  edge = null;
  if (mode !== "pushed" || e.touches.length !== 1 || e.touches[0].clientX > 24) return;
  const page = pages.get(current)?.page;
  if (page) edge = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp, page, dx: 0, axis: "" };
}, { passive: true });
view.addEventListener("touchmove", e => {
  if (!edge) return;
  const dx = e.touches[0].clientX - edge.x, dy = e.touches[0].clientY - edge.y;
  if (!edge.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) edge.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
  if (edge.axis !== "x") return;
  edge.dx = Math.max(0, dx);
  edge.page.classList.add("ph-drag");
  if (!reduced()) edge.page.style.transform = `translateX(${edge.dx}px)`;
}, { passive: true });
const edgeEnd = (/** @type {TouchEvent} */ e) => {
  const g = edge; edge = null;
  if (!g || g.axis !== "x") return;
  g.page.classList.remove("ph-drag");
  const quick = g.dx > 40 && g.dx / Math.max(1, e.timeStamp - g.t) > 0.5;
  if (e.type === "touchend" && (g.dx > view.clientWidth / 3 || quick)) {
    g.page.dataset.gone = "1";
    if (reduced()) { back(lastPage); return; }
    g.page.classList.add("ph-settle");
    g.page.style.transform = "translateX(100%)";
    let went = false;
    const go_ = () => { if (went) return; went = true; g.page.classList.remove("ph-settle"); back(lastPage); };
    g.page.addEventListener("transitionend", go_, { once: true });
    setTimeout(go_, 300);
  } else {
    g.page.classList.add("ph-settle");
    g.page.style.transform = "";
    g.page.addEventListener("transitionend", () => g.page.classList.remove("ph-settle"), { once: true });
  }
};
view.addEventListener("touchend", edgeEnd, { passive: true });
view.addEventListener("touchcancel", edgeEnd, { passive: true });

// Crossing into or out of the phone layout (a rotation, a window resize): the three pages move into or out of the pager.
matchMedia(PHONE_QUERY).addEventListener("change", () => {
  for (const [k, p] of pages) place(k, p.page);
  route();
});

// ---- Find, Settings --------------------------------------------------------------------------

/** The Capsule opened: Find, with the keyboard up; dictated words go into its box, unsent. */
function openFind(/** @type {string | undefined} */ words) {
  const kept = pages.get("/find");
  if (words && !kept) { go("/find?q=" + encodeURIComponent(words)); return; }
  if (mode !== "find") go("/find");
  const input = /** @type {HTMLInputElement | null} */ (pages.get("/find")?.page.querySelector("#fd-in") || null);
  if (!input) return;
  if (words) { input.value = words; input.dispatchEvent(new Event("input")); }
  input.focus({ preventScroll: true });
}

/** Settings, from the avatar: the Settings view drawn inside a sheet (js/sheet.js). */
function openSettings() {
  const offs = /** @type {(() => void)[]} */ ([]);
  let alive = true;
  const s = openSheet({ title: "Settings", build(body) {
    body.classList.add("ph-settings");
    put(body, h("div", { class: "empty" }, "Loading."));
    Promise.all([import("../views/settings.js"), style("settings")]).then(([mod]) => {
      if (!alive) return;
      put(body);
      return mod.default({ root: body, params: {}, query: new URLSearchParams(), alive: () => alive, shown: () => alive,
        on: (/** @type {string} */ t, /** @type {any} */ fn) => { offs.push(on(t, fn)); }, cleanup: (/** @type {() => void} */ fn) => { offs.push(fn); },
        onShow: () => {}, rail: () => {} });
    }).catch(e => { if (alive) put(body, empty("Settings did not load.", e)); });
  }, onClose() {
    alive = false;
    for (const f of offs.splice(0)) { try { f(); } catch {} }
    window.removeEventListener("deck:navigate", shut);
    window.removeEventListener("popstate", shut);
  } });
  // A link inside Settings goes somewhere else: the sheet steps aside for it.
  const shut = () => s.close();
  window.addEventListener("deck:navigate", shut);
  window.addEventListener("popstate", shut);
}

/** The Capsule's placeholder names the assistant: read once, and again after a visit to Agents. */
async function drawAssistantName() {
  const r = await attempt("agents.list");
  cap.name(assistantName(r.data));
}

// The phone's three pages and Find, made once while the phone is idle after the first screen, one
// after another, each hidden: the first swipe to a page is then a revisit, one frame. Only on a
// phone, and only for pages not open yet; each view reads its data once, then follows events.
async function warm() {
  if (!phone()) return;
  for (const t of [...PAGER, { href: "/find", view: "find" }]) {
    if (pages.has(t.href)) continue;
    await mount(t.href, t.view, {}, new URLSearchParams(), true);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** Each view has its own stylesheet, css/views/<name>.css, added once, before it first renders. */
const styled = new Map();
/** A view whose stylesheet has another name (css/pair.css is the Mac pairing card's). */
const CSS_NAME = { pair: "pair-phone" };
function style(name) {
  if (name === "missing") return Promise.resolve();
  if (!styled.has(name)) styled.set(name, new Promise(resolve => {
    const l = h("link", { rel: "stylesheet", href: `/css/views/${CSS_NAME[name] || name}.css` });
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
  // A box that asks for a person session gets a sign-in sheet, and the call goes again once.
  installPersonHandler();
  // What needed the user last time, from this device, while the box is asked (ADR 0029 R3).
  void needs.restore();
  const status = attempt("onboard.status");
  const first = await Promise.race([status, new Promise(r => setTimeout(r, 800, null))]);
  const toOnboard = (/** @type {any} */ st) => st?.data && st.data.owner === false && !fixturesOn;
  if (toOnboard(first)) { location.replace("/onboard"); return; }
  if (!first) status.then(st => { if (toOnboard(st)) location.replace("/onboard"); });
  drawFoot();
  pwa.start({ view, deck });
  const needsFirst = needs.load();
  // A cold launch from the home screen reopens where the user was, unless something needs them:
  // then it stays on Now. The needs answer is waited for only a moment.
  const again = pwa.reopen();
  if (again) {
    const r = await Promise.race([needsFirst, new Promise(res => setTimeout(res, 700, null))]);
    if (!(/** @type {any} */ (r)?.items?.length)) history.replaceState(null, "", again);
  }
  route();
  if (phone()) drawAssistantName();
  // After the first view has its data: fetch the other pages' code while the phone is idle.
  ("requestIdleCallback" in window ? /** @type {any} */ (window).requestIdleCallback : (/** @type {any} */ f) => setTimeout(f, 1500))(warm);
  // needs.hear keeps each raised ask until answered, so a push's /needs/<ask> opens even before the list has it.
  for (const t of ["ask.raised", "ask.answered", "ask.cancelled"]) on(t, e => { needs.hear(e); if (t !== "ask.cancelled") needs.load(); });
  for (const t of ["gate.held", "gate.released", "gate.failed", "gate.rejected"]) on(t, () => needs.load());
  on("project.*", drawRail);
})();

// Back after the phone slept a while, on one of the pages, with something waiting: Now. The
// count is the one events keep; nothing is fetched for this.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 300_000 && mode === "page" && current !== "/now" && needs.current().length) toPage(0);
  hiddenAt = 0;
});

if ("serviceWorker" in navigator) {
  // updateViaCache none: the browser asks the box for sw.js on every launch, so a release (a new
  // BUILD in it) installs now. When that new worker takes over a page that already had one, the
  // page reloads at once if nobody has touched it yet, and otherwise the next time it is hidden,
  // so a release never mixes old and new modules under someone's finger.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  let touched = false;
  const touch = () => { touched = true; };
  addEventListener("pointerdown", touch, { once: true, passive: true });
  addEventListener("keydown", touch, { once: true, passive: true });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    if (!touched || document.visibilityState === "hidden") { location.reload(); return; }
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") location.reload(); });
  });
  // A notification tap on an already-open tab: the SW posts the path rather than reloading it.
  navigator.serviceWorker.addEventListener("message", e => {
    if (e.data?.type !== "vyre:navigate" || !e.data.path) return;
    history.pushState(null, "", e.data.path);
    window.dispatchEvent(new Event("deck:navigate"));
  });
}
