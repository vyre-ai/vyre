// @ts-check
// snapshot: a page's DOM, shaped into what the hands reason about.
//
// hands-desktop reads an accessibility tree; a page has no such thing unless the site built
// one, so this asks the DOM itself: every element a person could act on, with the attributes
// that make it findable again (role, an accessible name, an id or test id, its container, and a
// path as a last-resort tiebreak). Evaluated as a single Runtime.evaluate call so a page with a
// thousand nodes costs one CDP round trip, not one per element.
//
// Kept as its own copy: modules never import each other (see hands-desktop/snapshot.js, whose
// comment says the same thing about the accessibility tree it reads).

/** Roles a person could act on. Everything else (containers, text, images) is layout. */
export const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
  "spinbutton", "treeitem",
]);

// Native elements that are actionable even without an ARIA role, and the role they imply.
const IMPLICIT = {
  A: "link", BUTTON: "button", SUMMARY: "button",
  INPUT: "textbox", // narrowed by type below
  SELECT: "combobox", TEXTAREA: "textbox", OPTION: "option",
};
const INPUT_TYPE_ROLE = {
  button: "button", submit: "button", reset: "button", image: "button",
  checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox",
};

/**
 * The function evaluated in the page. Pure browser code: no import, because CDP sends it as a
 * source string. Kept in this file, as a string, so it is versioned with the module that reads
 * its output and never drifts from ACTIONABLE/IMPLICIT above (mirrored here since the two run
 * in different worlds).
 */
export const EXPRESSION = `(() => {
  const ACTIONABLE = new Set(${JSON.stringify([...ACTIONABLE])});
  const IMPLICIT = ${JSON.stringify(IMPLICIT)};
  const INPUT_TYPE_ROLE = ${JSON.stringify(INPUT_TYPE_ROLE)};

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
    if (el.tagName === "INPUT" && el.placeholder) return el.placeholder.trim();
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text.slice(0, 120);
    if (el.tagName === "IMG" && el.alt) return el.alt.trim();
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  }

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

  function containerOf(el) {
    const form = el.closest("form[id],form[name],[role=dialog],[role=region][aria-label],[aria-labelledby]");
    if (!form) return undefined;
    return form.getAttribute("aria-label") || form.id || form.getAttribute("name") || undefined;
  }

  const out = [];
  const all = document.querySelectorAll("*");
  for (const el of all) {
    const role = roleOf(el);
    if (!role || !ACTIONABLE.has(role)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const name = nameOf(el);
    const identifier = el.id || el.getAttribute("data-testid") || el.getAttribute("data-test-id") || undefined;
    const c = {
      path: pathOf(el), role, enabled: !disabled,
      frame: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    if (name) c.name = name; else c.nameless = true;
    if (identifier) c.identifier = identifier;
    const container = containerOf(el);
    if (container) c.container = container;
    // Native facts the consequence guard believes over the page's words and role (HD-6b): a control that submits a form, and where a link goes.
    const tag = el.tagName, ty = (el.getAttribute("type") || "").toLowerCase();
    if ((tag === "BUTTON" && (ty === "submit" || (ty === "" && el.form))) || (tag === "INPUT" && (ty === "submit" || ty === "image"))) c.submit = true;
    if (tag === "A" && el.href) c.href = String(el.href).slice(0, 300);
    if (document.activeElement === el) c.focused = true;
    if ("value" in el && el.value !== undefined && el.value !== null && el.value !== "" && el.type !== "password") c.value = String(el.value);
    if (el.type === "password" && el.value) c.length = el.value.length;
    out.push(c);
  }
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 20000), controls: out };
})()`;

/**
 * @typedef {{ path: string, role: string, name?: string, nameless?: boolean, enabled: boolean,
 *   submit?: boolean, href?: string, focused?: boolean, value?: string, length?: number, container?: string, identifier?: string,
 *   frame?: { x: number, y: number, w: number, h: number } }} Control
 * @typedef {{ title: string, url: string, text: string, controls: Control[], named: number, nameless: number }} Snapshot
 */

/**
 * @param {any} raw what Runtime.evaluate returned for EXPRESSION
 * @returns {Snapshot}
 */
export function toSnapshot(raw) {
  const controls = Array.isArray(raw && raw.controls) ? raw.controls : [];
  return {
    title: (raw && raw.title) || "", url: (raw && raw.url) || "", text: (raw && raw.text) || "",
    controls, named: controls.filter(c => !c.nameless).length, nameless: controls.filter(c => c.nameless).length,
  };
}
