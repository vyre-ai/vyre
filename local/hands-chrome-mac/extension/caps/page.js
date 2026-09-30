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

import { redact } from "../lib/shared.js";
import { passwordFieldScript } from "../shared/guards.js";
import { guardInstall, guardCollect, held as heldRequest } from "../shared/outbound.js";
import { egressGuard } from "./net.js";
import { isGhlHost } from "../shared/ghlhosts.js";
import { err } from "../lib/err.js";
import { matchControl, nearMisses, topBlocker, classifyBlocker, describeBlocker, redactDom, whereOf, traceOf, nap } from "../lib/ui.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- selector (copied)

export const WEIGHT = { identifier: 100, name: 40, container: 10, path: 1 };

/** @typedef {{ role?: string, identifier?: string, name?: string, container?: string, path?: string }} Selector */

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
export const selectorOf = ctl => ({ role: ctl.role, identifier: ctl.identifier || undefined, name: ctl.name || undefined, container: ctl.container || undefined, path: ctl.path });

/** @param {any} raw @returns {Selector} */
function selectorArg(raw) {
  if (typeof raw === "string" && raw.trim()) return { name: raw.trim() };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { role, identifier, name, container, path } = raw;
    const s = { role, identifier, name, container, path };
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
    const c = { path: pathOf(el), role, enabled: !disabled, frame: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
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
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "PATH", "IMG", "LINK", "META", "IFRAME", "HEAD"]);
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

// ---------------------------------------------------------------- CDP plumbing

/**
 * @param {any} ctx @param {number} tabId @param {string} expression @param {any} [extra]
 */
async function evaluate(ctx, tabId, expression, extra = {}) {
  const r = await ctx.cdp.send(tabId, "Runtime.evaluate", { expression, returnByValue: true, timeout: 10_000, ...extra });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw err("error", String((d.exception && d.exception.description) || d.text || "the page threw"));
  }
  return r && r.result ? r.result.value : undefined;
}

/** @param {any} raw */
export function toSnapshot(raw) {
  const controls = Array.isArray(raw && raw.controls) ? raw.controls : [];
  return {
    title: (raw && raw.title) || "", url: (raw && raw.url) || "", text: (raw && raw.text) || "",
    ...(raw && raw.state ? { state: raw.state } : {}),
    controls, named: controls.filter((/** @type {any} */ c) => !c.nameless).length, nameless: controls.filter((/** @type {any} */ c) => c.nameless).length,
  };
}

/** @param {any} ctx @param {number} tabId */
const snapshot = async (ctx, tabId) => toSnapshot(await evaluate(ctx, tabId, EXPRESSION));

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
  const near = snap.controls.filter((/** @type {any} */ c) => ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch"].includes(c.role) && (!ctl.container || c.container === ctl.container));
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
  const secrets = snap.controls.filter((/** @type {any} */ c) => c.length != null && (!ctl.container || c.container === ctl.container)).map((/** @type {any} */ c) => `${c.name || c.identifier}#${c.length}`).sort();
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
  let path = "", host = "";
  try { const u = new URL(String(snap && snap.url)); path = u.pathname; host = u.hostname; } catch { return false; }
  // Only GoHighLevel (a workflow page on some other site is not one), and the local fixture's /ghl.
  // GoHighLevel's own domains, one the person listed as their white-label host, or the local fixture.
  // A white-label domain counts automatically only with BOTH the page's own traffic reaching GoHighLevel's API hosts AND
  // GoHighLevel's real workflow URL shape; a host the person listed (`config ghl-host`) counts on its own.
  const whiteLabel = Boolean(snap && snap.state && snap.state.ghlApi === true) && /^\/(v2\/)?location\/[A-Za-z0-9]{10,40}\/automation\/workflows(\/|$)/.test(path);
  if (!isGhlHost(host) && !whiteLabel && !(/^(127\.0\.0\.1|localhost)$/.test(host) && /^\/ghl(\/|$)/.test(path))) return false;
  if (!/\/automation\/workflows|\/workflows?(\/|$)|^\/ghl(\/|$)/i.test(path)) return false;
  const name = String(ctl.name || "").trim();
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
    const sub = snap.controls.find((/** @type {any} */ c) => c.submit && c.form === ctl.form);
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

/** @param {any} ctx @param {number} tabId @param {string} path */
async function mouseClick(ctx, tabId, path) {
  const loc = await evaluate(ctx, tabId, locate(path));
  if (!loc || !loc.found) throw err("not_found", "the control disappeared before it could be clicked");
  if (!loc.hit) throw err("covered", "another element covers the control, so nothing was clicked");
  const p = { x: loc.x, y: loc.y, button: "left", clickCount: 1 };
  await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: loc.x, y: loc.y });
  await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...p });
  await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p });
  return loc;
}

/** @param {any} ctx @param {number} tabId @param {string} path @param {string} key */
async function pressKey(ctx, tabId, path, key) {
  const k = KEYS[key] || (key.length === 1 ? { code: /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : "", vk: key.toUpperCase().charCodeAt(0), text: key } : null);
  if (!k) throw err("bad_request", `unknown key ${JSON.stringify(key)}`);
  const loc = await evaluate(ctx, tabId, locate(path, true));
  if (!loc || !loc.found) throw err("not_found", "the control disappeared before the key was pressed");
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
  await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** @param {any} ctl */
const brief = ctl => ({ role: ctl.role, name: ctl.name || "", ...(ctl.identifier ? { identifier: ctl.identifier } : {}) });

/** @param {any} snap @param {any} target @param {string} why */
function heldResult(snap, target, why) {
  return { ok: false, held: true, why, control: brief(target), selector: selectorOf(target), fields: fieldsOf(snap, target), sig: signatureOf(snap, target) };
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
  if (kind === "click") await mouseClick(ctx, tabId, ctl.path);
  else if (kind === "press") await pressKey(ctx, tabId, ctl.path, String(value));
  else if (kind === "check") {
    const loc = await evaluate(ctx, tabId, locate(ctl.path));
    if (!loc || !loc.found) throw err("not_found", "the control disappeared");
    const wantOn = !(value === false || value === "false" || value === "off" || value === "no");
    if (loc.checked !== wantOn) await mouseClick(ctx, tabId, ctl.path);
  } else {
    const r = await evaluate(ctx, tabId, apply([{ path: ctl.path, kind, value }]));
    if (!r || !r[0] || !r[0].ok) return { ok: false, why: (r && r[0] && r[0].why) || "could not set the value", control: brief(ctl) };
  }
  return { ok: true, did: kind, control: brief(ctl) };
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
 * @typedef {{ control: any|null, strategy?: string, fallback?: boolean, why?: string, candidates?: string[] }} Bound
 */

/** @param {Spec} spec @param {any} snap @returns {Bound} */
function bindOne(spec, snap) {
  const blockers = (snap.state && snap.state.blockers) || [];
  const within = spec.fillable && blockers.length ? (/** @type {any} */ c) => c.blk !== undefined : undefined;
  return matchControl(spec.sel, snap.controls, resolve, { fillable: spec.fillable, within });
}

/** The weakest strategy among matches, and whether any was a fallback. @param {Bound[]} bound */
function summarizeStrategy(bound) {
  const used = bound.filter(b => b.control && b.strategy);
  const worst = used.reduce((/** @type {string} */ w, b) => (STRATEGY_ORDER.indexOf(/** @type {string} */ (b.strategy)) > STRATEGY_ORDER.indexOf(w) ? /** @type {string} */ (b.strategy) : w), used.length ? /** @type {string} */ (used[0].strategy) : "");
  return { strategy: worst, fallback: used.some(b => b.fallback) };
}

/**
 * Where the page is and what it looks like, small and masked: the detail every failure carries.
 * @param {any} ctx @param {number} tabId @param {{ path?: string, trace?: any, extra?: any }} [o]
 */
export async function failDetail(ctx, tabId, o = {}) {
  /** @type {any} */ let tab = null;
  try { tab = await ctx.tabs.get(tabId); } catch { /* the tab may be gone */ }
  /** @type {string|undefined} */ let dom;
  try { const r = await evaluate(ctx, tabId, domOutline(o.path)); dom = redactDom(r && r.html, 2048); } catch { /* the page may be gone or blind */ }
  return { ...(tab ? { tab: whereOf(tab.pendingUrl || tab.url) } : {}), ...(o.trace ? { trace: traceOf(o.trace) } : {}), ...(dom ? { dom } : {}), ...(o.extra || {}) };
}

/** @param {any} ctx @param {number} tabId @param {any} snap @param {any} blocker @param {any} trace */
async function modalError(ctx, tabId, snap, blocker, trace) {
  const d = describeBlocker(blocker, snap);
  const detail = await failDetail(ctx, tabId, { path: blocker.path, trace, extra: { blockers: [d] } });
  const shown = (d.title || d.text || "a dialog").slice(0, 80);
  const how = d.kind === "unsafe" ? "It asks about changes or a confirmation, so it was not dismissed." : "It is not one of the popups Vyre dismisses on its own.";
  return err("modal", `a dialog is blocking the page: ${JSON.stringify(shown)}. ${how} Read it, then act on one of its own controls (${d.controls.map(c => JSON.stringify(c)).join(", ") || "none listed"}).`, detail);
}

/**
 * Bind selectors to controls, waiting up to wait.timeoutMs for them to exist, be enabled, be in
 * front of any modal dialog, be free of loading spinners and (wait.stable) hold still for 150 ms.
 * A safe popup in the way (what's new, tour, cookies) is dismissed and reported; any other dialog
 * in front of a control is an error that describes it. Loading spinners are soft: after a grace
 * period the wait gives up on them and says so in the trace, so one endlessly animated element
 * cannot stall a flow. timeoutMs 0 is one look.
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
    const done = (/** @type {any} */ extra) => ({ snap, bound, trace: { ...summarizeStrategy(bound), waitedMs: Date.now() - t0, retries: 0, newTab: false, ...(dismissed.length ? { dismissed } : {}), ...flags, ...(extra || {}) } });
    // A modal dialog in front of the page. A missing control might live behind it, so it counts too.
    /** @type {any} */ let blocker = null;
    for (const b of bound) { blocker = topBlocker(snap, b.control); if (blocker) break; }
    if (blocker) {
      const c = classifyBlocker(blocker, snap);
      if (c.kind === "safe" && dismissals < 3) {
        await mouseClick(ctx, tabId, c.closer.path);
        dismissals++;
        dismissed.push({ what: (blocker.title || blocker.text || "").slice(0, 60), control: String(c.closer.name).slice(0, 30) });
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
      const st = snap.state || {};
      let ready = true;
      if (st.busy > 0 && elapsed < busyGrace) ready = false;
      else if (st.busy > 0) flags = { ...flags, busyIgnored: true };
      if (ctls.some(c => c.enabled === false) && elapsed < wait.timeoutMs) ready = false;
      if (wait.stable) {
        const key = ctls.map(c => c.path + JSON.stringify(c.frame)).join("|");
        if (key !== prevKey) { prevKey = key; sameSince = Date.now(); ready = false; } else if (Date.now() - sameSince < STABLE_MS) ready = false;
      }
      if (ready) return done();
      if (elapsed >= wait.timeoutMs) return done(wait.stable ? { unstable: true } : undefined);
    } else if (elapsed >= wait.timeoutMs) return done();
    await nap(ctx, POLL_MS);
  }
}

/** A control that vanished or was covered between the look and the click. */
const isStale = (/** @type {any} */ e) => e && ((e.code === "not_found" && /disappeared|gone/.test(String(e.message))) || e.code === "covered");

/** The error for a selector that bound nothing. @param {any} ctx @param {number} tabId @param {Selector} sel @param {Bound} b @param {any} got @param {any} trace */
async function notFoundError(ctx, tabId, sel, b, got, trace) {
  const tied = b.why === "tied";
  const detail = await failDetail(ctx, tabId, { trace, extra: { candidates: b.candidates && b.candidates.length ? b.candidates : nearMisses(String(sel.name || sel.identifier || ""), got.snap.controls) } });
  return err(tied ? "tied" : "not_found", `${tied ? "more than one control matches" : "nothing matches"} ${JSON.stringify({ role: sel.role, name: sel.name, identifier: sel.identifier })}`, detail);
}

/**
 * The settle step of page.wait: no spinners, the DOM quiet for quietMs and the network quiet for
 * netQuietMs. Spinners, a page that never goes quiet and requests that never end are soft after a
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
    const el = Date.now() - t0;
    const soft = el >= softAt;
    const netQuiet = st.netPending === 0 && st.netQuietMs >= netNeed;
    if ((!st.busy || soft) && (st.domQuietMs >= domNeed || soft) && (netQuiet || soft)) {
      if (st.busy) flags.busyIgnored = true;
      if (st.domQuietMs < domNeed) flags.domNeverQuiet = true;
      if (!netQuiet) flags.netIgnored = true;
      return flags;
    }
    if (el >= timeoutMs) throw err("timeout", `the page did not settle in ${timeoutMs} ms`, await failDetail(ctx, tabId, { trace: { strategy: "settled", waitedMs: el }, extra: { state: { busy: st.busy, domQuietMs: st.domQuietMs, netPending: st.netPending } } }));
    await nap(ctx, POLL_MS);
  }
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
  const timeout = async (/** @type {any} */ tr) => err("timeout", `still waiting after ${timeoutMs} ms`, await failDetail(ctx, tabId, { trace: tr }));
  const ok = (/** @type {any} */ tr) => ({ ok: true, waitedMs: Date.now() - t0, trace: tr });

  if (args.settled === true) return ok(trace("settled", await settleLoop(ctx, tabId, args, t0, timeoutMs)));
  if (typeof args.selector === "string" && /[.#\[:>]/.test(args.selector)) {
    // A CSS selector: existence only (or absence, with gone).
    while (true) {
      if (ctx.stopped()) throw err("stopped");
      const here = !!(await evaluate(ctx, tabId, exists(args.selector)));
      if (here !== (args.gone === true)) return ok(trace("css"));
      if (Date.now() >= deadline) throw await timeout(trace("css"));
      await nap(ctx, 100);
    }
  }
  if (args.selector != null) {
    const sel = selectorArg(args.selector);
    if (args.gone === true) {
      while (true) {
        if (ctx.stopped()) throw err("stopped");
        if (!matchControl(sel, (await snapshot(ctx, tabId)).controls, resolve).control) return ok(trace("absent"));
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
    const done = byUrl ? String(await evaluate(ctx, tabId, href())).includes(args.url) : Number(await evaluate(ctx, tabId, quiet())) >= idleMs;
    if (done) return ok(trace(byUrl ? "url" : "idle"));
    if (Date.now() >= deadline) throw await timeout(trace(byUrl ? "url" : "idle"));
    await nap(ctx, 100);
  }
}

// ---------------------------------------------------------------- ops

/** A page.fill field as a spec: a selector, or a plain label matched the way a person reads a form. @param {any} f @param {number} i @returns {Spec} */
function fieldSpec(f, i) {
  if (f && f.selector != null) return { sel: selectorArg(f.selector), optional: f.optional === true };
  if (f && typeof f.label === "string" && f.label.trim()) return { sel: { name: f.label.trim() }, fillable: true, optional: f.optional === true, label: f.label.trim() };
  throw err("bad_request", `field ${i}: a field needs a selector or a label`);
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "page",
  ops: {
    "page.snapshot": async (args, ctx) => {
      const tabId = await tabOf(args, ctx, "page.snapshot");
      const s = await snapshot(ctx, tabId);
      return { ...s, controls: s.controls.map((/** @type {any} */ { fields, form, ...c }) => c) };
    },

    "page.act": async (args, ctx) => {
      const tabId = await tabOf(args, ctx, "page.act");
      const kind = String(args.kind || "click");
      if (!["click", "type", "select", "check", "press"].includes(kind)) throw err("bad_request", `unknown kind ${JSON.stringify(kind)}`);
      if ((kind === "type" || kind === "select" || kind === "press") && (args.value === undefined || args.value === null)) throw err("bad_request", `${kind} needs a value`);
      const sel = selectorArg(args.selector);
      const wait = waitOpts(args.wait);
      const t0 = Date.now();
      let retries = 0;
      for (;;) {
        const got = await acquire(ctx, tabId, [{ sel, fillable: args.fillable === true }], wait, t0);
        const b = got.bound[0];
        const trace = { ...got.trace, waitedMs: Date.now() - t0, retries };
        if (!b.control) {
          if (args.optional === true && b.why === "unbound") return { ok: true, skipped: true, why: `no control matches ${JSON.stringify(sel.name || sel.identifier)}, and this step is optional`, trace: traceOf(trace) };
          throw await notFoundError(ctx, tabId, sel, b, got, trace);
        }
        try {
          const r = await doAct(ctx, tabId, got.snap, b.control, kind, args.value, args.release, args.asked === true);
          if (r.ok === false && /gone|disappeared/.test(String(r.why))) throw err("not_found", "the control disappeared");
          if (r.ok === false && !r.held) return { ...r, trace: traceOf(trace), ...(await failDetail(ctx, tabId, { path: b.control.path })) };
          return { ...r, trace: traceOf(trace) };
        } catch (e) {
          if (isStale(e) && retries < BACKOFF_MS.length) { await nap(ctx, BACKOFF_MS[retries++]); continue; }
          if (e && /** @type {any} */ (e).detail !== undefined) throw e;
          throw err(/** @type {any} */ (e)?.code || "error", String(/** @type {any} */ (e)?.message || e), await failDetail(ctx, tabId, { path: b.control.path, trace }));
        }
      }
    },

    "page.fill": async (args, ctx) => {
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
          throw err(l.why.startsWith("more") ? "tied" : "not_found", `field ${i}: ${l.why} ${JSON.stringify({ role: specs[i].sel.role, name: specs[i].sel.name, identifier: specs[i].sel.identifier })}`, await failDetail(ctx, tabId, { trace, extra: { candidates: l.candidates } }));
        }
        const off = got.bound.findIndex((/** @type {Bound} */ b) => b.control && b.control.enabled === false);
        if (off >= 0 && !partial) throw err("bad_request", `field ${off} is disabled`, await failDetail(ctx, tabId, { path: got.bound[off].control.path, trace }));
        const use = got.bound.map((/** @type {Bound} */ b, /** @type {number} */ i) => ({ b, i })).filter(x => x.b.control && x.b.control.enabled !== false);
        const results = use.length ? await evaluate(ctx, tabId, apply(use.map(x => ({ path: x.b.control.path, kind: "auto", value: args.fields[x.i].value })))) : [];
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
          return { ok: false, why: lostHard.length ? `could not find: ${lostHard.join(", ")}` : "some fields could not be set", filled, fields: summary, ...(notFound.length ? { notFound } : {}), trace: traceOf(trace), ...(await failDetail(ctx, tabId, { extra: { candidates: [...lost.values()][0]?.candidates } })) };
        }
        if (args.submit !== true) return { ok: true, filled, fields: summary, ...(notFound.length ? { notFound, skipped: notFound } : {}), trace: traceOf(trace) };
        const after = await snapshot(ctx, tabId);
        const form = got.bound.find((/** @type {Bound} */ b) => b.control)?.control.form;
        const btn = after.controls.find((/** @type {any} */ c) => c.submit && c.form === form) || after.controls.find((/** @type {any} */ c) => c.submit);
        if (!btn) return { ok: true, filled, fields: summary, submitted: false, why: "no submit control found", trace: traceOf(trace) };
        const r = await doAct(ctx, tabId, after, btn, "click", undefined, args.release, args.asked === true);
        return { ...r, filled, trace: traceOf(trace), ...(r.ok ? { submitted: true } : {}) };
      }
    },

    "page.eval": async (args, ctx) => {
      if (typeof args.expression !== "string" || !args.expression.trim()) throw err("bad_request", "page.eval needs an expression");
      const tabId = await tabOf(args, ctx, "page.eval");
      // A script can read what redaction cannot recognise (a typed password is just text), so a page
      // with a visible password field is not one it runs on at all.
      const pw = await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: passwordFieldScript, returnByValue: true });
      if (pw && pw.result && pw.result.value === true) throw err("blocked", "this page has a password field, so a script is not run on it");
      // Hands-free, except that a script's own network SENDS (a message, a post, a payment) are held
      // back and reported unless the person asked: the script runs, the send waits at the Gate.
      const guarded = args.asked !== true;
      const egress = guarded ? await egressGuard(ctx, tabId) : null;
      if (guarded) await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: guardInstall, returnByValue: true });
      /** @type {any} */ let r;
      /** @type {any[]} */ let blocked = [];
      /** @type {any[]} */ let outside = [];
      try { r = await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true, timeout: 10_000 }); }
      finally {
        if (guarded) { const c = await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: guardCollect, returnByValue: true }).catch(() => null); blocked = (c && c.result && c.result.value) || []; }
        if (egress) outside = await egress.stop().catch(() => []);
      }
      if (outside.length) { const b = outside[0]; return heldRequest(b.method, b.origin, `the script tried to reach ${b.origin}, which is not this page or anything it already talks to`, `${args.expression}\n${b.method} ${b.origin}`); }
      if (blocked.length) { const b = blocked[0]; return heldRequest(b.method, b.url, b.why, `${args.expression}\n${b.method} ${b.url}`); }
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        return { ok: false, error: redact.text(String((d.exception && d.exception.description) || d.text || "the page threw")) };
      }
      const res = (r && r.result) || {};
      const value = res.value !== undefined ? res.value : res.description;
      return { ok: true, type: res.type, value: redact.value(value) };
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
