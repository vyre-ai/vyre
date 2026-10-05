// @ts-check
// Just enough of a DOM for a Deck view to render in node: elements, text nodes, attributes,
// events, form controls and simple selectors. The Deck has no dependencies, so there is no jsdom;
// views build everything through js/dom.js's h(), which needs only what is here. A test helper,
// not part of the product.
//
//   const dom = install();           globals document, window, location, Node, Event
//   dom.text(el)                     the visible text, hidden elements left out
//   $(el, "button[data-act=test]")   compound selectors, with descendants separated by spaces
//
// Selectors: tag, .class, #id, [attr], [attr=value] and [attr="value"], combined; descendants
// with spaces. Nothing more is needed by the tests.

class Node {
  constructor() { /** @type {any} */ this.parentNode = null; /** @type {any[]} */ this.childNodes = []; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document?.documentElement; }
  replaceWith(/** @type {any} */ n) { const p = this.parentNode; if (!p) return; p.childNodes.splice(p.childNodes.indexOf(this), 1, n); if (n.parentNode && n.parentNode !== p) n.remove(); n.parentNode = p; this.parentNode = null; }
  remove() { if (this.parentNode) { const p = this.parentNode; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
}

class Text extends Node {
  /** @param {string} s */
  constructor(s) { super(); this.data = s; }
  get textContent() { return this.data; }
}

class Element extends Node {
  /** @param {string} tag */
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    /** @type {Map<string, string>} */ this.attrs = new Map();
    /** @type {Map<string, Function[]>} */ this.listeners = new Map();
    // Plain properties (el.style.color = "red") plus the custom-property methods real
    // CSSStyleDeclaration has, which a view may call (a live level driving a CSS var, say).
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k] || ""; } };
    this._value = undefined;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return k === "id" && this.id !== undefined && !this.attrs.has("id") ? this.id : this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get className() { return this.attrs.get("class") || ""; }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return { contains: c => list().includes(c), add: (...cs) => el.setAttribute("class", [...new Set([...list(), ...cs])].join(" ")),
      remove: (...cs) => el.setAttribute("class", list().filter(x => !cs.includes(x)).join(" ")),
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : on; if (want) el.classList.add(c); else el.classList.remove(c); return want; } };
  }
  get value() {
    if (this.tagName === "SELECT") {
      if (this._value !== undefined && this.options().some(o => o.value === this._value)) return this._value;
      const opts = this.options();
      const sel = opts.find(o => o.hasAttribute("selected")) || opts[0];
      return sel ? sel.value : "";
    }
    if (this.tagName === "OPTION") return this._value !== undefined ? this._value : this.attrs.has("value") ? /** @type {string} */ (this.attrs.get("value")) : this.textContent;
    if (this._value !== undefined) return this._value;
    return this.attrs.get("value") || (this.tagName === "INPUT" && this.attrs.get("type") === "checkbox" ? "on" : "");
  }
  set value(v) { this._value = String(v); if (this._selStart == null || this._selStart > this._value.length) { this._selStart = this._selEnd = this._value.length; } }
  /** A textarea/input's caret: composer.js's caret() falls back to the text's length without
   *  this, so a test that needs a mid-string cursor sets it with setSelectionRange. */
  get selectionStart() { return this._selStart ?? this.value.length; }
  get selectionEnd() { return this._selEnd ?? this.value.length; }
  setSelectionRange(start, end) { this._selStart = start; this._selEnd = end ?? start; }
  options() { return all(this, "option"); }
  append(...kids) {
    for (const k of kids) {
      const n = k instanceof Node ? k : new Text(String(k));
      n.remove();
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...kids) { for (const c of [...this.childNodes]) c.remove(); this.append(...kids); }
  get children() { return this.childNodes.filter(c => c instanceof Element); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  addEventListener(type, fn) { const l = this.listeners.get(type) || []; l.push(fn); this.listeners.set(type, l); }
  removeEventListener(type, fn) { const l = this.listeners.get(type) || []; this.listeners.set(type, l.filter(f => f !== fn)); }
  /** Runs the listeners and returns what they returned, so a test can await an async handler. */
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.currentTarget = this;
    const out = [];
    for (const fn of this.listeners.get(ev.type) || []) out.push(fn(ev));
    return out;
  }
  click() {
    if (this.disabled) return Promise.resolve();
    if (this.tagName === "INPUT" && this.attrs.get("type") === "checkbox") { this.checked = !this.checked; this.dispatchEvent(new Event("change")); }
    return Promise.all(this.dispatchEvent(new Event("click")));
  }
  focus() {}
  blur() {}
  select() { this.selected = true; }
  scrollIntoView() {}
  querySelector(sel) { return all(this, sel)[0] || null; }
  querySelectorAll(sel) { return all(this, sel); }
  closest(sel) { let n = /** @type {any} */ (this); while (n instanceof Element) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
}

class Event {
  /** @param {string} type */
  constructor(type) { this.type = type; this.defaultPrevented = false; /** @type {any} */ this.target = null; /** @type {any} */ this.currentTarget = null; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

/** @param {string} one a compound selector: tag, .class, #id, [attr], [attr=value] */
function matches(el, one) {
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g;
  let m, any = false;
  while ((m = re.exec(one))) {
    any = true;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !el.className.split(/\s+/).includes(m[2])) return false;
    if (m[3] && el.getAttribute("id") !== m[3]) return false;
    if (m[4]) {
      const v = el.getAttribute(m[4]);
      if (v === null) return false;
      const want = m[5] ?? m[6];
      if (want !== undefined && v !== want) return false;
    }
  }
  return any;
}

function descendants(el) {
  const out = [];
  const walk = n => { for (const c of n.childNodes) if (c instanceof Element) { out.push(c); walk(c); } };
  walk(el);
  return out;
}

/** @param {Element} root @param {string} sel */
function all(root, sel) {
  const parts = sel.trim().split(/\s+(?![^\[]*\])/);
  let set = [root];
  for (const p of parts) set = [...new Set(set.flatMap(n => descendants(n).filter(d => matches(d, p))))];
  return set;
}

/** Visible text of an element, hidden ones and select options left out, with spaces between blocks. */
export function text(el) {
  if (el instanceof Text) return el.data;
  if (!(el instanceof Element) || el.hidden) return "";
  if (el.tagName === "SELECT") return "";
  return el.childNodes.map(text).join(el.tagName === "DIV" || el.tagName === "DL" ? " " : "");
}

/** Everything a person could read in the tree, option labels and input values included. */
export function everything(el) {
  if (el instanceof Text) return el.data;
  if (!(el instanceof Element)) return "";
  const own = [el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : "", ...[...el.attrs.values()]].join(" ");
  return own + " " + el.childNodes.map(everything).join(" ");
}

export const $ = (el, sel) => el.querySelector(sel);
export const $$ = (el, sel) => el.querySelectorAll(sel);

/** Put the fake on globalThis. Returns the document. */
export function install() {
  const documentElement = new Element("html");
  const head = new Element("head"), body = new Element("body");
  documentElement.append(head, body);
  const document = {
    documentElement, head, body, activeElement: null,
    createElement: tag => new Element(tag),
    createTextNode: s => new Text(s),
    addEventListener() {}, removeEventListener() {},
    querySelector: sel => documentElement.querySelector(sel),
  };
  Object.assign(globalThis, { document, Node, Element, Text, Event, HTMLElement: Element });
  // window === globalThis (below); a bare Node process has neither - views that guard nothing
  // call window.addEventListener("blur"/"resize"/...) at mount, so this needs to at least not
  // throw. No-op by default, same convention as document's; a test overrides it to track calls.
  if (!globalThis.addEventListener) Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
  if (!globalThis.window) Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
  if (!globalThis.location) Object.defineProperty(globalThis, "location", { value: { search: "", hostname: "localhost", host: "localhost:4747", pathname: "/settings", hash: "" }, configurable: true, writable: true });
  return document;
}
