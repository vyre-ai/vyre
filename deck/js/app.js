// @ts-check
// The Deck's shell: the rail, the header, search, and the router that loads one view at a time
// from deck/views/. From 720 px up the rail (js/rail.js) is a 72 px column on the left, and the
// header, a view's own list column and the view sit to its right. On a phone (under 720 px,
// docs/design/phone.md section 3) there is no rail: a 48 tall header (the mark, the page's title, search,
// the avatar), the four pages (Now, Chat, Projects, Agents) side by side in a pager you swipe, Lumen
// floating above a glass tab bar of five (the four and More), and every other address pushed over them
// from the right. The tab bar's More and the avatar open the More sheet (js/more.js): Memory, Vault,
// Drive, Planner, Devices, Settings. v2 of the phone shell (team/0.2.2/ux-prototype.html).
//
// A view is a module in deck/views/ whose default export is `async (ctx) => void`:
//   ctx.root     the empty element to render into
//   ctx.params   route parameters ({ slug, thread, name, id })
//   ctx.query    URLSearchParams of the address
//   ctx.on(type, fn)   an event subscription that ends when the user leaves the view
//   ctx.cleanup(fn)    anything else to undo on leaving (timers)
//   ctx.alive()  false once the user has left, for guarding late async work
// Views never touch the shell; they reach vyred only through js/api.js.

import { h, put, link, go, back, isPhone, PHONE_QUERY } from "./dom.js";
import { attempt, on, onResume, fromFixtures, fixturesOn, canProve, onDeviceRemoved } from "./api.js";
import { icon, mark } from "./icons.js";
import * as needs from "./needs.js";
import { initials } from "./fmt.js";
import * as pwa from "./pwa.js";
// Loaded with the shell, not with Now, so it hears Chrome's one beforeinstallprompt.
import "./phone-setup.js";
import { isMac } from "./machine.js";
import { capsule, assistantName } from "./capsule.js";
import { openSheet } from "./sheet.js";
import { installPersonHandler } from "./person.js";
import { offerEnroll } from "./enroll-grant.js";
import { watchRemoval } from "./wipe.js";
import { enrollPasskey } from "./phone-setup.js";
import { rail, placeForKey } from "./rail.js";
import { installRows } from "./rows.js";
import * as trace from "./trace.js";
import { skeleton as kitSkeleton } from "./states.js";
import { fillMore } from "./more.js";
import { haptic } from "./haptics.js";
import { watchHealth, linkLine } from "./health.js";
import { followTheme, deviceId } from "./theme-live.js";
import { installAvatars, setIdentity, personAvatar } from "./avatars.js";
import { checkBuild } from "./build-check.js";
import { installed, mac } from "./platform.js";
import { createCmdBar } from "./cmdbar.js";
import { createAvatarCards } from "./avatar-card.js";
import { messageHit, openMessageDetails } from "./message-details.js";
import { reportContext } from "./context-report.js";
import { homePath } from "./home.js";
import { installTrustAsk } from "./trust-ask.js";

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
  ["/quick", "quick"],
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
  // An artifact an agent made, full screen (views/artifact.js).
  ["/a/:id", "artifact"],
  // The box's shared folders, browsed from a phone (views/files.js).
  ["/files", "files"],
  ["/files/:share", "files"],
  // Drive is where a person looks for it (#51): /drive works as a bookmark and after a reload, like the rail link.
  ["/drive", "files"],
  ["/drive/:share", "files"],
  ["/planner", "planner"],
  // A planner push notification opens /planner/<firing> (ADR 0025).
  ["/planner/:firing", "planner"],
  // `vyre phone add --tailscale-only` points the phone here (views/pair.js).
  ["/pair", "pair"],
  // Scan your avatar to pair your phone (ADR 0037, "Wink"): phone.vyre.run points here
  // (views/wink.js, js/pair-scan.js's sheet).
  ["/pair/scan", "wink"],
];
// The places and their order are the rail's (js/rail.js PLACES).
// The phone's four pages, in pager order, each a tab of the glass tab bar (the fifth tab is More).
// Every other address is pushed over them.
const PAGER = [
  { href: "/now", label: "Now", view: "now", icon: "now" },
  { href: "/chat", label: "Chat", view: "chat", icon: "chat" },
  { href: "/projects", label: "Projects", view: "projects", icon: "projects" },
  { href: "/agents", label: "Agents", view: "agents", icon: "agents" },
];
/** @type {{ href: string, label: string, view: string, icon: string, key?: string }[]} */
const strip = [...PAGER];
const keyOf = (/** @type {{ href: string, key?: string }} */ p) => p.key || p.href;
/** Which page of the pager an address is (0 to 3), or -1 for a pushed screen. */
export const slotOf = (/** @type {string} */ key) => strip.findIndex(p => keyOf(p) === key);

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
const info = { projects: /** @type {any[]} */ ([]) };

// ---- shell ---------------------------------------------------------------------------------

// Sample data stands in for a module that is not merged yet: said once, quietly, in the header.
const fixtureNote = h("span", { class: "fixture-note", hidden: true }, "Sample data for modules not merged yet");
installRows();
try { if (localStorage.getItem("vyre.rail") === "labels") document.documentElement.dataset.rail = "labels"; } catch {}
const cmd = createCmdBar();
const railEl = rail({ onSearch: () => cmd.open() });
// The list column, right of the rail: a view's own list (ctx.rail, e.g. Chat's sessions; the
// deck:rail event, e.g. Vault's places), or the pinned and recent projects beside a project.
// Hidden while empty, so a view that has no list gets the whole width.
const pins = h("div", { class: "rail-pins" });
const railLower = h("div", { class: "rail-lower-in" });
const side = h("aside", { class: "rail-lower", "aria-label": "List", hidden: true }, pins, railLower);
const sideSync = () => { side.hidden = !pins.childNodes.length && !railLower.childNodes.length; };
const view = h("main", { class: "view", id: "view" });
// ---- the phone's header, pager and Lumen ---------------------------------------------------

const tab = (/** @type {typeof strip[number]} */ p, /** @type {number} */ i) => h("a", { href: p.href, class: "tb-item", "data-view": p.view,
  onclick: (/** @type {MouseEvent} */ e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); haptic("tick"); toPage(i); } },
  icon(/** @type {any} */ (p.icon), 24), h("span", { class: "tb-label" }, p.label));
const phLabels = strip.map(tab);
const phBackLabel = h("span", { class: "ph-back-to" }, "Now");
const phBack = h("button", { type: "button", class: "ph-back", "aria-label": "Back", onclick: () => back(lastPage) }, icon("left", 22), phBackLabel);
const phInitial = h("span", { class: "ph-initial", "aria-hidden": "true" }, "V");
const phAvatar = h("button", { type: "button", class: "ph-avatar", "aria-label": "More and account", "aria-haspopup": "dialog", onclick: () => openMore() }, phInitial);
const phPlus = h("button", { type: "button", class: "ph-plus", "aria-label": "New agent", hidden: true,
  onclick: () => window.dispatchEvent(new Event("deck:new-agent")) }, icon("plus", 22));
const phSearch = h("button", { type: "button", class: "ph-search", "aria-label": "Search", onclick: () => openFind(undefined) }, icon("search", 22));
const phTitle = h("h1", { class: "ph-title" }, "Now");
const moreTab = h("button", { type: "button", class: "tb-item tb-more", "aria-label": "More", "aria-haspopup": "dialog", onclick: () => { haptic("tick"); openMore(); } },
  icon("more", 24), h("span", { class: "tb-label" }, "More"));
const tabBar = h("nav", { class: "tabbar", "aria-label": "Pages" }, phLabels, moreTab);
const phHead = h("header", { class: "ph-head" },
  h("span", { class: "ph-mark" }, mark(22)), phBack,
  phTitle,
  h("div", { class: "ph-grow" }), phPlus, phSearch, phAvatar);
const slots = strip.map(p => h("div", { class: "pager-slot", "data-slot": p.view }));
const pager = h("div", { class: "pager" }, slots);
view.append(pager);
const cap = capsule({ open: words => openFind(words) });

put(deck,
  phHead,
  h("div", { class: "body" },
    railEl.el,
    h("div", { class: "stage" },
      h("div", { class: "shell-note" }, fixtureNote),
      h("div", { class: "panes" }, side, view))),
  cap.el,
  tabBar);

function drawNeeds() {
  // waiting's one count where the box has it (reminders and pairings included), else the list's.
  const n = needs.count();
  railEl.setNeeds(n);
  // The phone: the mark's dot takes the attention colour, and Now says how many.
  phHead.toggleAttribute("data-needs", n > 0);
  phLabels[0].setAttribute("aria-label", n ? `Now, ${n} need${n === 1 ? "s" : ""} you` : "Now");
  // The tab's badge: the count, nothing else on the bar carries one.
  if (n) phLabels[0].dataset.count = n > 9 ? "9+" : String(n); else delete phLabels[0].dataset.count;
}
needs.watch(drawNeeds);

function pinned() {
  try { return JSON.parse(localStorage.getItem("vyre.pins") || "[]"); } catch { return []; }
}
// A view may take the list column while it is open (the Vault's places): it dispatches deck:rail
// with the nodes, and the router gives the column back on the next route.
let railOwned = false;
window.addEventListener("deck:rail", e => { railOwned = true; side.classList.remove("rail-projects"); put(pins, /** @type {CustomEvent} */ (e).detail); sideSync(); });
/** Pinned and recent projects, in the list column beside a project's board or thread. */
const ON_PROJECT = /^\/(projects\/[^/]+|threads\/)/;
async function drawRail() {
  if (!ON_PROJECT.test(location.pathname)) { if (!railOwned) { side.classList.remove("rail-projects"); put(pins); sideSync(); } return; }
  const r = await attempt("projects.list", {}, { share: true });
  if (railOwned || !ON_PROJECT.test(location.pathname)) return;
  // Pins open a board on this machine, so a paired Mac's projects (on the box) are not pinned here.
  info.projects = (r.data?.projects || []).filter(p => !isMac(p));
  const pins_ = pinned();
  const chosen = pins_.length ? pins_.map(s => info.projects.find(p => p.slug === s)).filter(Boolean)
    : [...info.projects].sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 4);
  const here = location.pathname.split("/")[2];
  side.classList.toggle("rail-projects", chosen.length > 0);
  put(pins, chosen.length ? h("div", { class: "lbl", style: { padding: "0 10px 8px" } }, pins_.length ? "Pinned" : "Recent") : null,
    chosen.map(p => link(`/projects/${encodeURIComponent(p.slug)}`, { class: "pin-a", "aria-current": location.pathname.startsWith("/projects/") && here === p.slug ? "page" : false },
      h("span", { class: "sq" }), h("span", { class: "ellipsis" }, p.name))));
  sideSync();
}
window.addEventListener("deck:pins", drawRail);

async function drawFoot() {
  const r = await attempt("system.info");
  if (!r.error) setIdentity(r.data || {});
  const host = r.data?.host || location.hostname;
  // The owner's initial when onboarding saved a name, else the machine's; the rail's avatar is
  // named for the person ("Account" until there is a name).
  const letter = initials(r.data?.owner?.name || host).slice(0, 1) || "V";
  // The person's own avatar on the rail's account button and the phone header (ADR 0043).
  railEl.setOwner(r.data?.owner?.name || null, letter, r.error ? null : personAvatar({ size: 32 }));
  owner = { name: r.data?.owner?.name || null, letter };
  put(phInitial, r.error ? letter : personAvatar({ size: 34 }));
  fixtureNote.hidden = !fromFixtures.size;
  if (fromFixtures.size) fixtureNote.setAttribute("title", [...fromFixtures].join(", "));
}
window.addEventListener("deck:fixture", () => { clearTimeout(footT); footT = window.setTimeout(drawFoot, 200); });
let footT = 0;
/** The person the avatar is, for the Places sheet's head (system.info owner.name). */
let owner = { name: /** @type {string | null} */ (null), letter: "V" };

// ---- search --------------------------------------------------------------------------------

/** Recall marks matches with «»; shown in Bone against Stone, as text nodes only. */
export function snippet(/** @type {any} */ s) {
  return String(s || "").split(/(«[^»]*»)/).map(part => part.startsWith("«") ? h("span", { style: { color: "var(--text)" } }, part.slice(1, -1)) : part);
}
// The command bar (js/cmdbar.js): Cmd or Ctrl K from anywhere, and the rail's Search button.
document.addEventListener("keydown", cmd.onGlobalKey);
// An avatar nods and opens its card; the avatar, name or time of a message opens that message's details.
const cards = createAvatarCards();
document.addEventListener("click", e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const row = messageHit(e.target);
  if (row) { openMessageDetails(row); return; }
  cards.onClick(e);
});
// Cmd+1 to Cmd+9 (Ctrl off a Mac): the rail's places in order, never while typing in a field. The
// phone has no rail, so no rail keys.
const MAC = mac();
document.addEventListener("keydown", e => {
  // In a browser tab these chords switch the browser's own tabs; only an installed window takes them.
  if (phone() || !installed()) return;
  const href = placeForKey(e, MAC);
  if (!href) return;
  e.preventDefault();
  if (location.pathname + location.search + location.hash !== href) go(href);
});

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
// "page": one of the three pages, in the pager; the header shows the labels and Lumen floats.
// "pushed": any other address, slid in from the right over the pager with a back chevron (or the
//   view's own back, see OWN_BACK), no labels and no Lumen.
// "find": Lumen opened, a full-height sheet risen from the bottom, no header and no Lumen.
// "desk": not the phone layout (wider than 760 px, and not a sideways phone); none of the above applies.

/** Pushed screens that draw their own back control, so the shell's back row stays out of the way. */
function ownBack(/** @type {string} */ name, /** @type {Record<string, string>} */ params) {
  return (name === "chat" && !!(params.thread || params.project)) || name === "needs" || name === "find"
    || (name === "projects" && !!params.slug);
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
  if (slot >= 0) lastPage = strip[slot].href;
  mark_(slot >= 0 ? slot : slotOf(keyOf(strip.find(p => p.href === lastPage) || { href: lastPage })));
  put(phBackLabel, strip.find(p => p.href === lastPage)?.label || "Now");
  phPlus.hidden = slot !== 3;
  phAvatar.hidden = slot === 3;
}
let marked = -1;
function mark_(/** @type {number} */ i) {
  phLabels.forEach((a, j) => { if (i === j) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (i === marked) return;
  marked = i;
  // The header's title is the page's own name; the tab bar says where you are, the title says what it is.
  if (strip[i]) put(phTitle, strip[i].label);
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
  // "/" is the assistant's current thread (js/home.js), else Now; the header's "+" asks Agents for its form by event.
  if (location.pathname === "/") history.replaceState(history.state, "", (await homePath(attempt)) + location.search + location.hash);
  let newAgent = false;
  if (phone() && location.pathname === "/agents" && new URLSearchParams(location.search).get("new") === "1") {
    history.replaceState(history.state, "", "/agents" + location.hash);
    newAgent = true;
  }
  // Projects never draws a conversation: a chat opens in Chat, scoped to its project (#47). The old addresses still work and go there.
  {
    const m = /^\/projects\/([^/]+)\/([^/]+)\/?$/.exec(location.pathname), t = /^\/threads\/([^/]+)\/?$/.exec(location.pathname);
    // Devices is a part of Settings: /devices is its address (#51).
    const to = m ? `/chat/${m[1]}/${m[2]}` : t ? `/chat/thread/${t[1]}` : /^\/devices\/?$/.test(location.pathname) ? "/settings#devices" : null;
    if (to) history.replaceState(history.state, "", to.includes("#") ? to : to + location.search + location.hash);
  }
  const { view: name, params } = match(location.pathname);
  trace.routeStart(location.pathname + location.search, name);
  // /quick is the hotkey panel: the compact ask alone, no rail (css/views/quick.css reads this).
  document.documentElement.dataset.quick = name === "quick" ? "1" : "";
  const key = location.pathname + location.search;
  railEl.setCurrent(name, location.hash);
  // A detail (a session, a project's board or thread): under 900 it takes the list column's place.
  deck.toggleAttribute("data-detail", (name === "chat" && !!params.thread) || (name === "projects" && !!(params.slug || params.thread)));
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
  // The new address is current before the old page is let go: leave() hides a page only while it
  // is not the current one, so a desk navigation (no animation to wait for) really hides it.
  current = key;
  if (was && !again) leave(wasKey, was, from, to, backward);
  // Agents is where the assistant is made or renamed: Lumen reads its name again after.
  if (wasKey === "/agents" && !again && phone()) drawAssistantName();
  setMode(to, name, params, key);
  railOwned = false;
  // The rail is not drawn on a phone (no rail there), which saves a projects.list per tap.
  if (!phone()) drawRail();
  // The keyboard Lumen raised belongs to Find; anywhere else it goes down.
  if (to !== "find" && document.activeElement?.classList.contains("cap-proxy")) /** @type {HTMLElement} */ (document.activeElement).blur();
  // Back on the pager: slide (or jump) it to the page. A swipe put it there already.
  if (to === "page" && !swiped) toSlot(slot, from === "page" && !again && !reduced());
  const crossfade = to === "page" && from === "page" && !again && !swiped;

  const kept = pages.get(key);
  if (kept) {
    // A revisit: the page as it was, at once; then whatever it asked to refresh, behind it.
    pages.delete(key); pages.set(key, kept); // most recent last
    away(kept.page, false);
    // Settings to Settings#devices is the same page: it scrolls to the section (its onShow) instead.
    if (again && !location.hash) { kept.page.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); return; }
    if (again) { for (const f of kept.shows) { try { f(); } catch (e) { console.error(e); } } return; }
    if (to === "pushed" || to === "find" || crossfade) enter(kept.page, to, backward, crossfade);
    else { covered?.(); covered = null; }
    put(railLower, kept.rail ?? null);
    sideSync();
    for (const f of kept.shows) { try { f(); } catch (e) { console.error(e); } }
    if (newAgent) window.dispatchEvent(new Event("deck:new-agent"));
    return;
  }

  put(railLower);
  sideSync();
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
  // The frame is on screen in the same frame as the tap: a quiet placeholder until the view's code and data arrive, so nothing is ever blank.
  if (!hidden) { page.append(skeleton()); trace.mark("frame"); }
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
    /** Fill the list column right of the rail (Chat's sessions). */
    rail: (/** @type {any} */ el) => { entry.rail = el; if (current === key) { put(railLower, el); sideSync(); } },
  };
  // An address nothing serves (#51): the plain "not found" page, with no request for a view file that does not exist.
  if (name === "missing") {
    put(page, h("div", { style: { padding: "48px 72px" } },
      h("div", { class: "lbl" }, "Not found"),
      h("h1", { class: "h2", style: { marginTop: "10px" } }, "There is nothing at this address."),
      h("p", { class: "muted", style: { marginTop: "8px" } }, link("/now", { class: "link" }, "Back to Now"))));
    return;
  }
  try {
    // The stylesheet and the view's code are asked for together, not one after the other: two round trips become one.
    const [, mod] = await Promise.all([style(name).then(() => trace.mark("css")), import(`../views/${name}.js`).then(m => { trace.mark("code"); return m; })]);
    if (!entry.alive) return;
    await mod.default(ctx);
    page.querySelector("[data-skel]")?.remove();
    trace.mark("draw");
  } catch (e) {
    if (!entry.alive) return;
    // The view's file did not arrive (the box out of reach before the service worker kept it):
    // say so, and mount it again once the stream is back, instead of calling it not built.
    if (unfetched(e)) { waitForBox(key, entry, page); return; }
    console.error(e);
    put(page, h("div", { style: { padding: "48px 72px" } },
      h("div", { class: "lbl" }, name === "missing" ? "Not found" : "Not built yet"),
      h("h1", { class: "h2", style: { marginTop: "10px" } }, name === "missing" ? "There is nothing at this address." : "This part of the Deck is not here yet."),
      h("p", { class: "muted", style: { marginTop: "8px" } }, link("/now", { class: "link" }, "Back to Now"))));
  }
}

/** The placeholder a page shows until its view has drawn: the state kit's skeleton rows (js/states.js). */
function skeleton() {
  const el = kitSkeleton(6);
  el.setAttribute("data-skel", "");
  el.classList.add("page-skel");
  return el;
}

// ---- warming: a link about to be used has its view ready ----------------------------------------
// Pointing at an internal link (or touching it, or focusing it) fetches that screen's stylesheet and code, so the tap that follows has them
// already. Once per screen; a failure is nothing (the real navigation asks again and says why).
const warmed = new Set();
function warmLink(/** @type {EventTarget|null} */ t) {
  const a = /** @type {HTMLAnchorElement|null} */ (/** @type {any} */ (t)?.closest?.("a[href]"));
  if (!a || a.target === "_blank" || a.origin !== location.origin) return;
  const { view: name } = match(a.pathname);
  if (!name || name === "missing" || warmed.has(name)) return;
  warmed.add(name);
  void style(name);
  void import(`../views/${name}.js`).catch(() => warmed.delete(name));
}
document.addEventListener("pointerover", e => { if (/** @type {PointerEvent} */ (e).pointerType !== "touch") warmLink(e.target); }, { passive: true });
document.addEventListener("pointerdown", e => { trace.pressed(); warmLink(e.target); }, { passive: true, capture: true });
document.addEventListener("touchstart", e => { trace.pressed(); warmLink(e.target); }, { passive: true });
document.addEventListener("focusin", e => warmLink(e.target));

/** A module that failed to load over the network (Chrome, Firefox, Safari word it differently). @param {any} e */
const unfetched = e => e instanceof TypeError && /dynamically imported module|module script failed|error loading dynamically imported/i.test(String(e.message));

/** A page whose view could not be fetched: one quiet line, and a fresh mount when the box answers again.
 * @param {string} key @param {{ alive: boolean }} entry @param {HTMLElement} page */
function waitForBox(key, entry, page) {
  put(page, h("div", { class: "page-wait", role: "status" }, h("p", { class: "muted" }, "This page loads when your box answers.")));
  const back = (/** @type {Event} */ ev) => {
    if (ev.type === "deck:stream" && /** @type {CustomEvent} */ (ev).detail?.state !== "open") return;
    window.removeEventListener("deck:stream", back);
    window.removeEventListener("online", back);
    if (!entry.alive || pages.get(key) !== entry) return;
    drop(key);
    if (current === key) void route();
  };
  window.addEventListener("deck:stream", back);
  window.addEventListener("online", back);
}

/** Where a page lives: its slot in the pager on a phone, else straight in #view. */
function place(/** @type {string} */ key, /** @type {HTMLElement} */ page) {
  const slot = slotOf(key);
  const parent = phone() && slot >= 0 ? slots[slot] : view;
  if (page.parentElement !== parent) { if (parent !== view) page.style.zIndex = ""; parent.append(page); }
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
  const href = strip[i].href;
  if (location.pathname + location.search !== href) history.replaceState(history.state, "", href);
  route();
}
function settle() {
  if (mode !== "page" || !pager.clientWidth) return;
  const i = Math.max(0, Math.min(strip.length - 1, Math.round(pager.scrollLeft / pager.clientWidth)));
  if (keyOf(strip[i]) === current) return;
  fromSwipe = true;
  history.replaceState(history.state, "", strip[i].href);
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
  if (i >= 0 && i < strip.length) toPage(i);
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

// ---- Find, More ----------------------------------------------------------------------------

/** Lumen opened: Find, with the keyboard up; dictated words go into its box, unsent. */
function openFind(/** @type {string | undefined} */ words) {
  const kept = pages.get("/find");
  if (words && !kept) { go("/find?q=" + encodeURIComponent(words)); return; }
  if (mode !== "find") go("/find");
  const input = /** @type {HTMLInputElement | null} */ (pages.get("/find")?.page.querySelector("#fd-in") || null);
  if (!input) return;
  if (words) { input.value = words; input.dispatchEvent(new Event("input")); }
  input.focus({ preventScroll: true });
}

/** The More sheet, from the tab bar's last tab or the avatar (js/more.js in js/sheet.js's sheet): the places
 * that are not a tab. A tap opens one pushed. */
function openMore() {
  let stop = () => {};
  const s = openSheet({ title: "More", label: "More", build(body, close, parts) {
    stop = fillMore(body, close, parts, { name: owner.name, letter: owner.letter, host: location.host,
      health: watchHealth, line: linkLine, open: t => go(t.href) }).stop;
  }, onClose() {
    stop();
    matchMedia(PHONE_QUERY).removeEventListener("change", shut);
  } });
  // Out of the phone layout (a rotation, a wider window) the rail has the places: the sheet goes.
  const shut = () => s.close();
  matchMedia(PHONE_QUERY).addEventListener("change", shut);
}

/** Lumen's placeholder names the assistant: read once, and again after a visit to Agents. */
async function drawAssistantName() {
  const r = await attempt("agents.list");
  cap.name(assistantName(r.data));
}

// The phone's three pages and Find, made once while the phone is idle after the first screen, one
// after another, each hidden: the first swipe to a page is then a revisit, one frame. Only on a
// phone, and only for pages not open yet; each view reads its data once, then follows events.
async function warm() {
  if (!phone()) return;
  for (const t of [...strip, { href: "/find", view: "find" }]) {
    const k = keyOf(t);
    // The Vault and Glass are never kept, so a kept Vault is made when it is swiped to.
    if (pages.has(k) || NEVER_KEEP.has(t.view)) continue;
    await mount(k, t.view, {}, new URLSearchParams(), true);
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
  installTrustAsk();
// Just paired by scanning the Wink ring: the box's own address opens with a one-time grant in the
// fragment, and this phone makes its Face ID key now (js/enroll-grant.js).
offerEnroll({ enroll: enrollPasskey, canProve }).catch(() => {});
// A paired browser the owner removed from Settings > Devices wipes what it kept of the box (js/wipe.js).
watchRemoval({ on, attempt, onDeviceRemoved, root: document.body });
  // The theme and scheme from the settings hub, live (ADR 0035); a box without the hub keeps /theme.css.
  followTheme({ attempt, on, onResume });
  // A tap on anyone's avatar plays its small hop (js/avatars.js), one listener for the page.
  installAvatars();
  // Where the person is, for cohesion's context (ADR 0036): on each page and on coming back.
  reportContext({ attempt, surface: () => (phone() ? "phone" : "deck"), device: deviceId });
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
  on("waiting.changed", e => needs.heardWaiting(e));
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

// Whether the person has touched this page yet: a reload for a new build never lands under their finger.
let touched = false;
{
  const touch = () => { touched = true; };
  addEventListener("pointerdown", touch, { once: true, passive: true });
  addEventListener("keydown", touch, { once: true, passive: true });
}
// Each time the stream comes back (the box may have been updated meanwhile): this page is never
// older than its box. Invisible: deck/js/build-check.js.
onResume(async () => {
  const r = await attempt("system.info");
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  checkBuild({ page: document.querySelector('meta[name="vyre-build"]')?.getAttribute("content") || null, info: r.data,
    sw: reg || null, reload: () => location.reload(), untouched: () => !touched || document.visibilityState === "hidden",
    onHidden: fn => document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") fn(); }) });
});

if ("serviceWorker" in navigator) {
  // updateViaCache none: the browser asks the box for sw.js on every launch, so a release (a new
  // BUILD in it) installs now. When that new worker takes over a page that already had one, the
  // page reloads at once if nobody has touched it yet, and otherwise the next time it is hidden,
  // so a release never mixes old and new modules under someone's finger.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
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
