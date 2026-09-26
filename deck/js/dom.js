// @ts-check
// The Deck's whole component helper. h() builds elements; strings always become text nodes, so
// text from threads, memory or anyone else can never become markup. There is no innerHTML in the
// Deck: the only markup parsed is the constant icon drawings in icons.js, through DOMParser.

/**
 * h("div", { class: "row", onclick }, "text", child, [more]) → an element.
 * Props: class, style (string or object), on<event> handlers, aria-*, data-*, and anything else
 * as an attribute (true → present, false/null → absent). Children: strings and numbers as text,
 * Nodes as they are, arrays flattened, null/false/undefined skipped.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} kids
 * @returns {HTMLElement}
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value" && "value" in el) /** @type {any} */ (el).value = v;
    else if (k === "checked" || k === "disabled" || k === "hidden") /** @type {any} */ (el)[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  add(el, kids);
  return el;
}

/** Append children with the same rules as h(). */
export function add(el, kids) {
  for (const k of [kids].flat(Infinity)) {
    if (k === null || k === undefined || k === false || k === true) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** Replace an element's children. */
export function put(el, ...kids) { el.replaceChildren(); return add(el, kids); }

/** A client-side link: pushes history instead of loading a page. */
export function link(href, props, ...kids) {
  return h("a", { href, ...props, onclick: (/** @type {MouseEvent} */ e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(href);
  } }, ...kids);
}

/** Navigate inside the Deck. app.js listens for this. */
export function go(href) {
  history.pushState(null, "", href);
  window.dispatchEvent(new Event("deck:navigate"));
}

/** A labelled section heading row (engraved label on the left, optional extra on the right). */
export function head(label, right, cls = "") {
  return h("div", { class: "section-head" }, h("h2", { class: "lbl " + cls }, label), right || null);
}

/**
 * What a view shows when a tool is not there: which module is not running, in plain words.
 * @param {string} text
 * @param {any} [err] an ApiError from api.js, whose module is named
 */
export function empty(text, err) {
  const why = err && err.missing ? `The ${err.module} module is not running on this machine.`
    : err ? String(err.message || err) : null;
  return h("div", { class: "empty" }, text, why ? h("span", { class: "code" }, why) : null);
}
