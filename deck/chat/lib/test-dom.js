// @ts-check
// dom.js's h()/add()/put() need `document` and `Node`. There's no browser and no dependency
// allowed to fake one, so this is the smallest shim that satisfies what h() actually calls:
// createElement, createTextNode, createDocumentFragment, setAttribute, addEventListener,
// append/appendChild, and enough of the tree (childNodes, textContent, tagName, className) for
// tests to walk the result. Not a DOM implementation — a stand-in, used only by *.test.js here.

export class FakeNode {
  constructor(nodeType) { this.nodeType = nodeType; this.childNodes = []; this.parentNode = null; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  append(...kids) { for (const k of kids) this.appendChild(k instanceof FakeNode ? k : new FakeText(String(k))); return this; }
  appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
  replaceChildren(...kids) { this.childNodes = []; this.append(...kids); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(v) { this.childNodes = []; this.appendChild(new FakeText(String(v))); }
}

export class FakeText extends FakeNode {
  constructor(text) { super(3); this.data = text; }
  get textContent() { return this.data; }
}

export class FakeElement extends FakeNode {
  constructor(tag) {
    super(1);
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.style = {};
    this.listeners = {};
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  get className() { return this.attributes.class || ""; }
  set className(v) { this.attributes.class = v; }
}

export class FakeFragment extends FakeNode {
  constructor() { super(11); }
}

/** Installs document/Node globals for the duration of a test file. Call once at import time. */
export function installDom() {
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: tag => new FakeElement(tag),
    createTextNode: text => new FakeText(text),
    createDocumentFragment: () => new FakeFragment(),
  };
}

/** Depth-first flatten of element/fragment text, ignoring markup — the safety check tests want. */
export function allText(node) {
  if (node.nodeType === 3) return node.data;
  return node.childNodes.map(allText).join("");
}

/** Find the first descendant (or self) whose tagName matches, or null. */
export function find(node, tag) {
  if (node.tagName === String(tag).toUpperCase()) return node;
  for (const c of node.childNodes) { const r = find(c, tag); if (r) return r; }
  return null;
}

/** All descendants (not self) matching a tag. */
export function findAll(node, tag, out = []) {
  for (const c of node.childNodes) {
    if (c.tagName === String(tag).toUpperCase()) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
