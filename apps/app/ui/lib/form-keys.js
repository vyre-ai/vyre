// A form a person can fill without the mouse, on the web and in the Mac app's web view: Enter in a one-line field goes to the next field and, in the last one, takes the
// form's default action (its primary button). A new step puts the caret in its first empty field, or on its primary button when it has no field.
// One keydown listener on the form element does it. It runs before React's own handlers (they listen at the root), and it marks the key as taken, so a TextInput's
// onSubmitEditing does not run the action a second time.

const TYPED = new Set(["", "text", "password", "email", "url", "tel", "search", "number"]);

/**
 * The one-line fields of a form a person can type in, in page order (a multi-line box keeps Enter for a new line).
 * @param {{ querySelectorAll?: (s: string) => ArrayLike<any> } | null | undefined} form
 * @returns {any[]}
 */
export function formFields(form) {
  if (!form || typeof form.querySelectorAll !== "function") return [];
  return Array.from(form.querySelectorAll("input")).filter((el) => TYPED.has(String(el.type || "").toLowerCase()) && !el.disabled && !el.readOnly && el.tabIndex !== -1);
}

/**
 * What Enter does in field `index` of `count`: "next", "submit", or null when the form leaves the key alone (another key, Shift or a modifier held, a word still being composed, a key already taken, not a field).
 * @param {{ key?: string, shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, isComposing?: boolean, keyCode?: number, defaultPrevented?: boolean }} e
 * @param {number} index @param {number} count
 * @returns {"next" | "submit" | null}
 */
export function enterAction(e, index, count) {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return null;
  if (index < 0 || index >= count) return null;
  return index < count - 1 ? "next" : "submit";
}

/**
 * Enter walks the form's fields and, in the last one, calls `submit` (read when the key comes, so it is always the current action). Answers the function that takes the listener off.
 * @param {any} form @param {() => void} submit
 * @returns {() => void}
 */
export function wireFormKeys(form, submit) {
  if (!form || typeof form.addEventListener !== "function") return () => {};
  /** @param {any} e */
  const on = (e) => {
    const fields = formFields(form);
    const i = fields.indexOf(e.target);
    const a = enterAction(e, i, fields.length);
    if (!a) return;
    e.preventDefault();
    if (a === "next") fields[i + 1].focus();
    else submit();
  };
  form.addEventListener("keydown", on);
  return () => form.removeEventListener("keydown", on);
}

/**
 * Put the caret in the form's first empty field (the first field when every one is filled), or on `button` (the primary action) when the form has no field. Answers what took focus.
 * @param {any} form @param {any} [button]
 */
export function focusFirst(form, button) {
  const fields = formFields(form);
  const el = fields.find((f) => !f.value) || fields[0] || (button && button.getAttribute?.("aria-disabled") !== "true" ? button : null);
  if (el && typeof el.focus === "function") el.focus();
  return el || null;
}

/**
 * Focus the form's first field and select what is in it: a refused password, ready to be typed again.
 * @param {any} form
 */
export function selectField(form) {
  const el = formFields(form)[0];
  if (!el) return null;
  el.focus();
  if (typeof el.select === "function") el.select();
  return el;
}
