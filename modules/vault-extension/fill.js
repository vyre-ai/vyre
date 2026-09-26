// @ts-check
// fill: the content script, injected into the active tab's top frame only when the person
// clicks Fill. It defines one function the background worker calls with a login; it reads
// nothing from the page except which inputs exist, and it sends nothing anywhere. It returns
// only which kinds of field it filled.
//
// Values are set through the input's native value setter and followed by input and change
// events, so pages built on frameworks that track their own state see the change.

(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.vyreFill) return;

  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const setValue = desc && desc.set;

  /** @param {HTMLInputElement} el */
  const usable = el => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  /** @param {HTMLInputElement} el @param {string} v */
  function put(el, v) {
    el.focus();
    if (setValue) setValue.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** @param {string} sel @returns {HTMLInputElement[]} */
  const inputs = sel => /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll(sel)]).filter(usable);

  const USERNAME = 'input[autocomplete~="username"], input[type="email"], input[type="text"], input[type="tel"], input:not([type])';

  /** The username box: the named one if there is one, else the last text-like input before the password. */
  function usernameFor(pw) {
    const scope = (pw && pw.form) || document;
    const named = /** @type {HTMLInputElement[]} */ ([...scope.querySelectorAll('input[autocomplete~="username"]')]).filter(usable);
    if (named.length) return named[0];
    const all = /** @type {HTMLInputElement[]} */ ([...scope.querySelectorAll(USERNAME)]).filter(usable);
    if (!pw) return all.find(el => el.type === "email") || all[0] || null;
    const before = all.filter(el => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || null;
  }

  /** @param {{ origin: string, username: string, password: string, totp?: string }} c */
  g.vyreFill = c => {
    // The tab may have moved on since the popup asked. A login fills only the origin it was fetched for.
    if (!c || location.origin !== c.origin) return { filled: [], why: "the page changed; open the popup again" };
    const filled = [];
    const pw = inputs('input[type="password"]:not([autocomplete="new-password"])')[0] || null;
    const user = usernameFor(pw);
    if (user && c.username) { put(user, c.username); filled.push("username"); }
    if (pw && c.password) { put(pw, c.password); filled.push("password"); }
    const otp = inputs('input[autocomplete="one-time-code"]')[0];
    if (otp && c.totp) { put(otp, c.totp); filled.push("totp"); }
    return { filled, why: filled.length ? null : "no login fields on this page" };
  };

  /** A one-time code into the focused code box, else the first one on the page. @param {{ origin: string, code: string }} c */
  g.vyreFillOtp = c => {
    if (!c || location.origin !== c.origin) return { filled: [], why: "the page changed" };
    const a = document.activeElement;
    const el = a instanceof HTMLInputElement && usable(a) ? a : inputs('input[autocomplete="one-time-code"]')[0];
    if (!el || !c.code) return { filled: [], why: "no code box on this page" };
    put(el, c.code);
    return { filled: ["totp"], why: null };
  };
})();
