// @ts-check
// page: read a page and act on it through one CDP session per tab.
//
// The pure parts (snapshot expression, selector scoring, consequence rules) are copies of
// modules/hands-chrome/{snapshot,selector,consequence}.js, because an MV3 worker cannot import
// from outside its own folder and modules never import each other. Keep them in step by hand;
// the differences are marked "vyre-ext" below (submit/inForm/fields/checked on each control).
//
// Speed: page.snapshot is ONE Runtime.evaluate; page.fill sets every field in ONE evaluate using
// the native value setter and input/change events, which React and Vue controlled inputs need.
//
// Consequence: page.act never presses a control that sends, pays, posts or deletes on its own
// judgment. A control the copied consequence rules flag, or any real submit button (a
// <button> without type or type=submit, <input type=submit|image>, the form's default button),
// comes back as {ok:false, held:true, ...} with the form's non-secret values and a signature, so
// the module can turn it into a Gate card. When the person approves, page.act runs again with
// {release:{sig}} and acts only if the page still hashes to the same signature; otherwise
// it fails with code "changed" and nothing is clicked.
//
// NOTE the held result names its signature `sig`, not `signature`: redact.value() masks every key
// called "signature" (correctly, for a JSON body), which would blank the one value the module needs.
// release accepts either spelling.
//
// Frames: a tab is not one document (GoHighLevel's whole Workflows UI is a cross-origin iframe, in its own process). Every op here
// looks in ALL readable frames of the tab (lib/frames.js lists them; a frame that cannot be read is said, never left out). A snapshot
// runs the snapshot script in each frame and merges the controls: each carries `frame` (its index in that list) and `path` (its path
// INSIDE that frame), so a control is (frame, path). A selector may carry `frame` (index, id or a piece of the origin or URL) to pin
// one frame. Scripts that find, fill or focus a control run in the control's own frame; a click is found in the frame, moved by the
// frame's offset and dispatched on the top page's session, which is where Chrome routes input into an iframe.

import { redact } from "../lib/shared.js";
import { passwordFieldScript, CREDENTIAL_STORE } from "../shared/guards.js";
import { guardInstall, guardInstallWrites, guardCollect, held as heldRequest } from "../shared/outbound.js";
import { egressGuard, clearDenied } from "./net.js";
import { isGhlHost } from "../shared/ghlhosts.js";
import { err } from "../lib/err.js";
import { matchControl, norm, nearMisses, topBlocker, classifyBlocker, describeBlocker, redactDom, whereOf, traceOf, nap } from "../lib/ui.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- selector (copied)

export const WEIGHT = { identifier: 100, name: 40, container: 10, path: 1 };

/** @typedef {{ role?: string, identifier?: string, name?: string, container?: string, path?: string, frame?: number|string }} Selector */

/** @param {Selector} sel @param {any} ctl */
export function score(sel, ctl) {
  if (sel.role && ctl.role !== sel.role) return -1;
  let n = 0;
  if (sel.identifier && ctl.identifier === sel.identifier) n += WEIGHT.identifier;
  if (sel.name && ctl.name === sel.name) n += WEIGHT.name;
  if (sel.container && ctl.container === sel.container) n += WEIGHT.container;
  if (sel.path && ctl.path === sel.path) n += WEIGHT.path;
  return n;
}

/** @param {Selector} sel @param {any[]} candidates @returns {{ control: any|null, why?: "unbound"|"tied" }} */
export function resolve(sel, candidates, { min = WEIGHT.name } = {}) {
  let best = null, bestScore = -1, tied = false;
  for (const c of candidates) {
    const n = score(sel, c);
    if (n > bestScore) { best = c; bestScore = n; tied = false; }
    else if (n === bestScore && n >= min) tied = true;
  }
  if (bestScore < min) return { control: null, why: "unbound" };
  if (tied) return { control: null, why: "tied" };
  return { control: best };
}

/** @param {any} ctl @returns {Selector} */
export const selectorOf = ctl => ({ role: ctl.role, identifier: ctl.identifier || undefined, name: ctl.name || undefined, container: ctl.container || undefined, path: ctl.path, ...(typeof ctl.frame === "number" ? { frame: ctl.frame } : {}) });

/** @param {any} raw @returns {Selector} */
function selectorArg(raw) {
  if (typeof raw === "string" && raw.trim()) return { name: raw.trim() };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { role, identifier, name, container, path, frame } = raw;
    const s = { role, identifier, name, container, path, ...(frame !== undefined && frame !== null && frame !== "" ? { frame } : {}) };
    if (s.identifier || s.name) return s;
  }
  throw err("bad_request", "a selector needs a name or an identifier (and optionally a role)");
}

// ---------------------------------------------------------------- consequence (copied)

const CONSEQUENTIAL = [
  /\bsend\b|\bresend\b/i,
  /\bpost\b|\bpublish\b|\bshare\b/i,
  /\bpay\b|\bcharge\b|\bpurchase\b|\bcheckout\b|\bsubscribe\b|\bbuy\b/i,
  /\bdelete\b|\bremove\b|\btrash\b|\berase\b|\bdiscard\b/i,
  /\bsubmit\b|\bconfirm\b|\bapprove\b|\bplace order\b/i,
  /\bmerge\b|\bpush\b|\bdeploy\b|\brelease\b/i,
  /\bsign\b|\bsign out\b|\blog out\b/i,
  /\binvite\b|\badd member\b/i,
  /\$\s?\d/,
];

/** @param {{ name?: string, nameless?: boolean }} ctl */
export function consequence(ctl) {
  const name = String((ctl && ctl.name) || "").trim();
  if (!name || (ctl && ctl.nameless)) return { consequential: true, why: "cannot read what this control does, so it is treated as one that matters" };
  for (const re of CONSEQUENTIAL) if (re.test(name)) return { consequential: true, why: JSON.stringify(name) + " looks like an action that cannot be undone by doing it again" };
  return { consequential: false, why: "navigating, focusing or selecting" };
}

// ---------------------------------------------------------------- in-page code

const ACTIONABLE = ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem"];
const IMPLICIT = { A: "link", BUTTON: "button", SUMMARY: "button", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox", OPTION: "option" };
const INPUT_TYPE_ROLE = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox" };

/** A script tagged with its kind and arguments in a leading comment so a test double can tell scripts apart (a comment terminator inside the JSON is escaped). */
const script = (/** @type {string} */ kind, /** @type {any} */ args, /** @type {string} */ body) =>
  `/*vyre:${kind} ${JSON.stringify(args ?? {}).replace(/\*\//g, "*\\/")}*/(() => { const ARGS = ${JSON.stringify(args ?? {})}; ${body} })()`;

// Shared by every script: the same path function the snapshot uses, and its inverse.
const PRELUDE = `
  function parentOf(n) {
    if (n.parentElement) return n.parentElement;
    const r = n.getRootNode ? n.getRootNode() : null;
    return r && r.host ? r.host : null;
  }
  function pathOf(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 8) {
      const par = n.parentNode;
      const idx = par && par.children ? [...par.children].indexOf(n) : 0;
      parts.unshift(n.tagName.toLowerCase() + "[" + idx + "]");
      n = parentOf(n);
    }
    return parts.join(">");
  }
  // Every element, looking inside open shadow roots too (closed roots and cross-origin frames are not reachable).
  function deepAll(root, out) {
    for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
    return out;
  }
  function find(path) {
    const last = path.split(">").pop().split("[")[0];
    for (const el of document.getElementsByTagName(last)) if (pathOf(el) === path) return el;
    for (const el of deepAll(document, [])) if (el.tagName.toLowerCase() === last && pathOf(el) === path) return el;
    return null;
  }
  function setNative(el, prop, v) {
    let p = Object.getPrototypeOf(el);
    while (p) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
      if (d && d.set) { d.set.call(el, v); return; }
      p = Object.getPrototypeOf(p);
    }
    el[prop] = v;
  }
  function fire(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
`;

/** One evaluate: every actionable control, with vyre-ext additions for holds. */
export const EXPRESSION = script("snapshot", {}, `
  const ACTIONABLE = new Set(${JSON.stringify(ACTIONABLE)});
  const IMPLICIT = ${JSON.stringify(IMPLICIT)};
  const INPUT_TYPE_ROLE = ${JSON.stringify(INPUT_TYPE_ROLE)};
  const SECRET = /pass|secret|token|card|cvv|cvc|ssn|otp|pin|routing|account.?num/i;
  ${PRELUDE}
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_TYPE_ROLE[t] || "textbox";
    }
    return IMPLICIT[tag] || null;
  }
  function nameOf(el) {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby.split(/\\s+/).map(id => { const t = document.getElementById(id); return t ? t.textContent : ""; }).join(" ").trim();
      if (text) return text;
    }
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    if (el.labels && el.labels.length) { const t = [...el.labels].map(l => l.textContent).join(" ").trim(); if (t) return t; }
    // vyre-ext: a submit or button input is named by its value.
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) && el.value) return String(el.value).trim();
    if (el.tagName === "INPUT" && el.placeholder) return el.placeholder.trim();
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text.slice(0, 120);
    if (el.tagName === "IMG" && el.alt) return el.alt.trim();
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  }
  function containerOf(el) {
    const form = el.closest("form[id],form[name],[role=dialog],[role=region][aria-label],[aria-labelledby]");
    if (!form) return undefined;
    return form.getAttribute("aria-label") || form.id || form.getAttribute("name") || undefined;
  }
  // vyre-ext: a preview of a form's fields, values only for inputs that are not secret.
  const forms = [...document.forms];
  const previews = new Map();
  function fieldsOf(form) {
    if (previews.has(form)) return previews.get(form);
    const out = {};
    let n = 0;
    for (const f of form.elements) {
      if (n >= 40) break;
      const t = (f.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "fieldset"].includes(t)) continue;
      const name = f.name || f.id || f.getAttribute("aria-label") || "";
      if (!name) continue;
      let v;
      if (t === "password" || SECRET.test(name) || SECRET.test(f.autocomplete || "")) v = "[secret]";
      else if (t === "checkbox" || t === "radio") { if (t === "radio" && !f.checked) continue; v = f.checked ? "checked" : "unchecked"; }
      else if (t === "file") v = "[file]";
      else if (f.tagName === "SELECT") v = f.selectedOptions && f.selectedOptions[0] ? f.selectedOptions[0].text.trim().slice(0, 80) : "";
      else v = String(f.value == null ? "" : f.value).slice(0, 80);
      out[name] = v;
      n++;
    }
    previews.set(form, out);
    return out;
  }
  const FILL = ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "spinbutton", "listbox", "slider"];
  const txt = t => String(t || "").trim().replace(/\\s+/g, " ");
  // vyre-ext: the label a person would read next to a field, for pages whose inputs carry no label element.
  function nearOf(el) {
    let n = el;
    for (let i = 0; i < 3 && n && n.parentElement; i++) {
      const s = n.previousElementSibling;
      if (s && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(s.tagName) && !s.querySelector("input,select,textarea,button")) { const t = txt(s.innerText || s.textContent); if (t && t.length <= 80) return t; }
      const p = n.parentElement;
      const l = p.querySelector(":scope > label, :scope > legend, :scope > [class*=label], :scope > [class*=Label]");
      if (l && !l.contains(el)) { const t = txt(l.innerText || l.textContent); if (t && t.length <= 80) return t; }
      n = p;
    }
    return "";
  }
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  // vyre-ext: page state the waiting helper reads with the same evaluate: DOM and network quiet, spinners, dialogs, toasts.
  const TOAST = '[role="status"],[role="alert"],[aria-live="polite"],[aria-live="assertive"],[class*="toast"],[class*="Toast"],[class*="snackbar"],[class*="Snackbar"],.n-message,.el-message';
  if (!window.__vyreQuiet) {
    window.__vyreQuiet = { t: Date.now() };
    new MutationObserver(() => { window.__vyreQuiet.t = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  if (!window.__vyreNet) {
    const net = window.__vyreNet = { pending: 0, t: Date.now() };
    const done = () => { net.pending = Math.max(0, net.pending - 1); net.t = Date.now(); };
    const begin = () => { net.pending++; net.t = Date.now(); };
    const f = window.fetch;
    if (typeof f === "function") window.fetch = function () { begin(); let p; try { p = f.apply(this, arguments); } catch (e) { done(); throw e; } p.then(done, done); return p; };
    if (window.XMLHttpRequest) { const send = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function () { begin(); this.addEventListener("loadend", done); return send.apply(this, arguments); }; }
  }
  if (!window.__vyreToasts) {
    window.__vyreToasts = [];
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const hit = n.matches(TOAST) ? n : n.querySelector(TOAST);
        if (hit) setTimeout(() => { const t = txt(hit.innerText || hit.textContent).slice(0, 160); if (t) { window.__vyreToasts.push({ t: Date.now(), text: t }); if (window.__vyreToasts.length > 20) window.__vyreToasts.shift(); } }, 40);
      }
    }).observe(document, { subtree: true, childList: true });
  }
  const state = { domQuietMs: Date.now() - window.__vyreQuiet.t, netPending: window.__vyreNet.pending, netQuietMs: window.__vyreNet.pending ? 0 : Date.now() - window.__vyreNet.t };
  const BUSY = '[aria-busy="true"],[role="progressbar"],[class*="skeleton"],[class*="Skeleton"],[class*="spinner"],[class*="Spinner"],[class*="loading"],[class*="Loading"],[class*="loader"],[class*="Loader"],[class*="shimmer"],.animate-pulse,.animate-spin,.n-spin';
  const busy = [];
  for (const el of document.querySelectorAll(BUSY)) { if (busy.length >= 20) break; if (vis(el)) busy.push(el); }
  state.busy = busy.length;
  if (busy.length) state.busySample = busy.slice(0, 2).map(e => e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/)[0] : ""));
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  const backdrop = [...document.querySelectorAll('[class*="backdrop"],[class*="Backdrop"],[class*="mask"],.v-modal')].some(e => vis(e) && getComputedStyle(e).position === "fixed");
  const blockers = [];
  for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal"],[class*="Modal"],[class*="popup"],[class*="Popup"],[class*="overlay"],[class*="Overlay"],[class*="drawer"],[class*="Drawer"],[class*="dialog"],[class*="Dialog"]')) {
    if (blockers.length >= 6) break;
    if (!vis(el) || blockers.some(b => b.el.contains(el))) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), role = el.getAttribute("role");
    const layer = (cs.position === "fixed" || cs.position === "absolute") && r.width * r.height >= 0.08 * vw * vh;
    if (!(role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true" || layer)) continue;
    const ariaModal = el.getAttribute("aria-modal") === "true" || role === "alertdialog";
    const cover = cs.position === "fixed" && r.width * r.height >= 0.6 * vw * vh;
    const head = el.querySelector("h1,h2,h3,h4,[class*=title],[class*=Title]");
    blockers.push({ el, i: blockers.length, path: pathOf(el), role: role || undefined, title: txt(el.getAttribute("aria-label") || (head && head.textContent)).slice(0, 80), text: txt(el.innerText || el.textContent).slice(0, 300), modal: ariaModal || cover || (backdrop && (role === "dialog" || layer)) });
  }
  state.blockers = blockers.map(({ el, ...b }) => b);
  // The iframes this frame holds and how much of its viewport each covers: a frame Vyre cannot read is then said to cover most of the page.
  state.vw = vw; state.vh = vh;
  state.iframes = [...document.querySelectorAll("iframe,frame")].slice(0, 16).map(f => { const r = f.getBoundingClientRect(); return { src: String(f.getAttribute("src") || "").slice(0, 300), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(f => f.w > 0 && f.h > 0);
  // A white-label GoHighLevel account runs on its own domain but talks to GoHighLevel's API hosts.
  try { state.ghlApi = performance.getEntriesByType("resource").some(e => e.name.indexOf("https://services.leadconnectorhq.com/") === 0 || e.name.indexOf("https://backend.leadconnectorhq.com/") === 0); } catch (e) { state.ghlApi = false; }
  const toasts = (window.__vyreToasts || []).filter(x => Date.now() - x.t < 15000).map(x => ({ ageMs: Date.now() - x.t, text: x.text }));
  for (const el of document.querySelectorAll(TOAST)) { if (toasts.length >= 8) break; if (!vis(el)) continue; const t = txt(el.innerText || el.textContent).slice(0, 160); if (t && !toasts.some(x => x.text === t)) toasts.push({ ageMs: null, text: t }); }
  state.toasts = toasts.slice(-8);
  const out = [];
  for (const el of deepAll(document, [])) {
    const role = roleOf(el);
    if (!role || !ACTIONABLE.has(role)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const name = nameOf(el);
    const identifier = el.id || el.getAttribute("data-testid") || el.getAttribute("data-test-id") || undefined;
    const c = { path: pathOf(el), role, enabled: !disabled, box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
    // Which part of the page it is in, for a budgeted snapshot: 0 the main content or a dialog or drawer, 2 navigation or header chrome, 1 the rest (only sent when not 1).
    const pri = el.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"],main,[role="main"]') ? 0 : el.closest('nav,header,[role="navigation"],[role="banner"]') ? 2 : 1;
    if (pri !== 1) c.pri = pri;
    if (name) c.name = name; else c.nameless = true;
    if (identifier) c.identifier = identifier;
    if (FILL.includes(role)) {
      const aria = txt(el.getAttribute("aria-label")), ph = txt(el.getAttribute("placeholder")), near = nearOf(el);
      if (aria && aria !== name) c.aria = aria.slice(0, 80);
      if (ph && ph !== name) c.placeholder = ph.slice(0, 80);
      if (near && near !== name) c.near = near;
    }
    if (blockers.length) { const bi = blockers.findIndex(b => b.el.contains(el)); if (bi >= 0) c.blk = bi; }
    const container = containerOf(el);
    if (container) c.container = container;
    if (document.activeElement === el) c.focused = true;
    if ("value" in el && el.value !== undefined && el.value !== null && el.value !== "" && el.type !== "password") c.value = String(el.value);
    if (el.type === "password" && el.value) c.length = el.value.length;
    if (el.type === "checkbox" || el.type === "radio") c.checked = el.checked === true;
    else if (el.getAttribute("aria-checked") !== null) c.checked = el.getAttribute("aria-checked") === "true";
    const form = el.form || el.closest("form");
    if (form) {
      c.inForm = true;
      c.form = form.id || form.getAttribute("name") || "form" + forms.indexOf(form);
      const t = (el.getAttribute("type") || "").toLowerCase();
      if ((el.tagName === "BUTTON" && (t === "" || t === "submit")) || (el.tagName === "INPUT" && (t === "submit" || t === "image"))) c.submit = true;
      if (role === "button") c.fields = fieldsOf(form);
    }
    out.push(c);
  }
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 20000), controls: out, state };
`);

/** Find a control by path, scroll it to the middle and report where its centre is. */
const locate = (/** @type {string} */ path, focus = false) => script("locate", { path, focus }, `
  ${PRELUDE}
  const el = find(ARGS.path);
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (ARGS.focus && el.focus) el.focus();
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const hit = !!top && (top === el || el.contains(top) || top.contains(el));
  return { found: true, x, y, hit, checked: el.checked === true || el.getAttribute("aria-checked") === "true" };
`);

/**
 * The evidence the site store needs before it will keep a control's label (lib/sk): the ROLE of the nearest container ("none" when it has none) and how many
 * controls of the same kind share it. Structure only, no text. Computed only when learning is on.
 */
const evidence = (/** @type {string} */ path) => script("evidence", { path }, `
  ${PRELUDE}
  const el = find(ARGS.path);
  if (!el) return null;
  const IMPLICIT = { TR: "row", TD: "cell", TH: "cell", LI: "listitem", FORM: "form", DIALOG: "dialog", TABLE: "table", UL: "list", OL: "list", NAV: "navigation", MENU: "menu", ASIDE: "complementary", HEADER: "banner", FOOTER: "contentinfo", FIELDSET: "group" };
  const ROLES = new Set(["row", "cell", "gridcell", "listitem", "treeitem", "list", "listbox", "table", "grid", "tree", "rowgroup", "feed", "log", "form", "dialog", "alertdialog", "menu", "menubar", "radiogroup", "tablist", "toolbar", "navigation", "group", "region", "banner", "complementary", "contentinfo", "main", "tabpanel"]);
  let cont = null, role = "none";
  for (let a = el.parentElement; a; a = a.parentElement) {
    const r = String(a.getAttribute("role") || "").toLowerCase();
    if (r && ROLES.has(r)) { cont = a; role = r; break; }
    if (!r && IMPLICIT[a.tagName]) { cont = a; role = IMPLICIT[a.tagName]; break; }
  }
  const tag = el.tagName, rl = el.getAttribute("role") || "";
  let sib = 1;
  if (cont) { sib = 0; for (const x of cont.querySelectorAll(tag.toLowerCase())) { if ((x.getAttribute("role") || "") === rl && x.getClientRects().length) sib++; } sib = Math.max(1, sib); }
  return { container: role, siblings: sib };
`);

/** Set fields, all in one evaluate. kind is auto (decide from the element), type, select or check. */
const apply = (/** @type {{path: string, kind: string, value: any}[]} */ items) => script("apply", { items }, `
  ${PRELUDE}
  const out = [];
  for (const it of ARGS.items) {
    const el = find(it.path);
    if (!el) { out.push({ ok: false, why: "the control is gone" }); continue; }
    try {
      let kind = it.kind;
      if (kind === "auto") kind = el.tagName === "SELECT" ? "select" : (el.type === "checkbox" || el.type === "radio") ? "check" : "type";
      if (kind === "select") {
        if (el.tagName !== "SELECT") { out.push({ ok: false, why: "not a select" }); continue; }
        const want = String(it.value);
        const opts = [...el.options];
        const o = opts.find(x => x.value === want) || opts.find(x => x.text.trim() === want) || opts.find(x => x.text.trim().toLowerCase() === want.toLowerCase());
        if (!o) { out.push({ ok: false, why: "no such option" }); continue; }
        setNative(el, "value", o.value);
        fire(el);
        out.push({ ok: true });
      } else if (kind === "check") {
        const want = !(it.value === false || it.value === "false" || it.value === "off" || it.value === "no");
        if (el.checked !== want) el.click();
        out.push({ ok: el.checked === want, checked: el.checked });
      } else {
        if (el.focus) el.focus();
        if ("value" in el) {
          setNative(el, "value", String(it.value));
          fire(el);
          out.push({ ok: true });
        } else if (el.isContentEditable) {
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, String(it.value));
          out.push({ ok: true });
        } else out.push({ ok: false, why: "not something you can type into" });
      }
    } catch (e) { out.push({ ok: false, why: String(e && e.message || e) }); }
  }
  return out;
`);

const exists = (/** @type {string} */ css) => script("exists", { css }, `try { return !!document.querySelector(ARGS.css); } catch (e) { return false; }`);
const href = () => script("href", {}, `return location.href;`);
// Milliseconds since the DOM last changed; the observer is installed once per page.
const quiet = () => script("quiet", {}, `
  if (!window.__vyreQuiet) {
    window.__vyreQuiet = { t: Date.now() };
    new MutationObserver(() => { window.__vyreQuiet.t = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return Date.now() - window.__vyreQuiet.t;
`);

/** A compact, attribute-trimmed outline of the target's area (or the top dialog, or the page) for a failure report. The worker masks it and caps it. */
const domOutline = (/** @type {string|undefined} */ path) => script("dom", { path: path || "" }, `
  ${PRELUDE}
  const KEEP = ["id", "data-testid", "role", "aria-label", "placeholder", "name", "type", "disabled", "aria-disabled", "aria-busy", "aria-modal", "aria-checked", "title"];
  const SECRET = /pass|secret|token|card|cvv|cvc|ssn|otp|pin/i;
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "PATH", "IMG", "LINK", "META", "IFRAME", "HEAD", "VYRE-PILL", "VYRE-CARD"]);
  const BARE = new Set(["DIV", "SPAN", "SECTION", "P"]);
  let root = ARGS.path ? find(ARGS.path) : null;
  if (root) root = root.closest('[role="dialog"],[role="alertdialog"],form,[class*="drawer"],[class*="modal"]') || root.parentElement || root;
  if (!root) {
    const tops = [...document.querySelectorAll('[aria-modal="true"],[role="alertdialog"],[role="dialog"]')].filter(e => e.getBoundingClientRect().width > 0);
    root = tops.length ? tops[tops.length - 1] : (document.querySelector("main") || document.body);
  }
  let budget = 3600;
  const parts = [];
  const push = t => { parts.push(t); budget -= t.length; };
  function walk(el, depth) {
    if (budget <= 0 || depth > 16 || SKIP.has(el.tagName.toUpperCase())) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const tag = el.tagName.toLowerCase();
    let attrs = "";
    for (const k of KEEP) { const v = el.getAttribute(k); if (v !== null && v !== "") attrs += " " + k + '="' + String(v).slice(0, 60) + '"'; }
    if ("value" in el && typeof el.value === "string" && el.value && !SECRET.test((el.type || "") + (el.name || "") + (el.id || "") + (el.autocomplete || ""))) attrs += ' value="' + el.value.slice(0, 40) + '"';
    const bare = BARE.has(el.tagName) && !attrs;
    if (!bare) push("<" + tag + attrs + ">");
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const t = String(n.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80); if (t) push(t); }
      else if (n.nodeType === 1) walk(n, depth + 1);
    }
    if (el.shadowRoot) for (const n of el.shadowRoot.children) walk(n, depth + 1);
    if (!bare) push("</" + tag + ">");
  }
  walk(root, 0);
  return { html: parts.join("") };
`);

// ---------------------------------------------------------------- frames and CDP plumbing

/** What a tab with no frame tree to ask (a test double, or a page that just navigated) is: the top page alone. */
const TOP_ONLY = Object.freeze({ index: 0, frameId: "", parentId: null, depth: 0, url: "", origin: "", name: "", session: null, how: /** @type {"top"} */ ("top"), readable: true });

const noQuery = (/** @type {any} */ u) => String(u || "").split(/[?#]/)[0];

/** Every frame of the tab, top first, in tree order. Never empty: the top page is always there. @param {any} ctx @param {number} tabId @returns {Promise<any[]>} */
async function framesOf(ctx, tabId) {
  if (!ctx.frames || typeof ctx.frames.list !== "function") return [TOP_ONLY];
  try { const l = await ctx.frames.list(tabId); if (Array.isArray(l) && l.length) return l; } catch { /* no frame tree to read: the top page is what there is */ }
  return [TOP_ONLY];
}

/**
 * The frame indexes a `frame` reference pins: an index, "top", a frame id, an origin, or a piece of an origin or URL. Null when nothing is
 * pinned; an empty list when the reference matches no frame. Works on lib/frames.js frames (frameId) and on snapshot.frames entries (id).
 * @param {any[]} frames @param {unknown} ref @returns {number[]|null}
 */
export function pinIndexes(frames, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  if (ref === "top" || ref === "main") return [0];
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) return frames.some(f => f.index === Number(ref)) ? [Number(ref)] : [];
  const r = String(ref);
  const idOf = (/** @type {any} */ f) => (f.id !== undefined ? f.id : f.frameId);
  let hit = frames.filter(f => idOf(f) === r);
  if (!hit.length) hit = frames.filter(f => f.origin === r);
  if (!hit.length) hit = frames.filter(f => String(f.url || "").includes(r) || String(f.origin || "").includes(r));
  return hit.map(f => f.index);
}

/**
 * Run a script inside one frame (the top page when frame is absent), returning its value. A script that throws is an error.
 * @param {any} ctx @param {number} tabId @param {string} expression @param {any} [extra] @param {any} [frame]
 */
async function evaluate(ctx, tabId, expression, extra = {}, frame) {
  const params = { returnByValue: true, timeout: 10_000, ...extra };
  const r = frame && frame.how !== "top" && ctx.frames ? await ctx.frames.evalIn(tabId, frame, expression, params) : await ctx.cdp.send(tabId, "Runtime.evaluate", { expression, ...params });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw err("error", String((d.exception && d.exception.description) || d.text || "the page threw"));
  }
  return r && r.result ? r.result.value : undefined;
}

/**
 * The live frame a control was found in. Frame ids change when a frame navigates, and an index can shift when one appears, so it is
 * found again by its index AND origin, else by origin and depth: a control whose frame is really gone is "gone" (stale, so retried).
 * @param {any[]} list frames now @param {any} ctl @param {any} [snap]
 */
export function refindFrame(list, ctl, snap) {
  const idx = typeof ctl.frame === "number" ? ctl.frame : 0;
  const want = ctl.frameOrigin || "";
  const at = list[idx];
  if (at && at.readable && (!want || at.origin === want)) return at;
  const depth = snap && snap.frames ? (snap.frames.find((/** @type {any} */ f) => f.index === idx) || {}).depth : at && at.depth;
  const same = list.filter(f => f.readable && want && f.origin === want);
  const pick = same.find(f => f.depth === depth) || same[0];
  if (pick) return pick;
  throw err("not_found", `the frame the control was in (${want || "frame " + idx}) is gone`);
}

const GHL_FRAME_HOST = /(^|\.)leadconnectorhq\.com$/i;
/**
 * A frame that is GoHighLevel's own workflow builder: a child frame on a leadconnectorhq.com host whose host or path is the automation /
 * workflows app (client-app-automation-workflows.leadconnectorhq.com). Decided from the frame's own origin, which Chrome reports and a
 * page cannot forge; a white-label shell around it changes nothing.
 * @param {any} f
 */
export function isGhlBuilderFrame(f) {
  if (!f || !(f.depth > 0)) return false;
  let u;
  try { u = new URL(String(f.url || f.origin)); } catch { return false; }
  if (!GHL_FRAME_HOST.test(u.hostname)) return false;
  return /automation|workflow/i.test(u.hostname) || /\/(automation|workflows?)(\/|$)/i.test(u.pathname);
}

const FRAME_FLOOR = 12;
/**
 * Split a snapshot's control budget across frames: each frame keeps at least a floor (so a huge frame cannot starve a small one), and
 * what is left is shared out evenly among the frames that have more.
 * @param {number[]} counts controls per frame @param {number} [limit] @returns {number[]}
 */
export function allocate(counts, limit) {
  if (!(Number(limit) > 0)) return counts.slice();
  const lim = Math.floor(Number(limit));
  const n = counts.filter(c => c > 0).length || 1;
  const floor = Math.min(FRAME_FLOOR, Math.ceil(lim / n));
  const alloc = counts.map(c => Math.min(c, floor));
  let left = lim - alloc.reduce((a, b) => a + b, 0);
  while (left > 0) {
    const open = counts.map((c, i) => i).filter(i => alloc[i] < counts[i]);
    if (!open.length) break;
    const share = Math.max(1, Math.floor(left / open.length));
    for (const i of open) { const give = Math.min(share, counts[i] - alloc[i], left); alloc[i] += give; left -= give; if (left <= 0) break; }
  }
  return alloc;
}

const sumOf = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0);
const minOf = (/** @type {number[]} */ a) => a.reduce((x, y) => (y < x ? y : x), a[0]);

/**
 * Merge what the snapshot script returned in each frame into one snapshot. `results[i]` is {raw} for frame i, or {why} when its
 * script could not run there. A tab with only its top page gives the same snapshot as always (plus `frames`); with more, every control
 * carries `frame` and `frameOrigin`, `state` covers all readable frames, and a frame that could not be read is listed in `notReadable`
 * and named in the text: a snapshot never passes for the whole page when it is only the shell.
 * @param {any[]} list frames from lib/frames.js @param {Array<{ raw?: any, why?: string }>} results @param {{ limit?: number }} [o]
 */
export function mergeSnapshot(list, results, o = {}) {
  const multi = list.length > 1;
  const top = (results[0] && results[0].raw) || {};
  /** @type {any[]} */
  const parts = list.map((f, i) => {
    const r = results[i] || {};
    const raw = r.raw && typeof r.raw === "object" ? r.raw : null;
    const controls = (raw && Array.isArray(raw.controls) ? raw.controls : []).map((/** @type {any} */ c) => {
      // The page's own box of a control was called `frame` before frames were first-class: it is `box` now.
      const { frame: legacyBox, pri, ...rest } = c;
      return { c: legacyBox && typeof legacyBox === "object" ? { ...rest, box: legacyBox } : rest, pri: typeof pri === "number" ? pri : 1 };
    });
    return { f, raw, why: raw ? undefined : r.why || f.why || "no way into this frame", controls, blkBase: 0 };
  });

  // Blockers are numbered across frames so a control's `blk` still names one.
  let base = 0;
  /** @type {any[]} */ const blockers = [];
  for (const p of parts) {
    const bl = (p.raw && p.raw.state && p.raw.state.blockers) || [];
    for (const b of bl) blockers.push(multi ? { ...b, i: b.i + base, frame: p.f.index } : b);
    p.blkBase = base; base += bl.length;
  }

  // The control budget, per frame, preferring the main content and dialogs over navigation chrome.
  const keep = allocate(parts.map(p => p.controls.length), o.limit);
  const total = sumOf(parts.map(p => p.controls.length));
  /** @type {any[]} */ const controls = [];
  const counts = parts.map((p, i) => {
    let pick = p.controls.map((/** @type {any} */ x, /** @type {number} */ k) => k);
    if (keep[i] < pick.length) pick = pick.sort((/** @type {number} */ a, /** @type {number} */ b) => p.controls[a].pri - p.controls[b].pri || a - b).slice(0, keep[i]).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
    for (const k of pick) {
      const { c } = p.controls[k];
      controls.push(multi ? { ...c, frame: p.f.index, ...(p.f.origin ? { frameOrigin: p.f.origin } : {}), ...(c.blk !== undefined ? { blk: c.blk + p.blkBase } : {}) } : c);
    }
    return pick.length;
  });

  // State: quiet only when every readable frame is quiet.
  const states = parts.filter(p => p.raw && p.raw.state).map(p => p.raw.state);
  /** @type {any} */ let state;
  if (states.length) {
    const { iframes: _i, vw: _w, vh: _h, ghlFrame: _g, ...first } = states[0];
    if (!multi) state = first;
    else {
      const nums = (/** @type {string} */ k) => states.map(s => s[k]).filter(v => typeof v === "number");
      state = { ...first };
      if (nums("domQuietMs").length) state.domQuietMs = minOf(nums("domQuietMs"));
      if (nums("netPending").length) state.netPending = sumOf(nums("netPending"));
      if (nums("netQuietMs").length) state.netQuietMs = state.netPending ? 0 : minOf(nums("netQuietMs"));
      if (nums("busy").length) state.busy = sumOf(nums("busy"));
      const sample = states.find(s => s.busySample);
      if (sample) state.busySample = sample.busySample; else delete state.busySample;
      state.blockers = blockers;
      state.toasts = states.flatMap(s => s.toasts || []).slice(-8);
      if (states.some(s => s.ghlApi === true)) state.ghlApi = true;
    }
  }
  const ghlFrames = list.filter(isGhlBuilderFrame).map(f => f.index);
  if (state && ghlFrames.length) state.ghlFrame = true;

  // Frames, said plainly.
  /** @type {any[]} */ const notReadable = [];
  const framesOut = parts.map((p, i) => {
    const parent = p.f.parentId ? list.findIndex(x => x.frameId === p.f.parentId) : -1;
    const busy = p.raw && p.raw.state && typeof p.raw.state.busy === "number" ? p.raw.state.busy : 0;
    if (!p.raw) notReadable.push({ index: p.f.index, origin: p.f.origin, why: p.why });
    return { index: p.f.index, ...(p.f.frameId ? { id: p.f.frameId } : {}), ...(parent >= 0 ? { parent } : {}), depth: p.f.depth, origin: p.f.origin, url: noQuery(p.f.url), readable: !!p.raw, controls: counts[i], ...(keep[i] < p.controls.length ? { total: p.controls.length } : {}), ...(busy ? { busy } : {}) };
  });

  // A frame Vyre cannot read that fills the page: the real controls are probably in it.
  /** @type {string[]} */ const sentences = [];
  if (notReadable.length) sentences.push(`${notReadable.length} frame${notReadable.length === 1 ? "" : "s"} not readable: ${notReadable.map(n => n.origin || `frame ${n.index}`).join(", ")}.`);
  for (const n of notReadable) {
    const pi = framesOut[n.index] && framesOut[n.index].parent;
    const parent = typeof pi === "number" ? parts[pi] : null;
    const st = parent && parent.raw && parent.raw.state;
    if (!st || !Array.isArray(st.iframes) || !st.vw || !st.vh) continue;
    let biggest = 0;
    for (const ifr of st.iframes) {
      let org = "";
      try { org = new URL(ifr.src, (parent && parent.f.url) || undefined).origin; } catch { org = ""; }
      if (org && org === n.origin) biggest = Math.max(biggest, (ifr.w * ifr.h) / (st.vw * st.vh));
    }
    if (biggest >= 0.25) { n.coversViewport = Math.min(100, Math.round(biggest * 100)); sentences.push(`Frame ${n.index} (${n.origin || "unknown origin"}) covers about ${n.coversViewport}% of the viewport and is not readable, so the page's real controls are probably inside it.`); }
  }

  // The text on screen: the top page's, then each readable child frame's, so a list inside an iframe is not invisible.
  let text = String(top.text || "");
  if (multi) {
    for (const p of parts.slice(1)) { const t = p.raw && String(p.raw.text || "").trim(); if (t) text += `\n\n[frame ${p.f.index}${p.f.origin ? " " + p.f.origin : ""}]\n${t.slice(0, 6000)}`; }
    text = text.slice(0, 20000);
  }
  if (sentences.length) text = `${sentences.join(" ")}\n${text}`;

  return {
    title: top.title || "", url: top.url || "", text,
    ...(state ? { state } : {}),
    ...(ghlFrames.length ? { ghlFrames } : {}),
    frames: framesOut,
    ...(notReadable.length ? { notReadable } : {}),
    controls, named: controls.filter(c => !c.nameless).length, nameless: controls.filter(c => c.nameless).length,
    ...(controls.length < total ? { truncated: { total, returned: controls.length } } : {}),
  };
}

/** A snapshot of one page's raw script result: the merge with only the top page. @param {any} raw */
export const toSnapshot = raw => mergeSnapshot([TOP_ONLY], [{ raw }]);

/**
 * Every readable frame, top first, read in parallel and merged. The top page failing is an error (as ever); a child frame failing is
 * that frame being not readable.
 * @param {any} ctx @param {number} tabId @param {{ limit?: number }} [o]
 */
async function snapshot(ctx, tabId, o = {}) {
  const list = await framesOf(ctx, tabId);
  const results = await Promise.all(list.map(async (f, i) => {
    if (!f.readable) return { why: f.why };
    try { return { raw: (await evaluate(ctx, tabId, EXPRESSION, {}, f)) || {} }; } catch (e) {
      if (i === 0) throw e;
      return { why: String(/** @type {any} */ (e)?.message || e).slice(0, 160) };
    }
  }));
  return mergeSnapshot(list, results, o);
}

/** The tab an op means: the one named, else the one in front (floor-checked here, since dispatch only sees args.tabId). */
async function tabOf(/** @type {any} */ args, /** @type {any} */ ctx, /** @type {string} */ op) {
  if (typeof args.tabId === "number") return args.tabId;
  const a = await ctx.tabs.active();
  if (!a) throw err("no_tab");
  const v = await ctx.floorAllows(a.id, op);
  if (!v.allow) throw err("blocked", `${v.why} (${v.tier})`);
  return a.id;
}

// ---------------------------------------------------------------- holds and signatures

/** cyrb53: a short, stable, non-cryptographic digest. The signature is a change detector, not a secret. @param {string} s */
function digest(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Two controls in the same frame (a control with no frame is in the top page). @param {any} a @param {any} b */
const sameFrame = (a, b) => (typeof a.frame === "number" ? a.frame : 0) === (typeof b.frame === "number" ? b.frame : 0);

const stripHash = (/** @type {string} */ u) => String(u || "").split("#")[0];

/**
 * The visible field names and values a control would send, secrets shown as "[secret]".
 * A control inside a form carries its form's preview; one outside a form (a single-page app's
 * Send button) is judged by the text fields in its own container, or the whole page.
 * @param {any} snap @param {any} ctl @returns {Record<string, string>}
 */
export function fieldsOf(snap, ctl) {
  if (ctl.fields) return ctl.fields;
  /** @type {Record<string, string>} */
  const out = {};
  const near = snap.controls.filter((/** @type {any} */ c) => ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch"].includes(c.role) && sameFrame(c, ctl) && (!ctl.container || c.container === ctl.container));
  for (const c of near.slice(0, 40)) {
    const name = c.name || c.identifier;
    if (!name) continue;
    if (c.length != null || redact.secretName(name)) out[name] = "[secret]";
    else if (c.checked !== undefined) { if (c.role !== "radio" || c.checked) out[name] = c.checked ? "checked" : "unchecked"; }
    else if (c.value !== undefined) out[name] = String(c.value).slice(0, 80);
    else out[name] = "";
  }
  return out;
}

/**
 * url + control name + a digest of the visible field names and values. Password lengths count, so
 * changing a hidden value still changes the signature though the value is never shown.
 * @param {any} snap @param {any} ctl
 */
export function signatureOf(snap, ctl) {
  const f = fieldsOf(snap, ctl);
  const parts = Object.keys(f).sort().map(k => `${k}=${f[k]}`);
  const secrets = snap.controls.filter((/** @type {any} */ c) => c.length != null && sameFrame(c, ctl) && (!ctl.container || c.container === ctl.container)).map((/** @type {any} */ c) => `${c.name || c.identifier}#${c.length}`).sort();
  return digest([stripHash(snap.url), ctl.role, ctl.name || "", digest(parts.concat(secrets).join("\n"))].join("\n"));
}

/**
 * An action-type tile in a workflow builder's picker ("Send Email", "Remove Tag"): choosing it adds a
 * step to a draft, it sends nothing. It is a plain (non-submit) button inside a dialog or drawer, on
 * a workflow page, whose whole name is an action type. A real "Send" or "Delete" button is not one.
 * @param {any} snap @param {any} ctl
 */
export function builderTile(snap, ctl) {
  if (!ctl || ctl.submit || !ctl.container || !["button", "option", "menuitem"].includes(String(ctl.role))) return false;
  const name = String(ctl.name || "").trim();
  // A tile inside GoHighLevel's own workflow-builder frame (a child frame on a leadconnectorhq.com automation host, decided by the page
  // module from the frame's origin, which the page cannot forge) is on a workflow page whatever the shell around it is: a white-label
  // shell needs no configuring.
  const inBuilderFrame = Boolean(snap && snap.state && snap.state.ghlFrame === true && Array.isArray(snap.ghlFrames) && snap.ghlFrames.includes(ctl.frame));
  if (!inBuilderFrame) {
    let path = "", host = "";
    try { const u = new URL(String(snap && snap.url)); path = u.pathname; host = u.hostname; } catch { return false; }
    // Only GoHighLevel (a workflow page on some other site is not one), and the local fixture's /ghl.
    // GoHighLevel's own domains, one the person listed as their white-label host, or the local fixture.
    // A white-label domain counts automatically only with BOTH the page's own traffic reaching GoHighLevel's API hosts AND
    // GoHighLevel's real workflow URL shape; a host the person listed (`config ghl-host`) counts on its own.
    const whiteLabel = Boolean(snap && snap.state && snap.state.ghlApi === true) && /^\/(v2\/)?location\/[A-Za-z0-9]{10,40}\/automation\/workflows(\/|$)/.test(path);
    if (!isGhlHost(host) && !whiteLabel && !(/^(127\.0\.0\.1|localhost)$/.test(host) && /^\/ghl(\/|$)/.test(path))) return false;
    if (!/\/automation\/workflows|\/workflows?(\/|$)|^\/ghl(\/|$)/i.test(path)) return false;
  }
  // The Confirm or Apply of an action or trigger editor keeps a step in the draft; it is not the Confirm of a delete or a publish.
  if (/^(confirm|apply|done|ok)$/i.test(name)) return /(action|trigger|configur|setting|edit|filter|condition|step)/i.test(String(ctl.container)) && !/(delete|remove|discard|publish|unsaved|leave|cancel|send|pay|charge)/i.test(String(ctl.container));
  return /^send [a-z][a-z .&/-]{1,30}$/i.test(name) || /^remove (tag|contact tag|from [a-z ]{2,30}|contact from [a-z ]{2,30})$/i.test(name);
}

/**
 * Which control decides whether this act is held, and is it? Enter inside a form presses the
 * form's submit button, so that button is the control that matters.
 * @param {any} snap @param {any} ctl @param {string} kind @param {any} value
 * @returns {{ target: any, held: boolean, why: string }}
 */
export function holdFor(snap, ctl, kind, value) {
  let target = ctl;
  if (kind === "press" && String(value) === "Enter" && ctl.inForm && !ctl.submit) {
    const sub = snap.controls.find((/** @type {any} */ c) => c.submit && c.form === ctl.form && sameFrame(c, ctl));
    if (sub) target = sub;
    else return { target: ctl, held: false, why: "" };
  } else if (kind !== "click" && kind !== "press") return { target: ctl, held: false, why: "" };
  if (kind === "press" && String(value) !== "Enter") return { target: ctl, held: false, why: "" };
  if (builderTile(snap, target)) return { target, held: false, why: "" };
  const c = consequence(target);
  if (c.consequential) return { target, held: true, why: c.why };
  if (target.submit) return { target, held: true, why: "a submit button sends its form" };
  return { target, held: false, why: "" };
}

// ---------------------------------------------------------------- acting

const KEYS = /** @type {Record<string, { code: string, vk: number, text?: string }>} */ ({
  Enter: { code: "Enter", vk: 13, text: "\r" }, Tab: { code: "Tab", vk: 9 }, Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 }, Delete: { code: "Delete", vk: 46 }, " ": { code: "Space", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 }, End: { code: "End", vk: 35 }, PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 },
});

/**
 * A script in a control's frame. A child frame that navigated or went away between the look and the act (its execution context or
 * session is gone) means the control is stale: that is "disappeared", which the callers retry after looking again.
 * @param {any} ctx @param {number} tabId @param {any} frame @param {string} expression
 */
async function inFrame_(ctx, tabId, frame, expression) {
  try { return await evaluate(ctx, tabId, expression, {}, frame); } catch (e) {
    const m = String(/** @type {any} */ (e)?.message || e);
    if (frame.index > 0 && /context|frame|target|session|not readable|gone|detached/i.test(m)) throw err("not_found", `the control disappeared: its frame changed (${m.slice(0, 100)})`);
    throw e;
  }
}

/**
 * Where a control is, in the top page's viewport, found by a script that runs in ITS frame: the point inside the frame plus the frame's
 * offset in the top viewport. The hit test (is the target the element at that point?) stays inside the frame. `list` is every frame now.
 * @param {any} ctx @param {number} tabId @param {any} ctl @param {any} snap @param {boolean} focus
 */
async function locateIn(ctx, tabId, ctl, snap, focus) {
  const list = await framesOf(ctx, tabId);
  const frame = refindFrame(list, ctl, snap);
  const loc = await inFrame_(ctx, tabId, frame, locate(ctl.path, focus));
  if (!loc || !loc.found) return { loc, frame };
  if (frame.index > 0 && ctx.frames && ctx.frames.offset) {
    let { dx, dy } = await ctx.frames.offset(tabId, frame, list);
    // A frame scrolled out of the top viewport has its content at points the page cannot take input at: bring it into view and look again.
    try {
      const m = await ctx.cdp.send(tabId, "Page.getLayoutMetrics", {});
      const vp = m && (m.cssLayoutViewport || m.layoutViewport);
      const x = loc.x + dx, y = loc.y + dy;
      if (vp && vp.clientWidth && vp.clientHeight && (x < 0 || y < 0 || x > vp.clientWidth || y > vp.clientHeight) && ctx.frames.reveal) {
        await ctx.frames.reveal(tabId, frame, list);
        const again = await inFrame_(ctx, tabId, frame, locate(ctl.path, focus));
        if (again && again.found) { Object.assign(loc, again); ({ dx, dy } = await ctx.frames.offset(tabId, frame, list)); }
      }
    } catch { /* no metrics: go with the point we have */ }
    return { loc: { ...loc, x: loc.x + dx, y: loc.y + dy, inFrameX: loc.x, inFrameY: loc.y }, frame };
  }
  return { loc, frame };
}

/** @param {any} ctx @param {number} tabId @param {any} ctl @param {any} [snap] */
async function mouseClick(ctx, tabId, ctl, snap) {
  const t0 = Date.now();
  const { loc, frame } = await locateIn(ctx, tabId, ctl, snap, false);
  const tLocate = Date.now() - t0;
  if (!loc || !loc.found) throw err("not_found", "the control disappeared before it could be clicked");
  if (!loc.hit) throw err("covered", "another element covers the control, so nothing was clicked");
  // A cross-process iframe takes input on its own session at frame coordinates: real Chrome drops mouse events the top session sends over it (measured on all three OSes).
  const own = frame && frame.session && typeof loc.inFrameX === "number";
  const session = own ? frame.session : undefined;
  const x = own ? loc.inFrameX : loc.x, y = own ? loc.inFrameY : loc.y;
  const p = { x, y, button: "left", clickCount: 1 };
  const t1 = Date.now();
  // A mouseMoved is not always acknowledged: on a cross-process frame's own session (measured 5001 ms on all three OSes) and, on a macOS runner, on the top session too
  // (5005 ms), so awaiting it costs Chrome's whole command timeout while press and release take 2 ms. Chrome still gets it, in order, ahead of the press; nothing waits for it.
  void ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session).catch(() => {});
  const tMove = Date.now() - t1;
  await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...p }, session);
  const tPress = Date.now() - t1 - tMove;
  await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p }, session);
  return { ...loc, frame: frame ? frame.index : 0, session: own, ms: { locate: tLocate, move: tMove, press: tPress, release: Date.now() - t1 - tMove - tPress } };
}

/** @param {any} ctx @param {number} tabId @param {any} ctl @param {string} key @param {any} [snap] */
async function pressKey(ctx, tabId, ctl, key, snap) {
  const k = KEYS[key] || (key.length === 1 ? { code: /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : "", vk: key.toUpperCase().charCodeAt(0), text: key } : null);
  if (!k) throw err("bad_request", `unknown key ${JSON.stringify(key)}`);
  // Focus the element inside its own frame; the key goes to that frame's own session when it has one.
  const list = await framesOf(ctx, tabId);
  const loc = await inFrame_(ctx, tabId, refindFrame(list, ctl, snap), locate(ctl.path, true));
  if (!loc || !loc.found) throw err("not_found", "the control disappeared before the key was pressed");
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  const fr = refindFrame(list, ctl, snap);
  const ks = fr && fr.session ? fr.session : undefined;
  await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) }, ks);
  await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, ks);
}

/** @param {any} ctl */
const brief = ctl => ({ role: ctl.role, name: ctl.name || "", ...(ctl.identifier ? { identifier: ctl.identifier } : {}), ...(typeof ctl.frame === "number" ? { frame: ctl.frame } : {}) });

/** @param {any} snap @param {any} target @param {string} why */
function heldResult(snap, target, why) {
  return { ok: false, held: true, why, control: brief(target), selector: selectorOf(target), fields: fieldsOf(snap, target), sig: signatureOf(snap, target) };
}

/**
 * Set fields, one script per frame: the items are grouped by the frame their control is in. Results line up with `items`.
 * A frame that has gone answers "the control is gone", which the callers retry.
 * @param {any} ctx @param {number} tabId @param {any} snap @param {{ ctl: any, kind: string, value: any }[]} items
 */
async function applyIn(ctx, tabId, snap, items) {
  const list = await framesOf(ctx, tabId);
  /** @type {any[]} */ const out = new Array(items.length);
  /** @type {Map<number, { frame: any, idx: number[] }>} */ const groups = new Map();
  const gone = { ok: false, why: "the control is gone (its frame is gone)" };
  items.forEach((it, i) => {
    let frame;
    try { frame = refindFrame(list, it.ctl, snap); } catch { out[i] = gone; return; }
    const g = groups.get(frame.index) || { frame, idx: [] };
    g.idx.push(i); groups.set(frame.index, g);
  });
  for (const g of groups.values()) {
    try {
      const res = await evaluate(ctx, tabId, apply(g.idx.map(i => ({ path: items[i].ctl.path, kind: items[i].kind, value: items[i].value }))), {}, g.frame);
      g.idx.forEach((i, k) => { out[i] = res && res[k] ? res[k] : { ok: false, why: "the page gave no answer" }; });
    } catch (e) {
      if (g.frame.index === 0 || !(e && /** @type {any} */ (e).code === "not_found")) throw e;
      for (const i of g.idx) out[i] = gone;
    }
  }
  return out;
}

/**
 * Act on one already-bound control: hold, verify a release, then do it.
 * @param {any} ctx @param {number} tabId @param {any} snap @param {any} ctl @param {string} kind @param {any} value @param {any} release
 */
async function doAct(ctx, tabId, snap, ctl, kind, value, release, asked = false) {
  if (ctl.enabled === false) return { ok: false, why: `${JSON.stringify(ctl.name || ctl.role)} is disabled right now`, control: brief(ctl) };
  const h = holdFor(snap, ctl, kind, value);
  const want = release && (release.sig || release.signature);
  // asked: the module says the person drove this call themselves, which is the approval.
  if (h.held && !want && !asked) return heldResult(snap, h.target, h.why);
  if (want) {
    // The person approved a page state, not a control name. If the page is not that state any more, do nothing.
    if (signatureOf(snap, h.target) !== String(want)) throw err("changed", "the page changed since it was held, so nothing was done; look again and ask again");
  }
  /** @type {any} */ let point = null;
  // The evidence a label needs, read before the click changes the page; only when learning is on (nothing is computed otherwise).
  /** @type {any} */ let ev = null;
  if (ctx.sites && typeof ctx.sites.enabled === "function" && ctx.sites.enabled() && ctl.path) {
    try { const list = await framesOf(ctx, tabId); ev = await inFrame_(ctx, tabId, refindFrame(list, ctl, snap), evidence(ctl.path)); } catch { ev = null; }
  }
  if (kind === "click") point = await mouseClick(ctx, tabId, ctl, snap);
  else if (kind === "press") await pressKey(ctx, tabId, ctl, String(value), snap);
  else if (kind === "check") {
    const { loc } = await locateIn(ctx, tabId, ctl, snap, false);
    if (!loc || !loc.found) throw err("not_found", "the control disappeared");
    const wantOn = !(value === false || value === "false" || value === "off" || value === "no");
    if (loc.checked !== wantOn) await mouseClick(ctx, tabId, ctl, snap);
  } else {
    const r = await applyIn(ctx, tabId, snap, [{ ctl, kind, value }]);
    if (!r || !r[0] || !r[0].ok) return { ok: false, why: (r && r[0] && r[0].why) || "could not set the value", control: brief(ctl) };
  }
  return { ok: true, did: kind, control: brief(ctl), ...(ev && typeof ev === "object" && typeof ev.container === "string" ? { evidence: { container: ev.container, siblings: Number(ev.siblings) || 1 } } : {}), ...(point && typeof point.x === "number" ? { point: { x: Math.round(point.x), y: Math.round(point.y), frame: point.frame ?? ctl.frame ?? 0, ownSession: !!point.session }, ...(point.ms ? { ms: point.ms } : {}) } : {}) };
}


// ---------------------------------------------------------------- waiting, one helper for every op

const POLL_MS = 60;
const STABLE_MS = 150;
const BACKOFF_MS = [60, 150, 300];
const STRATEGY_ORDER = ["identifier", "role+name", "name", "name-ci", "aria", "nearby-label", "text"];

/**
 * The optional `wait` argument of page.act and page.fill: how long to keep looking for the control
 * and whether it must hold still. Absent means one look and no waiting, which is what these ops
 * always did.
 * @param {any} raw
 */
export function waitOpts(raw) {
  const w = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { timeoutMs: Math.min(Math.max(Number(w.timeoutMs) || 0, 0), 120_000), stable: w.stable === true, busyMs: w.busyMs !== undefined && Number.isFinite(Number(w.busyMs)) ? Math.max(0, Number(w.busyMs)) : undefined };
}

/**
 * @typedef {{ sel: Selector, fillable?: boolean, optional?: boolean, label?: string }} Spec
 * @typedef {{ control: any|null, strategy?: string, fallback?: boolean, why?: string, candidates?: string[], tiedFrames?: number[] }} Bound
 */

/** Frames as one candidate line: "Save [frame 1 https://app.harlow.example]". @param {any} c */
const inFrame = c => `${c.name || c.identifier || c.role} [frame ${typeof c.frame === "number" ? c.frame : 0}${c.frameOrigin ? " " + c.frameOrigin : ""}]`;

/**
 * Bind a selector to one control of a snapshot, in any frame. A selector with `frame` looks only in the frames it pins; without it every
 * frame is searched and the usual rule holds: two matches are tied, unless exactly one of them sits inside an open dialog or drawer, which
 * wins. A tie between frames names them.
 * @param {Selector} sel @param {any} snap @param {{ fillable?: boolean, within?: (c: any) => boolean }} [o] @returns {Bound}
 */
export function bindSelector(sel, snap, o = {}) {
  let controls = snap.controls;
  if (sel.frame !== undefined && snap.frames) {
    const pins = pinIndexes(snap.frames, sel.frame) || [];
    if (!pins.length) return { control: null, why: "unbound", candidates: [`no frame matches ${JSON.stringify(sel.frame)}; the frames are ${snap.frames.map((/** @type {any} */ f) => `${f.index} ${f.origin || "top"}`).join(", ")}`] };
    controls = controls.filter((/** @type {any} */ c) => pins.includes(typeof c.frame === "number" ? c.frame : 0));
  }
  const r = /** @type {Bound} */ (matchControl(sel, controls, resolve, o));
  if (r.why !== "tied" || !snap.frames || snap.frames.length < 2) return r;
  // Tied: is it the same control in two frames? The one inside an open dialog or drawer is the one the person means.
  const same = controls.filter((/** @type {any} */ c) => (!sel.role || c.role === sel.role) && ((sel.identifier && c.identifier === sel.identifier) || (sel.name && norm(c.name) === norm(sel.name))));
  const spans = [...new Set(same.map((/** @type {any} */ c) => (typeof c.frame === "number" ? c.frame : 0)))];
  if (spans.length < 2) return r;
  const inDialog = matchControl(sel, controls, resolve, { ...o, within: (/** @type {any} */ c) => c.blk !== undefined });
  if (inDialog.control) return inDialog;
  return { ...r, candidates: same.slice(0, 6).map(inFrame), tiedFrames: spans };
}

/** @param {Spec} spec @param {any} snap @returns {Bound} */
function bindOne(spec, snap) {
  const blockers = (snap.state && snap.state.blockers) || [];
  const within = spec.fillable && blockers.length ? (/** @type {any} */ c) => c.blk !== undefined : undefined;
  return bindSelector(spec.sel, snap, { fillable: spec.fillable, within });
}

/** The weakest strategy among matches, and whether any was a fallback. @param {Bound[]} bound */
function summarizeStrategy(bound) {
  const used = bound.filter(b => b.control && b.strategy);
  const worst = used.reduce((/** @type {string} */ w, b) => (STRATEGY_ORDER.indexOf(/** @type {string} */ (b.strategy)) > STRATEGY_ORDER.indexOf(w) ? /** @type {string} */ (b.strategy) : w), used.length ? /** @type {string} */ (used[0].strategy) : "");
  return { strategy: worst, fallback: used.some(b => b.fallback) };
}

/** Which frame(s) a trace is about: the first bound control's, and every frame when the controls are in more than one. @param {Bound[]} bound */
function frameTrace(bound) {
  const cs = bound.map(b => b.control).filter(Boolean);
  if (!cs.length) return {};
  const idx = (/** @type {any} */ c) => (typeof c.frame === "number" ? c.frame : 0);
  const all = [...new Set(cs.map(idx))];
  return { frame: idx(cs[0]), ...(cs[0].frameOrigin ? { frameOrigin: cs[0].frameOrigin } : {}), ...(all.length > 1 ? { frames: all } : {}) };
}

/** The spinners that matter to these controls: those in their frames (all of them on a one-frame page). @param {any} snap @param {any[]} ctls */
function busyFor(snap, ctls) {
  const st = snap.state || {};
  if (!snap.frames || snap.frames.length < 2) return st.busy;
  const want = new Set(ctls.map(c => (typeof c.frame === "number" ? c.frame : 0)));
  return snap.frames.filter((/** @type {any} */ f) => want.has(f.index)).reduce((/** @type {number} */ a, /** @type {any} */ f) => a + (f.busy || 0), 0);
}

/**
 * Where the page is and what it looks like, small and masked: the detail every failure carries, and which frame it looked in. The page
 * snippet comes from the frame the target was expected in: `frame` (a control's own), `pin` (a selector's `frame`), else the frame holding
 * the dialog in the way or the workflow builder, else the top page.
 * @param {any} ctx @param {number} tabId @param {{ path?: string, frame?: number, frameOrigin?: string, pin?: unknown, snap?: any, trace?: any, extra?: any }} [o]
 */
export async function failDetail(ctx, tabId, o = {}) {
  /** @type {any} */ let tab = null;
  try { tab = await ctx.tabs.get(tabId); } catch { /* the tab may be gone */ }
  const list = await framesOf(ctx, tabId);
  /** @type {any} */ let at = null;
  if (typeof o.frame === "number") { try { at = refindFrame(list, { frame: o.frame, frameOrigin: o.frameOrigin }, o.snap); } catch { at = null; } }
  if (!at && o.pin !== undefined && o.pin !== null) { const pins = pinIndexes(list, o.pin) || []; at = list.find(f => pins.includes(f.index) && f.readable) || null; }
  if (!at && o.snap && list.length > 1) {
    const bl = ((o.snap.state && o.snap.state.blockers) || []).filter((/** @type {any} */ b) => b.modal && typeof b.frame === "number").pop();
    const gi = Array.isArray(o.snap.ghlFrames) ? o.snap.ghlFrames[0] : undefined;
    const want = bl ? bl.frame : gi;
    at = typeof want === "number" ? list.find(f => f.index === want && f.readable) || null : null;
  }
  if (!at) at = list[0];
  /** @type {string|undefined} */ let dom;
  try { const r = await evaluate(ctx, tabId, domOutline(typeof o.frame === "number" || !o.pin ? o.path : undefined), {}, at); dom = redactDom(r && r.html, 2048); } catch { /* the page may be gone or blind */ }
  const looked = { frame: at.index, ...(at.origin ? { frameOrigin: at.origin } : {}), ...(list.length > 1 ? { searched: typeof o.frame === "number" ? `frame ${at.index}` : o.pin !== undefined && o.pin !== null ? `frame ${at.index} (pinned)` : "all readable frames", frames: list.map(f => ({ index: f.index, origin: f.origin, readable: f.readable })) } : {}) };
  return { ...(tab ? { tab: whereOf(tab.pendingUrl || tab.url) } : {}), ...looked, ...(o.trace ? { trace: traceOf(o.trace) } : {}), ...(dom ? { dom } : {}), ...(o.extra || {}) };
}

/** @param {any} ctx @param {number} tabId @param {any} snap @param {any} blocker @param {any} trace */
async function modalError(ctx, tabId, snap, blocker, trace) {
  const d = describeBlocker(blocker, snap);
  const detail = await failDetail(ctx, tabId, { path: blocker.path, ...(typeof blocker.frame === "number" ? { frame: blocker.frame, frameOrigin: (snap.frames.find((/** @type {any} */ f) => f.index === blocker.frame) || {}).origin } : {}), snap, trace, extra: { blockers: [{ ...d, ...(typeof blocker.frame === "number" ? { frame: blocker.frame } : {}) }] } });
  const shown = (d.title || d.text || "a dialog").slice(0, 80);
  const how = d.kind === "unsafe" ? "It asks about changes or a confirmation, so it was not dismissed." : "It is not one of the popups Vyre dismisses on its own.";
  const where = typeof blocker.frame === "number" && blocker.frame > 0 ? ` (in frame ${blocker.frame})` : "";
  return err("modal", `a dialog is blocking the page${where}: ${JSON.stringify(shown)}. ${how} Read it, then act on one of its own controls (${d.controls.map(c => JSON.stringify(c)).join(", ") || "none listed"}).`, detail);
}

/**
 * Bind selectors to controls, waiting up to wait.timeoutMs for them to exist, be enabled, be in
 * front of any modal dialog, be free of loading spinners and (wait.stable) hold still for 150 ms.
 * A safe popup in the way (what's new, tour, cookies) is dismissed and reported; any other dialog
 * in front of a control is an error that describes it. Loading spinners are soft: after a grace
 * period the wait gives up on them and says so in the trace, so one endlessly animated element
 * cannot stall a flow. timeoutMs 0 is one look. Every look re-lists the frames and reads all of them, so a frame that
 * appears late or navigates while waiting is picked up, and a control is looked for in every frame (or the one its selector pins).
 * @param {any} ctx @param {number} tabId @param {Spec[]} specs @param {ReturnType<typeof waitOpts>} wait @param {number} [t0]
 */
async function acquire(ctx, tabId, specs, wait, t0 = Date.now()) {
  /** @type {any[]} */ const dismissed = [];
  let dismissals = 0, prevKey = "", sameSince = 0;
  const busyGrace = wait.busyMs !== undefined ? wait.busyMs : Math.min(wait.timeoutMs * 0.6, 3000);
  /** @type {any} */ let flags = {};
  for (;;) {
    if (ctx.stopped()) throw err("stopped");
    const snap = await snapshot(ctx, tabId);
    const elapsed = Date.now() - t0;
    const bound = specs.map(sp => bindOne(sp, snap));
    const done = (/** @type {any} */ extra) => ({ snap, bound, trace: { ...summarizeStrategy(bound), waitedMs: Date.now() - t0, retries: 0, newTab: false, ...frameTrace(bound), ...(dismissed.length ? { dismissed } : {}), ...flags, ...(extra || {}) } });
    // A modal dialog in front of the page. A missing control might live behind it, so it counts too.
    /** @type {any} */ let blocker = null;
    for (const b of bound) { blocker = topBlocker(snap, b.control); if (blocker) break; }
    if (blocker) {
      const c = classifyBlocker(blocker, snap);
      if (c.kind === "safe" && dismissals < 3) {
        await mouseClick(ctx, tabId, c.closer, snap);
        dismissals++;
        dismissed.push({ what: (blocker.title || blocker.text || "").slice(0, 60), control: String(c.closer.name).slice(0, 30), ...(typeof blocker.frame === "number" ? { frame: blocker.frame } : {}) });
        await nap(ctx, 180); // the dialog's own closing animation
        continue;
      }
      const anyFound = bound.some(b => b.control);
      // Something that asks about changes is surfaced at once when it is in the way; an unfamiliar one, or a control
      // that has not rendered yet, gets the rest of the wait first (a dialog may close itself, a drawer may still be filling).
      if ((c.kind === "unsafe" && anyFound) || c.kind === "safe" || elapsed >= wait.timeoutMs) throw await modalError(ctx, tabId, snap, blocker, done().trace);
      await nap(ctx, POLL_MS);
      continue;
    }
    if (!bound.some(b => !b.control)) {
      const ctls = bound.map(b => b.control);
      let ready = true;
      const busy = busyFor(snap, ctls);
      if (busy > 0 && elapsed < busyGrace) ready = false;
      else if (busy > 0) flags = { ...flags, busyIgnored: true };
      if (ctls.some(c => c.enabled === false) && elapsed < wait.timeoutMs) ready = false;
      if (wait.stable) {
        const key = ctls.map(c => c.path + "@" + (c.frame ?? "") + JSON.stringify(c.box)).join("|");
        if (key !== prevKey) { prevKey = key; sameSince = Date.now(); ready = false; } else if (Date.now() - sameSince < STABLE_MS) ready = false;
      }
      if (ready) return done();
      if (elapsed >= wait.timeoutMs) return done(wait.stable ? { unstable: true } : undefined);
    } else if (elapsed >= wait.timeoutMs) return done();
    await nap(ctx, POLL_MS);
  }
}

/** A control that vanished or was covered between the look and the click (its frame going away counts). */
const isStale = (/** @type {any} */ e) => e && ((e.code === "not_found" && /disappeared|gone/.test(String(e.message))) || e.code === "covered");

/** The error for a selector that bound nothing. @param {any} ctx @param {number} tabId @param {Selector} sel @param {Bound} b @param {any} got @param {any} trace */
async function notFoundError(ctx, tabId, sel, b, got, trace) {
  const tied = b.why === "tied";
  const detail = await failDetail(ctx, tabId, { trace, pin: sel.frame, snap: got.snap, extra: { candidates: b.candidates && b.candidates.length ? b.candidates : nearMisses(String(sel.name || sel.identifier || ""), got.snap.controls), ...(b.tiedFrames ? { tiedFrames: b.tiedFrames } : {}) } });
  const inWhich = tied && b.tiedFrames ? ` in frames ${b.tiedFrames.join(" and ")}` : "";
  return err(tied ? "tied" : "not_found", `${tied ? "more than one control matches" : "nothing matches"} ${JSON.stringify({ role: sel.role, name: sel.name, identifier: sel.identifier, ...(sel.frame !== undefined ? { frame: sel.frame } : {}) })}${inWhich}`, detail);
}

/**
 * The settle step of page.wait: no spinners, the DOM quiet for quietMs and the network quiet for
 * netQuietMs, in EVERY readable frame (the snapshot merges them, and re-lists them each look, so a frame that appears or navigates
 * mid-wait counts). Spinners, a page that never goes quiet and requests that never end are soft after a
 * grace period (reported, not fatal). A page with no state (a test double) has nothing to wait on.
 * @param {any} ctx @param {number} tabId @param {{ quietMs?: number, netQuietMs?: number }} o @param {number} t0 @param {number} timeoutMs
 */
export async function settleLoop(ctx, tabId, o, t0, timeoutMs) {
  const domNeed = o.quietMs ?? 150, netNeed = o.netQuietMs ?? 250;
  const softAt = Math.min(timeoutMs / 2, 2500);
  /** @type {any} */ const flags = {};
  for (;;) {
    if (ctx.stopped()) throw err("stopped");
    const snap = await snapshot(ctx, tabId);
    const st = snap.state;
    if (!st) return flags;
    if (snap.notReadable && snap.notReadable.length) flags.framesNotReadable = snap.notReadable.length;
    const el = Date.now() - t0;
    const soft = el >= softAt;
    const netQuiet = st.netPending === 0 && st.netQuietMs >= netNeed;
    if ((!st.busy || soft) && (st.domQuietMs >= domNeed || soft) && (netQuiet || soft)) {
      if (st.busy) flags.busyIgnored = true;
      if (st.domQuietMs < domNeed) flags.domNeverQuiet = true;
      if (!netQuiet) flags.netIgnored = true;
      return flags;
    }
    if (el >= timeoutMs) throw err("timeout", `the page did not settle in ${timeoutMs} ms`, await failDetail(ctx, tabId, { snap, trace: { strategy: "settled", waitedMs: el }, extra: { state: { busy: st.busy, domQuietMs: st.domQuietMs, netPending: st.netPending } } }));
    await nap(ctx, POLL_MS);
  }
}

/**
 * The first readable frame (of those `pin` names, or all) where a CSS selector matches, or null.
 * @param {any} ctx @param {number} tabId @param {string} css @param {unknown} pin
 */
async function existsAnywhere(ctx, tabId, css, pin) {
  const list = await framesOf(ctx, tabId);
  const pins = pinIndexes(list, pin);
  for (const f of list) {
    if (!f.readable || (pins && !pins.includes(f.index))) continue;
    try { if (await evaluate(ctx, tabId, exists(css), {}, f)) return f; } catch (e) { if (f.index === 0) throw e; /* a child frame that went away just is not there */ }
  }
  return null;
}

/** @param {any} ctx @param {number} tabId @param {any} args */
async function waitFor(ctx, tabId, args) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10_000, 100), 120_000);
  const idleMs = Number(args.idleMs) || 0;
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const kinds = [args.selector != null, typeof args.url === "string", idleMs > 0, args.settled === true].filter(Boolean).length;
  if (kinds !== 1) throw err("bad_request", "page.wait needs exactly one of selector, url, idleMs or settled");
  /** @param {string} strategy @param {any} [extra] */
  const trace = (strategy, extra) => traceOf({ strategy, fallback: false, waitedMs: Date.now() - t0, retries: 0, newTab: false, ...(extra || {}) });
  const timeout = async (/** @type {any} */ tr) => err("timeout", `still waiting after ${timeoutMs} ms${args.frame !== undefined ? ` (looking in frame ${JSON.stringify(args.frame)})` : " (looking in every readable frame)"}`, await failDetail(ctx, tabId, { trace: tr, pin: args.frame }));
  const ok = (/** @type {any} */ tr) => ({ ok: true, waitedMs: Date.now() - t0, trace: tr });
  const where = (/** @type {any} */ f) => (f ? { frame: f.index, ...(f.origin ? { frameOrigin: f.origin } : {}) } : {});

  if (args.settled === true) return ok(trace("settled", await settleLoop(ctx, tabId, args, t0, timeoutMs)));
  if (typeof args.selector === "string" && /[.#\[:>]/.test(args.selector)) {
    // A CSS selector: existence only (or absence, with gone), in any readable frame (or the one `frame` names).
    while (true) {
      if (ctx.stopped()) throw err("stopped");
      const hit = await existsAnywhere(ctx, tabId, args.selector, args.frame);
      if (!!hit !== (args.gone === true)) return ok(trace("css", where(hit)));
      if (Date.now() >= deadline) throw await timeout(trace("css"));
      await nap(ctx, 100);
    }
  }
  if (args.selector != null) {
    const sel = selectorArg(args.selector);
    if (sel.frame === undefined && args.frame !== undefined && args.frame !== null && args.frame !== "") sel.frame = args.frame;
    if (args.gone === true) {
      while (true) {
        if (ctx.stopped()) throw err("stopped");
        if (!bindSelector(sel, await snapshot(ctx, tabId)).control) return ok(trace("absent"));
        if (Date.now() >= deadline) throw await timeout(trace("absent"));
        await nap(ctx, 100);
      }
    }
    const got = await acquire(ctx, tabId, [{ sel }], { timeoutMs, stable: args.stable === true, busyMs: undefined }, t0);
    const b = got.bound[0];
    if (!b.control || (args.enabled === true && b.control.enabled === false)) throw await timeout(got.trace);
    const flags = args.quietMs !== undefined || args.netQuietMs !== undefined ? await settleLoop(ctx, tabId, args, t0, Math.max(100, deadline - Date.now())) : {};
    return ok(traceOf({ ...got.trace, ...flags, waitedMs: Date.now() - t0 }));
  }
  const byUrl = typeof args.url === "string";
  while (true) {
    if (ctx.stopped()) throw err("stopped");
    /** @type {any} */ let hitFrame = null;
    let done;
    if (byUrl) {
      const list = await framesOf(ctx, tabId);
      const pins = pinIndexes(list, args.frame);
      const topHref = pins && !pins.includes(0) ? "" : String(await evaluate(ctx, tabId, href()));
      if (topHref.includes(args.url)) { done = true; hitFrame = list[0]; }
      else { hitFrame = list.find(f => f.index > 0 && (!pins || pins.includes(f.index)) && String(f.url || "").includes(args.url)) || null; done = !!hitFrame; }
    } else {
      const list = await framesOf(ctx, tabId);
      const pins = pinIndexes(list, args.frame);
      let least = Infinity;
      for (const f of list) {
        if (!f.readable || (pins && !pins.includes(f.index))) continue;
        try { least = Math.min(least, Number(await evaluate(ctx, tabId, quiet(), {}, f))); } catch (e) { if (f.index === 0) throw e; }
      }
      done = least >= idleMs;
    }
    if (done) return ok(trace(byUrl ? "url" : "idle", byUrl ? where(hitFrame) : {}));
    if (Date.now() >= deadline) throw await timeout(trace(byUrl ? "url" : "idle"));
    await nap(ctx, 100);
  }
}

// ---------------------------------------------------------------- ops

/** A page.fill field as a spec: a selector, or a plain label matched the way a person reads a form. @param {any} f @param {number} i @returns {Spec} */
function fieldSpec(f, i) {
  if (f && f.selector != null) return { sel: selectorArg(f.selector), optional: f.optional === true };
  if (f && typeof f.label === "string" && f.label.trim()) return { sel: { name: f.label.trim(), ...(f.frame !== undefined && f.frame !== null && f.frame !== "" ? { frame: f.frame } : {}) }, fillable: true, optional: f.optional === true, label: f.label.trim() };
  throw err("bad_request", `field ${i}: a field needs a selector or a label`);
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "page",
  ops: {
    "page.snapshot": async (args, ctx) => {
      const tabId = await tabOf(args, ctx, "page.snapshot");
      const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : undefined;
      const s = await snapshot(ctx, tabId, { limit });
      return { ...s, controls: s.controls.map((/** @type {any} */ { fields, form, ...c }) => c) };
    },

    "page.act": async (args, ctx, trust = {}) => {
      const tabId = await tabOf(args, ctx, "page.act");
      const kind = String(args.kind || "click");
      if (!["click", "type", "select", "check", "press"].includes(kind)) throw err("bad_request", `unknown kind ${JSON.stringify(kind)}`);
      if ((kind === "type" || kind === "select" || kind === "press") && (args.value === undefined || args.value === null)) throw err("bad_request", `${kind} needs a value`);
      const sel = selectorArg(args.selector);
      const wait = waitOpts(args.wait);
      const t0 = Date.now();
      let retries = 0;
      /** @type {string[]} */ const retryWhy = [];
      for (;;) {
        const got = await acquire(ctx, tabId, [{ sel, fillable: args.fillable === true }], wait, t0);
        const b = got.bound[0];
        const trace = { ...got.trace, waitedMs: Date.now() - t0, retries, ...(retryWhy.length ? { retryWhy } : {}) };
        if (!b.control) {
          if (args.optional === true && b.why === "unbound") return { ok: true, skipped: true, why: `no control matches ${JSON.stringify(sel.name || sel.identifier)}, and this step is optional`, trace: traceOf(trace) };
          throw await notFoundError(ctx, tabId, sel, b, got, trace);
        }
        try {
          const r = await doAct(ctx, tabId, got.snap, b.control, kind, args.value, trust.release, trust.asked === true);
          if (r.ok === false && /gone|disappeared/.test(String(r.why))) throw err("not_found", "the control disappeared");
          if (r.ok === false && !r.held) return { ...r, trace: traceOf(trace), ...(await failDetail(ctx, tabId, { path: b.control.path, frame: b.control.frame ?? 0, frameOrigin: b.control.frameOrigin, snap: got.snap })) };
          return { ...r, trace: traceOf(trace) };
        } catch (e) {
          if (isStale(e) && retries < BACKOFF_MS.length) { retryWhy.push(`${Date.now() - t0}ms: ${String(/** @type {any} */ (e)?.message || e).slice(0, 140)}`); await nap(ctx, BACKOFF_MS[retries++]); continue; }
          if (e && /** @type {any} */ (e).detail !== undefined) throw e;
          throw err(/** @type {any} */ (e)?.code || "error", String(/** @type {any} */ (e)?.message || e), await failDetail(ctx, tabId, { path: b.control.path, frame: b.control.frame ?? 0, frameOrigin: b.control.frameOrigin, snap: got.snap, trace }));
        }
      }
    },

    "page.fill": async (args, ctx, trust = {}) => {
      const tabId = await tabOf(args, ctx, "page.fill");
      if (!Array.isArray(args.fields) || !args.fields.length) throw err("bad_request", "page.fill needs fields: [{selector | label, value}]");
      if (args.fields.length > 100) throw err("bad_request", "page.fill takes at most 100 fields");
      const partial = args.partial === true;
      const wait = waitOpts(args.wait);
      const specs = args.fields.map((/** @type {any} */ f, /** @type {number} */ i) => fieldSpec(f, i));
      const asked = (/** @type {number} */ i) => String(specs[i].label || specs[i].sel.name || specs[i].sel.identifier || "");
      const t0 = Date.now();
      let retries = 0;
      for (;;) {
        const got = await acquire(ctx, tabId, specs, wait, t0);
        const trace = { ...got.trace, waitedMs: Date.now() - t0, retries };
        /** @type {Map<number, { why: string, candidates: string[] }>} */
        const lost = new Map();
        got.bound.forEach((/** @type {Bound} */ b, /** @type {number} */ i) => {
          if (!b.control) lost.set(i, { why: b.why === "tied" ? "more than one control matches" : "nothing matches", candidates: b.candidates && b.candidates.length ? b.candidates : nearMisses(asked(i), got.snap.controls, 4).map(c => c.name) });
        });
        // Resolve every field first: a fill that lands half the form is worse than one that lands none (unless partial was asked for).
        const hard = [...lost.keys()].filter(i => !specs[i].optional);
        if (hard.length && !partial) {
          const i = hard[0], l = /** @type {any} */ (lost.get(i));
          throw err(l.why.startsWith("more") ? "tied" : "not_found", `field ${i}: ${l.why} ${JSON.stringify({ role: specs[i].sel.role, name: specs[i].sel.name, identifier: specs[i].sel.identifier, ...(specs[i].sel.frame !== undefined ? { frame: specs[i].sel.frame } : {}) })}`, await failDetail(ctx, tabId, { trace, pin: specs[i].sel.frame, snap: got.snap, extra: { candidates: l.candidates } }));
        }
        const off = got.bound.findIndex((/** @type {Bound} */ b) => b.control && b.control.enabled === false);
        if (off >= 0 && !partial) throw err("bad_request", `field ${off} is disabled`, await failDetail(ctx, tabId, { path: got.bound[off].control.path, frame: got.bound[off].control.frame ?? 0, frameOrigin: got.bound[off].control.frameOrigin, snap: got.snap, trace }));
        const use = got.bound.map((/** @type {Bound} */ b, /** @type {number} */ i) => ({ b, i })).filter(x => x.b.control && x.b.control.enabled !== false);
        const results = use.length ? await applyIn(ctx, tabId, got.snap, use.map(x => ({ ctl: x.b.control, kind: "auto", value: args.fields[x.i].value }))) : [];
        if (retries < BACKOFF_MS.length && results.some((/** @type {any} */ r) => r && r.ok === false && /gone/.test(String(r.why)))) { await nap(ctx, BACKOFF_MS[retries++]); continue; }
        const byField = new Map(use.map((x, k) => [x.i, results[k]]));
        const summary = got.bound.map((/** @type {Bound} */ b, /** @type {number} */ i) => {
          const c = b.control;
          if (!c) return { name: asked(i), ok: false, why: /** @type {any} */ (lost.get(i)).why, ...(specs[i].optional ? { optional: true } : {}) };
          const cname = c.name || c.identifier || c.role;
          if (c.enabled === false) return { name: asked(i), matched: cname, ok: false, why: "disabled" };
          const r = byField.get(i);
          return { name: specs[i].label ? asked(i) : cname, ...(specs[i].label ? { matched: cname } : {}), ok: !!(r && r.ok), strategy: b.strategy, ...(b.fallback ? { fallback: true } : {}), ...(r && r.why ? { why: r.why } : {}) };
        });
        const filled = summary.filter((/** @type {any} */ s) => s.ok).length;
        const notFound = [...lost.keys()].map(asked);
        const failed = summary.filter((/** @type {any} */ s) => !s.ok && !s.optional);
        if (failed.length) {
          const lostHard = hard.map(asked);
          return { ok: false, why: lostHard.length ? `could not find: ${lostHard.join(", ")}` : "some fields could not be set", filled, fields: summary, ...(notFound.length ? { notFound } : {}), trace: traceOf(trace), ...(await failDetail(ctx, tabId, { snap: got.snap, ...(got.bound.find((/** @type {Bound} */ b) => b.control) ? { frame: got.bound.find((/** @type {Bound} */ b) => b.control)?.control.frame ?? 0, frameOrigin: got.bound.find((/** @type {Bound} */ b) => b.control)?.control.frameOrigin } : {}), extra: { candidates: [...lost.values()][0]?.candidates } })) };
        }
        if (args.submit !== true) return { ok: true, filled, fields: summary, ...(notFound.length ? { notFound, skipped: notFound } : {}), trace: traceOf(trace) };
        const after = await snapshot(ctx, tabId);
        const form = got.bound.find((/** @type {Bound} */ b) => b.control)?.control.form;
        const formFrame = got.bound.find((/** @type {Bound} */ b) => b.control)?.control.frame;
        const btn = after.controls.find((/** @type {any} */ c) => c.submit && c.form === form && sameFrame(c, { frame: formFrame })) || after.controls.find((/** @type {any} */ c) => c.submit && sameFrame(c, { frame: formFrame })) || after.controls.find((/** @type {any} */ c) => c.submit);
        if (!btn) return { ok: true, filled, fields: summary, submitted: false, why: "no submit control found", trace: traceOf(trace) };
        const r = await doAct(ctx, tabId, after, btn, "click", undefined, trust.release, trust.asked === true);
        return { ...r, filled, trace: traceOf(trace), ...(r.ok ? { submitted: true } : {}) };
      }
    },

    "page.eval": async (args, ctx, trust = {}) => {
      if (typeof args.expression !== "string" || !args.expression.trim()) throw err("bad_request", "page.eval needs an expression");
      const tabId = await tabOf(args, ctx, "page.eval");
      // The frame the script runs in: the top page unless `frame` names one (an index, a frame id, or a piece of its origin or URL).
      const list = await framesOf(ctx, tabId);
      const pins = pinIndexes(list, args.frame);
      const frame = pins ? list.find(f => pins.includes(f.index)) : list[0];
      if (!frame) throw err("not_found", `no frame matches ${JSON.stringify(args.frame)}; the frames are ${list.map(f => `${f.index} ${f.origin || "top"}`).join(", ")}`, { frames: list.map(f => ({ index: f.index, origin: f.origin, readable: f.readable })) });
      if (!frame.readable) throw err("not_found", `frame ${frame.index} (${frame.origin || "?"}) is not readable: ${frame.why || "it has gone"}`);
      const run = (/** @type {any} */ f, /** @type {string} */ expression, /** @type {any} */ extra) => (f.how !== "top" && ctx.frames ? ctx.frames.evalIn(tabId, f, expression, { returnByValue: true, ...extra }) : ctx.cdp.send(tabId, "Runtime.evaluate", { expression, returnByValue: true, ...extra }));
      // A script can read what redaction cannot recognise (a typed password is just text), so a page
      // with a visible password field is not one it runs on at all. That means EVERY frame of the tab we can read: a login form in an
      // iframe makes the script refuse just as one in the top page does. (A frame Vyre cannot read is blind here, as a closed shadow root always was.)
      for (const f of list) {
        if (!f.readable) continue;
        /** @type {any} */ let pw;
        try { pw = await run(f, passwordFieldScript, {}); } catch (e) { throw err("blocked", `could not check frame ${f.index} (${f.origin || "top"}) for a password field, so a script is not run on this page: ${String(/** @type {any} */ (e)?.message || e).slice(0, 100)}`); }
        if (pw && pw.result && pw.result.value === true) throw err("blocked", f.index === 0 ? "this page has a password field, so a script is not run on it" : `frame ${f.index} (${f.origin || "?"}) has a password field, so a script is not run on this page`);
      }
      // Hands-free, except that a script's own network SENDS (a message, a post, a payment) are held
      // back and reported unless the person asked: the script runs, the send waits at the Gate. The shim goes into the frame the
      // script runs in, and is read back from there.
      // A script that opens the page's stored login is refused, and one that WRITES with it (fetch, XHR, beacon, form submit) is refused: nothing is sent.
      if (CREDENTIAL_STORE.test(String(args.expression))) throw err("blocked", "the script reads the page's stored login (IndexedDB or storage auth tokens, cookies). Vyre does not hand a login to a script, and a script should not hold one. Use chrome_api (action \"call\"): it signs the request with the page's own login inside the page, and the token is never in your hands. Prefer api.call over eval-fetch.");
      const guarded = trust.asked !== true;
      const egress = guarded ? await egressGuard(ctx, tabId, frame && frame.how !== "top" ? frame : null, { noFetch: trust.noFetch === true, diag: trust.diag === true, failEnable: trust.failEnable === true }) : (await clearDenied(ctx, tabId), null);
      if (guarded) await run(frame, `window.__vyreAllow = ${JSON.stringify(egress && egress.allowed || [])};` + guardInstallWrites, {});
      /** @type {any} */ let r;
      /** @type {any[]} */ let blocked = [];
      /** @type {any[]} */ let outside = [];
      try { r = await run(frame, args.expression, { awaitPromise: true, timeout: 10_000 }); }
      finally {
        if (guarded) { const c = await run(frame, guardCollect, {}).catch(() => null); { const bv = c && c.result && c.result.value; blocked = Array.isArray(bv) ? bv : []; } }
        if (egress) outside = await egress.stop().catch(() => []);
      }
      if (outside.length) { const b = outside[0]; return { ...heldRequest(b.method, b.origin, (b.method === "GUARD" ? (b.stopped ? b.origin : `${b.origin}. A request MAY HAVE BEEN SENT`) : `the script tried to reach ${b.origin}, which is not this page or anything it already talks to${b.leaked ? ". The request could not be stopped in time and MAY HAVE BEEN SENT" : ""}`), `${args.expression}\n${b.method} ${b.origin}`), diag: trust.diag === true && egress && egress.diag ? egress.diag() : undefined, egress: outside.slice(0, 10).map((/** @type {any} */ x) => ({ method: x.method, origin: x.origin, type: x.type, ...(x.session ? { session: "child" } : {}), ...(x.leaked ? { leaked: true } : {}) })) }; }
      const wrote = blocked.find((/** @type {any} */ b) => b.write);
      if (wrote) throw err("blocked", `the script tried to ${wrote.method} ${redact.url(wrote.url)} with the page's own login. Nothing was sent. A script may read with the page's login but not write with it: use chrome_api (action "call"), which makes the same request from inside the page, names it, and is asked first. Prefer api.call over eval-fetch.`);
      if (blocked.length) { const b = blocked[0]; return heldRequest(b.method, b.url, b.why, `${args.expression}\n${b.method} ${b.url}`); }
      const where = { frame: frame.index, ...(frame.origin ? { frameOrigin: frame.origin } : {}) };
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        return { ok: false, error: redact.text(String((d.exception && d.exception.description) || d.text || "the page threw")), ...(list.length > 1 ? where : {}) };
      }
      const res = (r && r.result) || {};
      const value = res.value !== undefined ? res.value : res.description;
      const unread = list.filter(f => !f.readable).map(f => ({ index: f.index, origin: f.origin }));
      return { ok: true, type: res.type, value: redact.value(value), ...(list.length > 1 ? where : {}), ...(unread.length ? { notScanned: unread } : {}), ...(egress && egress.contained === "partial" ? { contained: "partial", containedWhy: egress.why || "no browser-level guard" } : {}) };
    },

    "page.wait": async (args, ctx) => waitFor(ctx, await tabOf(args, ctx, "page.wait"), args),

    "page.screenshot": async (args, ctx) => {
      const tabId = await tabOf(args, ctx, "page.screenshot");
      const format = args.format === "png" ? "png" : "jpeg";
      const quality = Math.min(Math.max(Math.round(Number(args.quality) || 60), 10), 100);
      const r = await ctx.cdp.send(tabId, "Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality } : {}) });
      const data = String((r && r.data) || "");
      // Chrome caps one native message at 1 MB toward the host; refuse rather than lose the frame.
      if (data.length > 900_000) throw err("bad_request", "the screenshot is too large for one message; use jpeg with a lower quality");
      return { ok: true, image: { mime: `image/${format}`, bytes: data.length, data } };
    },
  },
};
