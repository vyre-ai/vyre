// @ts-check
// page-scripts: the functions the bench evaluates inside a page. They are plain functions so
// `node --check` covers them; `expr(fn, ...args)` turns one into a Runtime.evaluate expression.
// They mirror what the design says the extension does: snapshot is one evaluate, fill sets every
// field in one evaluate, a batch runs its steps inside one evaluate (the worker-side batch has no
// host hop between steps either).

/** @param {Function} fn @param {...unknown} args */
export function expr(fn, ...args) {
  return `(${fn.toString()})(${args.map(a => JSON.stringify(a === undefined ? null : a)).join(",")})`;
}

/** One-evaluate page.snapshot: interactive elements with a stable selector, plus visible text. */
export function snapshotFn() {
  const sel = 'a[href],button,input,select,textarea,[role="button"],[data-testid]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    const tid = el.getAttribute("data-testid");
    const selector = el.id ? "#" + el.id : tid ? '[data-testid="' + tid + '"]' : tag;
    const label = (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "";
    const type = el.getAttribute("type") || "";
    out.push({ ref: out.length, tag, type, selector, name: label.trim().slice(0, 80), value: type === "password" ? undefined : el.value });
  }
  return { url: location.href, title: document.title, count: out.length, elements: out, text: document.body.innerText.slice(0, 2000) };
}

/** One-evaluate page.fill: native setter plus input and change events, so frameworks see it. @param {Array<{selector:string,value:string}>} fields */
export function fillFn(fields) {
  const missing = [];
  let filled = 0;
  for (const f of fields) {
    const el = /** @type {any} */ (document.querySelector(f.selector));
    if (!el) { missing.push(f.selector); continue; }
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, f.value); else el.value = f.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled++;
  }
  return { filled, missing };
}

/** Where to click: scroll into view, return the element's centre in viewport coordinates. @param {string} selector */
export function centerFn(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  // Only where the click would land on it: a control still sliding in, or covered, is not there yet (the caller looks again).
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(el === hit || el.contains(hit))) return null;
  return { x, y };
}

/**
 * Run steps in one evaluate; halts at the first failure and says which step.
 * A step is {op:"click", selector} or {op:"fill", selector, value}.
 * @param {Array<{op:string,selector:string,value?:string}>} steps
 */
export function runStepsFn(steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const el = /** @type {any} */ (document.querySelector(s.selector));
    if (!el) return { done: i, failed: { step: i, selector: s.selector, reason: "not found" } };
    if (s.op === "click") el.click();
    else if (s.op === "fill") {
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, s.value ?? ""); else el.value = s.value ?? "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else return { done: i, failed: { step: i, selector: s.selector, reason: "unknown op " + s.op } };
  }
  return { done: steps.length };
}

/** In-page fetch for api.call: same-origin cookies ride along; the bearer header is passed in. @param {string} method @param {string} url @param {Record<string,string>} headers @param {string|null} body */
export async function fetchFn(method, url, headers, body) {
  const r = await fetch(url, { method, headers, body: body || undefined, credentials: "include" });
  const text = await r.text();
  return { status: r.status, bytes: text.length };
}
