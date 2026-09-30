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
import { err } from "../lib/err.js";

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
  function pathOf(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 8) {
      const parent = n.parentElement;
      const idx = parent ? [...parent.children].indexOf(n) : 0;
      parts.unshift(n.tagName.toLowerCase() + "[" + idx + "]");
      n = parent;
    }
    return parts.join(">");
  }
  function find(path) {
    const last = path.split(">").pop().split("[")[0];
    for (const el of document.getElementsByTagName(last)) if (pathOf(el) === path) return el;
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
  const out = [];
  for (const el of document.querySelectorAll("*")) {
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
    const container = containerOf(el);
    if (container) c.container = container;
    if (document.activeElement === el) c.focused = true;
    if ("value" in el && el.value !== undefined && el.value !== null && el.value !== "" && el.type !== "password") c.value = String(el.value);
    if (el.type === "password" && el.value) c.length = el.value.length;
    if (el.type === "checkbox" || el.type === "radio") c.checked = el.checked === true;
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
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 20000), controls: out };
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
  return { found: true, x, y, hit, checked: el.checked === true };
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

/** @param {Selector} sel @param {any} snap */
function bind(sel, snap) {
  const r = resolve(sel, snap.controls);
  if (r.control) return r.control;
  throw err(r.why === "tied" ? "tied" : "not_found", `${r.why === "tied" ? "more than one control matches" : "nothing matches"} ${JSON.stringify({ role: sel.role, name: sel.name, identifier: sel.identifier })}`);
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

// ---------------------------------------------------------------- waiting

/** @param {any} ctx @param {number} tabId @param {any} args */
async function waitFor(ctx, tabId, args) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10_000, 100), 120_000);
  const idleMs = Number(args.idleMs) || 0;
  const deadline = Date.now() + timeoutMs;
  const kinds = [args.selector != null, typeof args.url === "string", idleMs > 0].filter(Boolean).length;
  if (kinds !== 1) throw err("bad_request", "page.wait needs exactly one of selector, url or idleMs");
  while (true) {
    if (ctx.stopped()) throw err("stopped");
    let done = false;
    if (args.selector != null) {
      if (typeof args.selector === "string" && /[.#\[:>]/.test(args.selector)) done = !!(await evaluate(ctx, tabId, exists(args.selector)));
      else done = !!resolve(selectorArg(args.selector), (await snapshot(ctx, tabId)).controls).control;
    } else if (typeof args.url === "string") done = String(await evaluate(ctx, tabId, href())).includes(args.url);
    else done = Number(await evaluate(ctx, tabId, quiet())) >= idleMs;
    if (done) return { ok: true };
    if (Date.now() >= deadline) throw err("timeout", `still waiting after ${timeoutMs} ms`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- ops

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
      const snap = await snapshot(ctx, tabId);
      return doAct(ctx, tabId, snap, bind(sel, snap), kind, args.value, args.release, args.asked === true);
    },

    "page.fill": async (args, ctx) => {
      const tabId = await tabOf(args, ctx, "page.fill");
      if (!Array.isArray(args.fields) || !args.fields.length) throw err("bad_request", "page.fill needs fields: [{selector, value}]");
      if (args.fields.length > 100) throw err("bad_request", "page.fill takes at most 100 fields");
      const snap = await snapshot(ctx, tabId);
      // Resolve every field first: a fill that lands half the form is worse than one that lands none.
      const bound = args.fields.map((/** @type {any} */ f, /** @type {number} */ i) => {
        try { return bind(selectorArg(f && f.selector), snap); } catch (e) { throw err(/** @type {any} */ (e).code || "bad_request", `field ${i}: ${/** @type {any} */ (e).message}`); }
      });
      const off = bound.findIndex((/** @type {any} */ c) => c.enabled === false);
      if (off >= 0) throw err("bad_request", `field ${off} is disabled`);
      const results = await evaluate(ctx, tabId, apply(bound.map((/** @type {any} */ c, /** @type {number} */ i) => ({ path: c.path, kind: "auto", value: args.fields[i].value }))));
      const summary = bound.map((/** @type {any} */ c, /** @type {number} */ i) => ({ name: c.name || c.identifier || c.role, ok: !!(results[i] && results[i].ok), ...(results[i] && results[i].why ? { why: results[i].why } : {}) }));
      const filled = summary.filter((/** @type {any} */ s) => s.ok).length;
      if (filled !== summary.length) return { ok: false, why: "some fields could not be set", filled, fields: summary };
      if (args.submit !== true) return { ok: true, filled, fields: summary };
      const after = await snapshot(ctx, tabId);
      const form = bound[0].form;
      const btn = after.controls.find((/** @type {any} */ c) => c.submit && c.form === form) || after.controls.find((/** @type {any} */ c) => c.submit);
      if (!btn) return { ok: true, filled, fields: summary, submitted: false, why: "no submit control found" };
      const r = await doAct(ctx, tabId, after, btn, "click", undefined, args.release, args.asked === true);
      return { ...r, filled, ...(r.ok ? { submitted: true } : {}) };
    },

    "page.eval": async (args, ctx) => {
      if (typeof args.expression !== "string" || !args.expression.trim()) throw err("bad_request", "page.eval needs an expression");
      const tabId = await tabOf(args, ctx, "page.eval");
      const r = await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true, timeout: 10_000 });
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

