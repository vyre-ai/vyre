// @ts-check
// The Deck's whole component helper. h() builds elements; strings always become text nodes, so
// text from threads, memory or anyone else can never become markup. There is no innerHTML in the
// Deck: the only markup parsed is the constant icon drawings in icons.js, through DOMParser.

/**
 * The phone layout's question, asked in one place. Narrow windows, and short wide touch screens (a
 * phone turned sideways), get the phone shell; a short desktop window does not. The CSS phone
 * blocks use the same query text (deck/test/pwa.test.js checks they match).
 */
export const PHONE_QUERY = "(max-width: 719px), (max-height: 500px) and (pointer: coarse)";
/** @param {any} [win] */
export const isPhone = (win = globalThis) => !!win.matchMedia?.(PHONE_QUERY).matches;

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

/** Navigate inside the Deck. app.js listens for this. The state counts how deep inside the Deck
 * this entry is, so a Back button can go back (see back()) instead of pushing another entry. */
export function go(href) {
  history.pushState({ deck: (history.state?.deck || 0) + 1 }, "", href);
  window.dispatchEvent(new Event("deck:navigate"));
}

/** A Back button: the previous screen in the Deck, exactly as it was, else `fallback`. */
export function back(fallback) {
  if (history.state?.deck) history.back(); else go(fallback);
}

/** A labelled section heading row (engraved label on the left, optional extra on the right). */
export function head(label, right, cls = "") {
  return h("div", { class: "section-head" }, h("h2", { class: "lbl " + cls }, label), right || null);
}

/**
 * What a view shows when there is nothing, or a tool is not there (the state kit, js/states.js, in the Deck's one look): a plain line for an
 * empty list; for an error, what failed, a quiet reason, and Try again when the view can retry. An error is never drawn as an empty list.
 * @param {string} text what is empty, or what failed ("Projects are not available.")
 * @param {any} [err] an ApiError from api.js, whose module is named
 * @param {(() => void) | null} [retry] what Try again does
 */
export function empty(text, err, retry = null) {
  if (!err) return h("div", { class: "empty" }, text);
  const reason = err.missing ? `The ${err.module} module is not running on this machine.` : String(err.message || err);
  return h("div", { class: "empty state-error", role: "alert" }, text,
    h("span", { class: "code" }, reason),
    retry ? h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "retry", onclick: () => retry() }, "Try again") : null);
}
