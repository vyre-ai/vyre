// @ts-check
// inline: the content script behind in-page suggestions, one-time codes and save on submit.
// It runs in the page's top frame only: registered for every page once the person turns on
// "Suggest logins on pages" in the popup, or injected once by the keyboard command.
//
// Why it is built this way:
//   - Everything it draws lives in a closed shadow root, so the page's scripts cannot read the
//     login names in it or restyle a button to trick a click.
//   - It fills only on a click whose event isTrusted: a page can dispatch synthetic clicks, and
//     a fill a page could trigger by itself is a fill a page could steal.
//   - It never asks for a value. It names the login; the background worker fetches it and fills
//     through fill.js, for this frame's origin, which the worker reads from the sender rather
//     than from anything this script says.
//   - A password read at submit goes to the worker once, is held there in memory for two
//     minutes, and is saved only if the person clicks Save on the prompt that follows.

/* global chrome */

(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.vyreInline || window.top !== window) return;
  g.vyreInline = true;

  /** @param {any} msg @returns {Promise<any>} */
  const ask = msg => new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? { error: { code: "gone", message: "the extension restarted" } } : r)); }
    catch { resolve({ error: { code: "gone", message: "the extension restarted" } }); }
  });

  // ---- the shadow host ------------------------------------------------------------------

  const host = document.createElement("vyre-vault");
  host.style.cssText = "all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box { font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #16181d; border: 1px solid #d5d8de;
      border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 4px; min-width: 220px; max-width: 320px; }
    @media (prefers-color-scheme: dark) { .box { background: #1d2027; color: #eceef2; border-color: #333844; } }
    button { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    button:hover, button:focus-visible { background: rgba(43, 89, 195, .14); }
    .muted { opacity: .7; padding: 6px 8px; font-size: 12px; }
    .row { display: flex; gap: 6px; } .row button { text-align: center; }
    .title { padding: 6px 8px; font-weight: 600; }`;
  root.append(style);
  const box = document.createElement("div");
  box.className = "box";
  root.append(box);

  function hide() { host.remove(); box.replaceChildren(); }

  /** @param {HTMLElement|null} anchor */
  function place(anchor) {
    const r = anchor ? anchor.getBoundingClientRect() : { left: 16, bottom: 16, width: 0 };
    host.style.position = "absolute";
    host.style.right = "auto";
    host.style.left = `${Math.max(0, r.left + window.scrollX)}px`;
    host.style.top = `${r.bottom + window.scrollY + 4}px`;
    if (!host.isConnected) document.documentElement.append(host);
  }

  /** A button that acts only on a trusted click. @param {string} text @param {() => void} act */
  function button(text, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", e => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    });
    return b;
  }

  function line(text, cls = "muted") {
    const p = document.createElement("div");
    p.className = cls;
    p.textContent = text;
    return p;
  }

  // ---- the chooser ----------------------------------------------------------------------

  /** @param {HTMLInputElement} el */
  const isOtp = el => el.autocomplete === "one-time-code" || /(^|[^a-z])(otp|totp|2fa|mfa|one.?time)/i.test(`${el.name} ${el.id}`);
  /** @param {HTMLInputElement} el */
  const isLoginField = el => el.type === "password" || /username|email/i.test(`${el.autocomplete} ${el.type} ${el.name} ${el.id}`);

  /** @param {HTMLInputElement|null} anchor @param {{ otp?: boolean }} [o] */
  async function choose(anchor, { otp = false } = {}) {
    const r = await ask({ type: "inline-match" });
    box.replaceChildren();
    if (r && r.error) {
      box.append(line(r.error.code === "locked" ? "Vyre is locked. Unlock it from the toolbar button." : r.error.message));
    } else if (!r || !r.data || !r.data.logins.length) {
      return hide();
    } else {
      for (const l of r.data.logins) {
        box.append(button(otp ? `One-time code from ${l.name}` : l.name, async () => {
          const f = await ask({ type: otp ? "inline-otp" : "inline-fill", name: l.name });
          if (f && f.error) { box.replaceChildren(line(f.error.message)); return; }
          hide();
        }));
      }
    }
    box.append(button("Close", hide));
    place(anchor);
  }

  document.addEventListener("focusin", e => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (!e.isTrusted || !(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return;
    if (el.autocomplete === "new-password") return;
    if (isOtp(el)) choose(el, { otp: true });
    else if (isLoginField(el) && document.querySelector('input[type="password"]')) choose(el);
  }, true);

  document.addEventListener("keydown", e => { if (e.key === "Escape" && host.isConnected) hide(); }, true);

  // The keyboard command asks for the chooser when a page has more than one login.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (msg && msg.type === "show-chooser") {
      const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : document.querySelector('input[type="password"]');
      choose(/** @type {HTMLInputElement|null} */ (active));
    }
  });

  // ---- save on submit -------------------------------------------------------------------

  /** The username and password a form holds, if it holds a password. @param {HTMLFormElement|Document} scope */
  function creds(scope) {
    const pws = /** @type {HTMLInputElement[]} */ ([...scope.querySelectorAll('input[type="password"]')]).filter(p => p.value);
    if (!pws.length) return null;
    // On a change-password form the last one is the new password.
    const pw = pws[pws.length - 1];
    const user = /** @type {HTMLInputElement|null} */ (scope.querySelector('input[autocomplete~="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[type="text"]'));
    return { username: user && user.value ? user.value.slice(0, 1024) : "", password: pw.value, change: pws.length > 1 || pw.autocomplete === "new-password" };
  }

  let offered = 0;
  /** @param {Event} e @param {HTMLFormElement|Document} scope */
  function offer(e, scope) {
    if (!e.isTrusted || Date.now() - offered < 1000) return;
    const c = creds(scope);
    if (!c) return;
    offered = Date.now();
    // A page that logs in without navigating gets the prompt here; one that navigates, on the next page.
    ask({ type: "inline-offer-save", username: c.username, password: c.password, change: c.change }).then(() => setTimeout(prompt, 800));
  }

  document.addEventListener("submit", e => { if (e.target instanceof HTMLFormElement) offer(e, e.target); }, true);
  // Pages that log in with script and no form submit: a trusted click on a button beside a filled password.
  document.addEventListener("click", e => {
    const b = /** @type {Element} */ (e.target);
    if (!(b instanceof Element) || !b.closest('button, input[type="submit"], [role="button"]')) return;
    offer(e, b.closest("form") || document);
  }, true);

  /** After a login (often on the next page), ask the person whether to save what they typed. */
  async function prompt() {
    const r = await ask({ type: "inline-pending" });
    if (!r || !r.data || !r.data.pending) return;
    const p = r.data.pending;
    box.replaceChildren(line(p.change ? `Update the password for ${p.host} in Vyre?` : `Save this login for ${p.host} in Vyre?`, "title"));
    if (p.username) box.append(line(p.username));
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      button("Save", async () => {
        const s = await ask({ type: "inline-save" });
        box.replaceChildren(line(s && s.error ? s.error.message : s.data.updated ? `Updated ${s.data.name}.` : s.data.created ? `Saved as ${s.data.name}.` : "Already saved."));
        setTimeout(hide, 2500);
      }),
      button("Not now", () => { ask({ type: "inline-dismiss" }); hide(); }),
    );
    box.append(row);
    place(null);
    host.style.position = "fixed";
    host.style.top = "16px";
    host.style.left = "auto";
    host.style.right = "16px";
  }
  prompt();
})();
